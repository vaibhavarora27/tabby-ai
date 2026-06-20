/**
 * Unit tests for {@link OpenAIAdapter}.
 *
 * Fully offline: the global `fetch` is stubbed via the
 * `src/test/fake-stream.ts` helpers, so no network is touched and behaviour is
 * deterministic. Covers the happy-path stream/complete concatenation, the
 * 401 -> `auth` and 429 -> `rate_limit` error mappings, and the exact shape of
 * the request URL / method / headers / body.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { OpenAIAdapter } from './openai.adapter'
import { AIProviderError } from './types'
import type { ChatRequest } from './types'
import {
    installFetch,
    mockFetchOnce,
    type FetchMock,
} from '../test/fake-stream'

/** A realistic OpenAI SSE body, deliberately split across chunks (including a
 * mid-event boundary) to exercise the parser's reassembly. The deltas
 * concatenate to "Hello world!". */
const OPENAI_SSE_CHUNKS: string[] = [
    'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    // Split a single event across two chunks to test boundary handling.
    'data: {"choices":[{"delta":{"con',
    'tent":" world"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"!"}}]}\n\n',
    // A chunk with no content delta (e.g. finish_reason) must be ignored.
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n',
]

const SAMPLE_REQUEST: ChatRequest = {
    model: 'gpt-4o-mini',
    system: 'You are terse.',
    messages: [
        { role: 'user', content: 'Hi' },
        { role: 'assistant', content: 'Yo' },
        { role: 'user', content: 'Say hello' },
    ],
}

let restore: (() => void) | undefined

afterEach(() => {
    restore?.()
    restore = undefined
})

/** Install a fetch mock as the global and remember its restore fn. */
function install (mock: FetchMock): FetchMock {
    restore = installFetch(mock)
    return mock
}

describe('OpenAIAdapter.stream', () => {
    it('yields the concatenated text deltas from a streamed body', async () => {
        install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o-mini')

        const deltas: string[] = []
        for await (const d of adapter.stream(SAMPLE_REQUEST)) {
            deltas.push(d)
        }

        // Empty-string deltas are skipped; only real text is yielded.
        expect(deltas).toEqual(['Hello', ' world', '!'])
        expect(deltas.join('')).toBe('Hello world!')
    })

    it('sends a correctly shaped POST (url, method, headers, body)', async () => {
        const fetchMock = install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        const adapter = new OpenAIAdapter('sk-secret', 'gpt-4o-mini')

        // Drain so the request is actually issued.
        for await (const _d of adapter.stream(SAMPLE_REQUEST)) {
            // consume
        }

        expect(fetchMock.calls).toHaveLength(1)
        const { input, init } = fetchMock.calls[0]

        expect(input).toBe('https://api.openai.com/v1/chat/completions')
        expect(init.method).toBe('POST')
        expect(init.headers).toEqual({
            'Authorization': 'Bearer sk-secret',
            'content-type': 'application/json',
        })

        const body = JSON.parse(init.body)
        expect(body).toEqual({
            model: 'gpt-4o-mini',
            stream: true,
            messages: [
                { role: 'system', content: 'You are terse.' },
                { role: 'user', content: 'Hi' },
                { role: 'assistant', content: 'Yo' },
                { role: 'user', content: 'Say hello' },
            ],
        })
    })

    it('omits the system message when req.system is absent', async () => {
        const fetchMock = install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o-mini')

        const noSystem: ChatRequest = {
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: 'Hi' }],
        }
        for await (const _d of adapter.stream(noSystem)) {
            // consume
        }

        const body = JSON.parse(fetchMock.calls[0].init.body)
        expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }])
    })

    it('falls back to the constructor model then the suggested default', async () => {
        const fetchMock = install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        // Empty constructor model -> SUGGESTED_MODELS.openai[0] === 'gpt-4o-mini'.
        const adapter = new OpenAIAdapter('sk-test', '')

        const reqNoModel: ChatRequest = {
            model: '',
            messages: [{ role: 'user', content: 'Hi' }],
        }
        for await (const _d of adapter.stream(reqNoModel)) {
            // consume
        }

        const body = JSON.parse(fetchMock.calls[0].init.body)
        expect(body.model).toBe('gpt-4o-mini')
    })

    it('forwards req.signal to fetch', async () => {
        const fetchMock = install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o-mini')
        const controller = new AbortController()

        const withSignal: ChatRequest = { ...SAMPLE_REQUEST, signal: controller.signal }
        for await (const _d of adapter.stream(withSignal)) {
            // consume
        }

        expect(fetchMock.calls[0].init.signal).toBe(controller.signal)
    })
})

describe('OpenAIAdapter.complete', () => {
    it('returns the full concatenated text', async () => {
        install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o-mini')

        const text = await adapter.complete(SAMPLE_REQUEST)
        expect(text).toBe('Hello world!')
    })
})

describe('OpenAIAdapter error mapping', () => {
    it('maps a 401 response to AIProviderError kind "auth"', async () => {
        install(mockFetchOnce({
            status: 401,
            text: JSON.stringify({ error: { message: 'Invalid API key' } }),
        }))
        const adapter = new OpenAIAdapter('sk-bad', 'gpt-4o-mini')

        await expect(async () => {
            for await (const _d of adapter.stream(SAMPLE_REQUEST)) {
                // should never yield
            }
        }).rejects.toMatchObject({
            name: 'AIProviderError',
            provider: 'openai',
            kind: 'auth',
            status: 401,
        })
    })

    it('maps a 429 response to AIProviderError kind "rate_limit"', async () => {
        install(mockFetchOnce({
            status: 429,
            text: JSON.stringify({ error: { message: 'Rate limit reached' } }),
        }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o-mini')

        let caught: unknown
        try {
            for await (const _d of adapter.stream(SAMPLE_REQUEST)) {
                // should never yield
            }
        } catch (err) {
            caught = err
        }

        expect(caught).toBeInstanceOf(AIProviderError)
        const e = caught as AIProviderError
        expect(e.kind).toBe('rate_limit')
        expect(e.status).toBe(429)
        expect(e.provider).toBe('openai')
        expect(e.message).toContain('Rate limit reached')
    })

    it('throws a network AIProviderError when the body is missing', async () => {
        // 200 OK but no streaming body (text:'' -> body === null).
        install(mockFetchOnce({ status: 200, text: '' }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o-mini')

        let caught: unknown
        try {
            for await (const _d of adapter.stream(SAMPLE_REQUEST)) {
                // should never yield
            }
        } catch (err) {
            caught = err
        }

        expect(caught).toBeInstanceOf(AIProviderError)
        expect((caught as AIProviderError).kind).toBe('network')
    })
})

describe('OpenAIAdapter.testConnection', () => {
    it('returns { ok: true } when the probe stream succeeds', async () => {
        install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o-mini')

        await expect(adapter.testConnection()).resolves.toEqual({ ok: true })
    })

    it('issues a minimal "ping" probe with the default model', async () => {
        const fetchMock = install(mockFetchOnce({ streamChunks: OPENAI_SSE_CHUNKS }))
        const adapter = new OpenAIAdapter('sk-test', 'gpt-4o')

        await adapter.testConnection()

        const body = JSON.parse(fetchMock.calls[0].init.body)
        expect(body.model).toBe('gpt-4o')
        expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
        expect(body.stream).toBe(true)
    })

    it('returns { ok: false, error } on an auth failure (does not throw)', async () => {
        install(mockFetchOnce({
            status: 401,
            text: JSON.stringify({ error: { message: 'Invalid API key' } }),
        }))
        const adapter = new OpenAIAdapter('sk-bad', 'gpt-4o-mini')

        const result = await adapter.testConnection()
        expect(result.ok).toBe(false)
        expect(result.error).toContain('Invalid API key')
    })
})
