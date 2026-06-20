/**
 * Unit tests for {@link GeminiAdapter}.
 *
 * All network is stubbed via the dependency-free helpers in
 * `../test/fake-stream` (no vitest mocking of `fetch`, no real sockets). Each
 * test installs a recording `fetch` mock, runs the adapter, then restores the
 * previous global in a `finally` so tests stay isolated and deterministic.
 */

import { describe, it, expect } from 'vitest'

import { GeminiAdapter } from './gemini.adapter'
import { AIProviderError } from './types'
import {
    installFetch,
    mockFetchOnce,
    type FetchMock,
} from '../test/fake-stream'

const API_KEY = 'test-key-123'
const MODEL = 'gemini-2.0-flash'

/** Build one Gemini SSE `data:` line for a single text part. */
function sseTextEvent (text: string): string {
    const payload = {
        candidates: [{ content: { role: 'model', parts: [{ text }] } }],
    }
    return `data: ${JSON.stringify(payload)}\n\n`
}

/** Run `fn` with `mock` installed as the global `fetch`, always restoring. */
async function withFetch<T> (mock: FetchMock, fn: () => Promise<T>): Promise<T> {
    const restore = installFetch(mock)
    try {
        return await fn()
    } finally {
        restore()
    }
}

/** Drain an async iterable of string deltas into an array. */
async function collect (it: AsyncIterable<string>): Promise<string[]> {
    const out: string[] = []
    for await (const d of it) {
        out.push(d)
    }
    return out
}

describe('GeminiAdapter.stream', () => {
    it('yields concatenated text deltas from a realistic streamed body', async () => {
        // Split a multi-event SSE body across chunk boundaries (even mid-event)
        // to exercise the parser's reassembly.
        const full =
            sseTextEvent('Hello') +
            sseTextEvent(', ') +
            sseTextEvent('world') +
            sseTextEvent('!')
        const mid = Math.floor(full.length / 2)
        const mock = mockFetchOnce({
            streamChunks: [full.slice(0, mid), full.slice(mid)],
        })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        const deltas = await withFetch(mock, () =>
            collect(adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })),
        )

        expect(deltas).toEqual(['Hello', ', ', 'world', '!'])
        expect(deltas.join('')).toBe('Hello, world!')
    })

    it('skips unparseable data lines without crashing the stream', async () => {
        const body =
            sseTextEvent('ok ') +
            'data: {not json\n\n' +
            sseTextEvent('still here')
        const mock = mockFetchOnce({ streamChunks: [body] })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        const deltas = await withFetch(mock, () =>
            collect(adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })),
        )

        expect(deltas).toEqual(['ok ', 'still here'])
    })

    it('emits every text part when a candidate carries multiple parts', async () => {
        const payload = {
            candidates: [{ content: { parts: [{ text: 'a' }, { text: 'b' }] } }],
        }
        const mock = mockFetchOnce({
            streamChunks: [`data: ${JSON.stringify(payload)}\n\n`],
        })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        const deltas = await withFetch(mock, () =>
            collect(adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })),
        )

        expect(deltas).toEqual(['a', 'b'])
    })
})

describe('GeminiAdapter.complete', () => {
    it('returns the full concatenated text', async () => {
        const mock = mockFetchOnce({
            streamChunks: [sseTextEvent('foo') + sseTextEvent('bar')],
        })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        const text = await withFetch(mock, () =>
            adapter.complete({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }),
        )

        expect(text).toBe('foobar')
    })
})

describe('GeminiAdapter request shape', () => {
    it('builds the correct URL, headers and body', async () => {
        const mock = mockFetchOnce({ streamChunks: [sseTextEvent('x')] })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        await withFetch(mock, () =>
            collect(
                adapter.stream({
                    model: MODEL,
                    system: 'be terse',
                    messages: [
                        { role: 'user', content: 'hi' },
                        { role: 'assistant', content: 'hello' },
                        { role: 'user', content: 'again' },
                    ],
                }),
            ),
        )

        expect(mock.calls).toHaveLength(1)
        const { input, init } = mock.calls[0]

        // URL: streamGenerateContent with alt=sse and the URL-encoded key in the
        // query string (NOT a header), model path-segment encoded.
        expect(input).toBe(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(MODEL)}` +
            `:streamGenerateContent?alt=sse&key=${encodeURIComponent(API_KEY)}`,
        )

        // Method + signal forwarding + headers (key is NOT in headers).
        expect(init.method).toBe('POST')
        expect(init.headers).toEqual({ 'content-type': 'application/json' })
        expect('signal' in init).toBe(true)

        // Body: systemInstruction present, assistant => 'model', no 'system' role,
        // each turn is a single-text part.
        const parsed = JSON.parse(init.body)
        expect(parsed).toEqual({
            systemInstruction: { parts: [{ text: 'be terse' }] },
            contents: [
                { role: 'user', parts: [{ text: 'hi' }] },
                { role: 'model', parts: [{ text: 'hello' }] },
                { role: 'user', parts: [{ text: 'again' }] },
            ],
        })
    })

    it('omits systemInstruction when no system prompt is given', async () => {
        const mock = mockFetchOnce({ streamChunks: [sseTextEvent('x')] })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        await withFetch(mock, () =>
            collect(adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] })),
        )

        const parsed = JSON.parse(mock.calls[0].init.body)
        expect('systemInstruction' in parsed).toBe(false)
        expect(parsed.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
    })

    it('drops any stray system turn from messages (no system role in contents)', async () => {
        const mock = mockFetchOnce({ streamChunks: [sseTextEvent('x')] })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        await withFetch(mock, () =>
            collect(
                adapter.stream({
                    model: MODEL,
                    messages: [
                        { role: 'system', content: 'ignored' },
                        { role: 'user', content: 'hi' },
                    ],
                }),
            ),
        )

        const parsed = JSON.parse(mock.calls[0].init.body)
        expect(parsed.contents).toEqual([{ role: 'user', parts: [{ text: 'hi' }] }])
    })

    it('falls back to the constructor model then the suggested model', async () => {
        const mock = mockFetchOnce({ streamChunks: [sseTextEvent('x')] })

        // Empty constructor model + empty req.model => SUGGESTED_MODELS.gemini[0].
        const adapter = new GeminiAdapter(API_KEY, '')
        await withFetch(mock, () =>
            collect(adapter.stream({ model: '', messages: [{ role: 'user', content: 'hi' }] })),
        )

        expect(mock.calls[0].input).toContain(
            `/models/${encodeURIComponent('gemini-2.0-flash')}:streamGenerateContent`,
        )
    })
})

describe('GeminiAdapter error mapping', () => {
    it('maps a 401 to AIProviderError kind "auth"', async () => {
        const mock = mockFetchOnce({
            status: 401,
            json: { error: { message: 'API key not valid' } },
        })

        const adapter = new GeminiAdapter('bad-key', MODEL)
        let caught: unknown
        await withFetch(mock, async () => {
            try {
                await collect(adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }))
            } catch (e) {
                caught = e
            }
        })

        expect(caught).toBeInstanceOf(AIProviderError)
        const err = caught as AIProviderError
        expect(err.kind).toBe('auth')
        expect(err.provider).toBe('gemini')
        expect(err.status).toBe(401)
        expect(err.message).toContain('API key not valid')
    })

    it('maps a 429 to AIProviderError kind "rate_limit"', async () => {
        const mock = mockFetchOnce({
            status: 429,
            json: { error: { message: 'Resource exhausted' } },
        })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        let caught: unknown
        await withFetch(mock, async () => {
            try {
                await collect(adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }))
            } catch (e) {
                caught = e
            }
        })

        expect(caught).toBeInstanceOf(AIProviderError)
        const err = caught as AIProviderError
        expect(err.kind).toBe('rate_limit')
        expect(err.status).toBe(429)
    })

    it('throws a network AIProviderError on a missing response body', async () => {
        // ok response but body === null (no chunks, no text).
        const mock = mockFetchOnce({ status: 200 })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        let caught: unknown
        await withFetch(mock, async () => {
            try {
                await collect(adapter.stream({ model: MODEL, messages: [{ role: 'user', content: 'hi' }] }))
            } catch (e) {
                caught = e
            }
        })

        expect(caught).toBeInstanceOf(AIProviderError)
        expect((caught as AIProviderError).kind).toBe('network')
    })
})

describe('GeminiAdapter.testConnection', () => {
    it('returns { ok: true } when the probe stream yields', async () => {
        const mock = mockFetchOnce({ streamChunks: [sseTextEvent('pong')] })

        const adapter = new GeminiAdapter(API_KEY, MODEL)
        const result = await withFetch(mock, () => adapter.testConnection())

        expect(result).toEqual({ ok: true })
    })

    it('returns { ok: false, error } and does not throw on auth failure', async () => {
        const mock = mockFetchOnce({
            status: 401,
            json: { error: { message: 'API key not valid' } },
        })

        const adapter = new GeminiAdapter('bad-key', MODEL)
        const result = await withFetch(mock, () => adapter.testConnection())

        expect(result.ok).toBe(false)
        expect(result.error).toContain('API key not valid')
    })
})
