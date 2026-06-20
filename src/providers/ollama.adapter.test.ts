/**
 * Unit tests for {@link OllamaAdapter}.
 *
 * Fully offline: the global `fetch` is stubbed with the `src/test/fake-stream`
 * helpers, so no network is touched and every assertion is deterministic. We
 * exercise the NDJSON streaming path, the `complete()` buffering, HTTP error
 * mapping (401 -> auth, 429 -> rate_limit), the exact request shape
 * (url / method / headers / body), and the `/api/tags` discovery + probe.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { OllamaAdapter } from './ollama.adapter'
import { AIProviderError, ChatRequest } from './types'
import {
    FetchMock,
    installFetch,
    mockFetchOnce,
} from '../test/fake-stream'

const BASE = 'http://localhost:11434'

/** A realistic streamed `/api/chat` body, split across NDJSON lines. The final
 * object carries `done: true` (and, as Ollama really does, an empty content). */
const CHAT_NDJSON_CHUNKS: string[] = [
    JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: 'Hello' }, done: false }) + '\n',
    JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: ', ' }, done: false }) + '\n',
    JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: 'world' }, done: false }) + '\n',
    JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: '!' }, done: false }) + '\n',
    JSON.stringify({ model: 'llama3.1', message: { role: 'assistant', content: '' }, done: true }) + '\n',
]

function baseReq (overrides: Partial<ChatRequest> = {}): ChatRequest {
    return {
        messages: [{ role: 'user', content: 'ping' }],
        model: '',
        ...overrides,
    }
}

/** Install a fetch mock and ensure it is torn down after the test. */
let restore: (() => void) | undefined
afterEach(() => {
    restore?.()
    restore = undefined
})

function use (mock: FetchMock): FetchMock {
    restore = installFetch(mock)
    return mock
}

describe('OllamaAdapter.stream', () => {
    it('yields the concatenated text from a realistic streamed body', async () => {
        use(mockFetchOnce({ streamChunks: CHAT_NDJSON_CHUNKS }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const deltas: string[] = []
        for await (const d of adapter.stream(baseReq())) {
            deltas.push(d)
        }

        // Empty deltas (the final done:true frame) are skipped.
        expect(deltas).toEqual(['Hello', ', ', 'world', '!'])
        expect(deltas.join('')).toBe('Hello, world!')
    })

    it('stops at done:true even if more lines follow', async () => {
        const chunks = [
            JSON.stringify({ message: { content: 'A' }, done: false }) + '\n',
            JSON.stringify({ message: { content: 'B' }, done: true }) + '\n',
            // This trailing line must never be parsed/yielded.
            JSON.stringify({ message: { content: 'C' }, done: false }) + '\n',
        ]
        use(mockFetchOnce({ streamChunks: chunks }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const deltas: string[] = []
        for await (const d of adapter.stream(baseReq())) {
            deltas.push(d)
        }
        expect(deltas).toEqual(['A', 'B'])
    })

    it('reassembles deltas split across chunk boundaries', async () => {
        // One JSON object split mid-way across two transport chunks.
        const line = JSON.stringify({ message: { content: 'spanned' }, done: false }) + '\n'
        const doneLine = JSON.stringify({ message: { content: '' }, done: true }) + '\n'
        const mid = Math.floor(line.length / 2)
        use(mockFetchOnce({ streamChunks: [line.slice(0, mid), line.slice(mid) + doneLine] }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const deltas: string[] = []
        for await (const d of adapter.stream(baseReq())) {
            deltas.push(d)
        }
        expect(deltas).toEqual(['spanned'])
    })

    it('throws network error when body is missing on an ok response', async () => {
        use(mockFetchOnce({ status: 200, text: '' })) // text:'' -> body === null
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        await expect(async () => {
            for await (const _ of adapter.stream(baseReq())) {
                void _
            }
        }).rejects.toMatchObject({ provider: 'ollama', kind: 'network' })
    })
})

describe('OllamaAdapter.complete', () => {
    it('returns the full concatenated text', async () => {
        use(mockFetchOnce({ streamChunks: CHAT_NDJSON_CHUNKS }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const out = await adapter.complete(baseReq())
        expect(out).toBe('Hello, world!')
    })
})

describe('OllamaAdapter error mapping', () => {
    it('maps a 401 to AIProviderError kind "auth"', async () => {
        use(mockFetchOnce({ status: 401, text: JSON.stringify({ error: 'unauthorized' }) }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const err = await drainError(adapter.stream(baseReq()))
        expect(err).toBeInstanceOf(AIProviderError)
        expect(err.provider).toBe('ollama')
        expect(err.kind).toBe('auth')
        expect(err.status).toBe(401)
    })

    it('maps a 429 to AIProviderError kind "rate_limit"', async () => {
        use(mockFetchOnce({ status: 429, text: JSON.stringify({ error: 'slow down' }) }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const err = await drainError(adapter.stream(baseReq()))
        expect(err).toBeInstanceOf(AIProviderError)
        expect(err.kind).toBe('rate_limit')
        expect(err.status).toBe(429)
    })

    it('maps a 500 to AIProviderError kind "server"', async () => {
        use(mockFetchOnce({ status: 500, text: 'boom' }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const err = await drainError(adapter.stream(baseReq()))
        expect(err.kind).toBe('server')
    })
})

describe('OllamaAdapter request shape', () => {
    it('builds the correct url, method, headers and body', async () => {
        // Trailing slash on base must be normalised away.
        const mock = use(mockFetchOnce({ streamChunks: CHAT_NDJSON_CHUNKS }))
        const adapter = new OllamaAdapter('http://localhost:11434///', 'llama3.1')

        const signal = new AbortController().signal
        const req: ChatRequest = {
            system: 'You are terse.',
            messages: [
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hey' },
                { role: 'user', content: 'bye' },
            ],
            model: 'qwen2.5',
            signal,
        }

        for await (const _ of adapter.stream(req)) {
            void _
        }

        expect(mock.calls).toHaveLength(1)
        const { input, init } = mock.calls[0]
        expect(input).toBe('http://localhost:11434/api/chat')
        expect(init.method).toBe('POST')
        expect(init.headers).toEqual({ 'content-type': 'application/json' })
        // Signal must be forwarded for cancellation support.
        expect(init.signal).toBe(signal)

        const body = JSON.parse(init.body)
        expect(body.model).toBe('qwen2.5') // req.model overrides constructor default
        expect(body.stream).toBe(true)
        // System prompt is prepended inline as a system turn.
        expect(body.messages).toEqual([
            { role: 'system', content: 'You are terse.' },
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hey' },
            { role: 'user', content: 'bye' },
        ])
    })

    it('omits the system turn when req.system is absent and falls back to default model', async () => {
        const mock = use(mockFetchOnce({ streamChunks: CHAT_NDJSON_CHUNKS }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        for await (const _ of adapter.stream(baseReq())) {
            void _
        }

        const body = JSON.parse(mock.calls[0].init.body)
        expect(body.model).toBe('llama3.1') // constructor default used when req.model empty
        expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
    })

    it('falls back to the first suggested model when both req.model and default are empty', async () => {
        const mock = use(mockFetchOnce({ streamChunks: CHAT_NDJSON_CHUNKS }))
        const adapter = new OllamaAdapter(BASE, '')

        for await (const _ of adapter.stream(baseReq())) {
            void _
        }

        const body = JSON.parse(mock.calls[0].init.body)
        expect(body.model).toBe('llama3.1') // SUGGESTED_MODELS.ollama[0]
    })
})

describe('OllamaAdapter.listModels', () => {
    it('GETs /api/tags and returns the model names', async () => {
        const mock = use(mockFetchOnce({
            json: { models: [{ name: 'llama3.1' }, { name: 'qwen2.5' }, { notName: 'skip' }] },
        }))
        const adapter = new OllamaAdapter('http://localhost:11434/', 'llama3.1')

        const models = await adapter.listModels()
        expect(models).toEqual(['llama3.1', 'qwen2.5'])

        const { input, init } = mock.calls[0]
        expect(input).toBe('http://localhost:11434/api/tags')
        expect(init.method).toBe('GET')
    })

    it('returns [] when the response has no models array', async () => {
        use(mockFetchOnce({ json: {} }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')
        expect(await adapter.listModels()).toEqual([])
    })

    it('throws a mapped AIProviderError on a non-ok response', async () => {
        use(mockFetchOnce({ status: 404, text: 'not found' }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')
        await expect(adapter.listModels()).rejects.toMatchObject({
            provider: 'ollama',
            kind: 'not_found',
            status: 404,
        })
    })
})

describe('OllamaAdapter.testConnection', () => {
    it('returns {ok:true} when /api/tags resolves (cheap GET probe)', async () => {
        const mock = use(mockFetchOnce({ json: { models: [{ name: 'llama3.1' }] } }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const result = await adapter.testConnection()
        expect(result).toEqual({ ok: true })
        // Probe must use GET /api/tags, never open a chat stream.
        expect(mock.calls[0].input).toBe('http://localhost:11434/api/tags')
        expect(mock.calls[0].init.method).toBe('GET')
    })

    it('returns {ok:false,error} on a non-ok probe without throwing', async () => {
        use(mockFetchOnce({ status: 500, text: 'down' }))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const result = await adapter.testConnection()
        expect(result.ok).toBe(false)
        expect(result.error).toContain('ollama')
        expect(result.error).toContain('500')
    })

    it('returns {ok:false,error} when fetch itself rejects (network down)', async () => {
        restore = installFetch(Object.assign(
            (() => Promise.reject(new Error('ECONNREFUSED'))) as any,
            { calls: [] },
        ))
        const adapter = new OllamaAdapter(BASE, 'llama3.1')

        const result = await adapter.testConnection()
        expect(result.ok).toBe(false)
        expect(result.error).toBe('ECONNREFUSED')
    })
})

/** Drive an async iterable to completion and return the error it throws. */
async function drainError (it: AsyncIterable<string>): Promise<AIProviderError> {
    try {
        for await (const _ of it) {
            void _
        }
    } catch (e) {
        return e as AIProviderError
    }
    throw new Error('expected the stream to throw, but it completed')
}
