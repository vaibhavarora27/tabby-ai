/**
 * Unit tests for {@link AnthropicAdapter}.
 *
 * Every test stubs the global `fetch` via the {@link src/test/fake-stream}
 * helpers — nothing hits the network and all bodies are deterministic. We
 * assert: stream() concatenation from a realistic SSE body, complete() returning
 * the full text, 401 → `auth`, 429 → `rate_limit`, and that the request URL /
 * method / headers / body are shaped per the Anthropic contract.
 */

import { afterEach, describe, expect, it } from 'vitest'

import { AnthropicAdapter } from './anthropic.adapter'
import { AIProviderError } from './types'
import {
    FetchMock,
    installFetch,
    mockFetchOnce,
} from '../test/fake-stream'

const API_KEY = 'sk-ant-test-key'
const DEFAULT_MODEL = 'claude-haiku-4-5'

/**
 * A realistic Anthropic Messages SSE stream: message_start, a content block
 * with three text_delta deltas (one non-text delta and a ping interleaved to
 * exercise the skip paths), then content_block_stop and message_stop. Split
 * across chunks — including mid-event — to exercise the parser's reassembly.
 */
const STREAM_CHUNKS: string[] = [
    'event: message_start\n',
    'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n',
    'event: content_block_start\n',
    'data: {"type":"content_block_start","index":0}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n',
    ': ping\n\n',
    'event: content_block_delta\n',
    // Split this event across two chunks mid-JSON to test boundary handling.
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_de',
    'lta","text":", world"}}\n\n',
    'event: content_block_delta\n',
    // A non-text delta (e.g. input_json_delta) must be ignored.
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    'event: content_block_delta\n',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"!"}}\n\n',
    'event: content_block_stop\n',
    'data: {"type":"content_block_stop","index":0}\n\n',
    'event: message_stop\n',
    'data: {"type":"message_stop"}\n\n',
]

const EXPECTED_TEXT = 'Hello, world!'

let restore: (() => void) | undefined

afterEach(() => {
    restore?.()
    restore = undefined
})

function install (mock: FetchMock): FetchMock {
    restore = installFetch(mock)
    return mock
}

describe('AnthropicAdapter.stream', () => {
    it('yields the concatenated text from a realistic streamed body', async () => {
        install(mockFetchOnce({ streamChunks: STREAM_CHUNKS }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        const deltas: string[] = []
        for await (const d of adapter.stream({
            messages: [{ role: 'user', content: 'hi' }],
            model: DEFAULT_MODEL,
        })) {
            deltas.push(d)
        }

        // Only the three text_delta payloads, in order — no empty/undefined.
        expect(deltas).toEqual(['Hello', ', world', '!'])
        expect(deltas.join('')).toBe(EXPECTED_TEXT)
    })

    it('stops at message_stop and ignores trailing events', async () => {
        install(mockFetchOnce({
            streamChunks: [
                'event: content_block_delta\n',
                'data: {"delta":{"type":"text_delta","text":"A"}}\n\n',
                'event: message_stop\n',
                'data: {"type":"message_stop"}\n\n',
                // Anything after message_stop must NOT be yielded.
                'event: content_block_delta\n',
                'data: {"delta":{"type":"text_delta","text":"B"}}\n\n',
            ],
        }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        const deltas: string[] = []
        for await (const d of adapter.stream({
            messages: [{ role: 'user', content: 'hi' }],
            model: DEFAULT_MODEL,
        })) {
            deltas.push(d)
        }

        expect(deltas).toEqual(['A'])
    })

    it('throws a server AIProviderError on an error event', async () => {
        install(mockFetchOnce({
            streamChunks: [
                'event: error\n',
                'data: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
            ],
        }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        await expect(async () => {
            for await (const _d of adapter.stream({
                messages: [{ role: 'user', content: 'hi' }],
                model: DEFAULT_MODEL,
            })) {
                void _d
            }
        }).rejects.toMatchObject({
            provider: 'anthropic',
            kind: 'server',
            message: 'Overloaded',
        })
    })

    it('skips unparseable data lines without crashing', async () => {
        install(mockFetchOnce({
            streamChunks: [
                'event: content_block_delta\n',
                'data: {not valid json\n\n',
                'event: content_block_delta\n',
                'data: {"delta":{"type":"text_delta","text":"ok"}}\n\n',
                'event: message_stop\n',
                'data: {}\n\n',
            ],
        }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        const deltas: string[] = []
        for await (const d of adapter.stream({
            messages: [{ role: 'user', content: 'hi' }],
            model: DEFAULT_MODEL,
        })) {
            deltas.push(d)
        }

        expect(deltas).toEqual(['ok'])
    })

    it('throws a network AIProviderError when the response has no body', async () => {
        install(mockFetchOnce({ status: 200, text: '' }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        await expect(async () => {
            for await (const _d of adapter.stream({
                messages: [{ role: 'user', content: 'hi' }],
                model: DEFAULT_MODEL,
            })) {
                void _d
            }
        }).rejects.toMatchObject({ provider: 'anthropic', kind: 'network' })
    })
})

describe('AnthropicAdapter.complete', () => {
    it('returns the full concatenated text', async () => {
        install(mockFetchOnce({ streamChunks: STREAM_CHUNKS }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        const text = await adapter.complete({
            messages: [{ role: 'user', content: 'hi' }],
            model: DEFAULT_MODEL,
        })

        expect(text).toBe(EXPECTED_TEXT)
    })
})

describe('AnthropicAdapter error mapping', () => {
    it('maps a 401 to AIProviderError kind "auth"', async () => {
        install(mockFetchOnce({
            status: 401,
            json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } },
        }))
        const adapter = new AnthropicAdapter('bad-key', DEFAULT_MODEL)

        const err = await collectError(adapter)
        expect(err).toBeInstanceOf(AIProviderError)
        expect(err.kind).toBe('auth')
        expect(err.status).toBe(401)
        expect(err.provider).toBe('anthropic')
        expect(err.message).toContain('invalid x-api-key')
    })

    it('maps a 429 to AIProviderError kind "rate_limit"', async () => {
        install(mockFetchOnce({
            status: 429,
            json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } },
        }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        const err = await collectError(adapter)
        expect(err).toBeInstanceOf(AIProviderError)
        expect(err.kind).toBe('rate_limit')
        expect(err.status).toBe(429)
    })
})

describe('AnthropicAdapter request shaping', () => {
    it('sends the correct URL, method, headers and body', async () => {
        const mock = install(mockFetchOnce({ streamChunks: STREAM_CHUNKS }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        await adapter.complete({
            system: 'You are terse.',
            messages: [
                { role: 'system', content: 'ignored — system turns are filtered' },
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
                { role: 'user', content: 'Q2' },
            ],
            model: 'claude-opus-4-8',
            maxTokens: 256,
        })

        expect(mock.calls).toHaveLength(1)
        const { input, init } = mock.calls[0]

        expect(input).toBe('https://api.anthropic.com/v1/messages')
        expect(init.method).toBe('POST')
        expect(init.headers).toEqual({
            'x-api-key': API_KEY,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
            'anthropic-dangerous-direct-browser-access': 'true',
        })

        const body = JSON.parse(init.body)
        expect(body).toEqual({
            model: 'claude-opus-4-8',
            max_tokens: 256,
            system: 'You are terse.',
            stream: true,
            messages: [
                { role: 'user', content: 'Q1' },
                { role: 'assistant', content: 'A1' },
                { role: 'user', content: 'Q2' },
            ],
        })
        // temperature / top_p / top_k / thinking must NOT be present.
        expect(body.temperature).toBeUndefined()
        expect(body.top_p).toBeUndefined()
        expect(body.top_k).toBeUndefined()
        expect(body.thinking).toBeUndefined()
    })

    it('omits the system key entirely when req.system is falsy', async () => {
        const mock = install(mockFetchOnce({ streamChunks: STREAM_CHUNKS }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        await adapter.complete({
            messages: [{ role: 'user', content: 'hi' }],
            model: DEFAULT_MODEL,
        })

        const body = JSON.parse(mock.calls[0].init.body)
        expect('system' in body).toBe(false)
    })

    it('forwards req.signal into fetch and falls back to the default model', async () => {
        const mock = install(mockFetchOnce({ streamChunks: STREAM_CHUNKS }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)
        const controller = new AbortController()

        await adapter.complete({
            messages: [{ role: 'user', content: 'hi' }],
            model: '', // empty → falls back to constructor default model
            signal: controller.signal,
        })

        const { init } = mock.calls[0]
        expect(init.signal).toBe(controller.signal)
        expect(JSON.parse(init.body).model).toBe(DEFAULT_MODEL)
    })
})

describe('AnthropicAdapter.testConnection', () => {
    it('returns { ok: true } when a probe delta arrives', async () => {
        install(mockFetchOnce({
            streamChunks: [
                'event: content_block_delta\n',
                'data: {"delta":{"type":"text_delta","text":"pong"}}\n\n',
                'event: message_stop\n',
                'data: {}\n\n',
            ],
        }))
        const adapter = new AnthropicAdapter(API_KEY, DEFAULT_MODEL)

        await expect(adapter.testConnection()).resolves.toEqual({ ok: true })
    })

    it('reports an auth failure as { ok: false, error } without throwing', async () => {
        install(mockFetchOnce({
            status: 401,
            json: { type: 'error', error: { message: 'invalid x-api-key' } },
        }))
        const adapter = new AnthropicAdapter('bad-key', DEFAULT_MODEL)

        const result = await adapter.testConnection()
        expect(result.ok).toBe(false)
        expect(result.error).toContain('invalid x-api-key')
    })
})

/** Drain a stream that is expected to throw, returning the thrown error. */
async function collectError (adapter: AnthropicAdapter): Promise<AIProviderError> {
    try {
        for await (const _d of adapter.stream({
            messages: [{ role: 'user', content: 'hi' }],
            model: DEFAULT_MODEL,
        })) {
            void _d
        }
    } catch (err) {
        return err as AIProviderError
    }
    throw new Error('expected stream() to throw')
}
