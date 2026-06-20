/**
 * Anthropic (Claude) provider adapter.
 *
 * Talks to the Messages API (`POST /v1/messages`) using the RAW global `fetch`
 * — no vendor SDK — and the shared SSE parser. The system prompt is carried in
 * the dedicated `system` field (Anthropic does not take a synthetic system
 * turn), and text deltas arrive on `content_block_delta` events. See
 * {@link AnthropicAdapter.stream} for the precise wire handling.
 */

import {
    AIProvider,
    ChatRequest,
    AIProviderError,
} from './types'
import { parseSSE } from './sse'
import { SUGGESTED_MODELS } from './config'

/** Provider name used as the first argument to {@link AIProviderError}. */
const PROVIDER = 'anthropic'

/** Messages API endpoint. */
const ENDPOINT = 'https://api.anthropic.com/v1/messages'

/** One Anthropic content-block delta payload (the subset we read). */
interface AnthropicDelta {
    delta?: {
        type?: string
        text?: string
    }
}

/** One Anthropic stream-error payload (the subset we read). */
interface AnthropicStreamError {
    error?: {
        message?: string
    }
}

export class AnthropicAdapter implements AIProvider {
    constructor (private apiKey: string, private model: string) {}

    /**
     * Buffer the full streamed response. Implemented purely by draining
     * {@link AnthropicAdapter.stream} so there is a single HTTP path.
     */
    async complete (req: ChatRequest): Promise<string> {
        let out = ''
        for await (const delta of this.stream(req)) {
            out += delta
        }
        return out
    }

    /**
     * Stream text deltas from the Messages API.
     *
     * Forwards `req.signal` so an abort cancels the in-flight request. Non-OK
     * responses map through {@link AIProviderError.fromResponse}; an empty body
     * is a `network` error. SSE events are dispatched by type:
     *  - `error` → throw a `server` error carrying the server message,
     *  - `message_stop` → end of stream,
     *  - `content_block_delta` → yield `delta.text` for `text_delta` deltas,
     *  - everything else (message_start, content_block_start/stop, ping) ignored.
     * Unparseable `data` lines are skipped rather than crashing the stream.
     * AbortError is never swallowed — it propagates to the caller.
     */
    async *stream (req: ChatRequest): AsyncGenerator<string, void, unknown> {
        const model = req.model || this.model || SUGGESTED_MODELS[PROVIDER][0]
        const maxTokens = req.maxTokens ?? 1024

        const payload: {
            model: string
            max_tokens: number
            system?: string
            messages: Array<{ role: 'user' | 'assistant'; content: string }>
            stream: true
        } = {
            model,
            max_tokens: maxTokens,
            messages: req.messages
                .filter(m => m.role !== 'system')
                .map(m => ({
                    role: m.role === 'assistant' ? 'assistant' : 'user',
                    content: m.content,
                })),
            stream: true,
        }
        // OMIT the `system` key entirely when req.system is falsy.
        if (req.system) {
            payload.system = req.system
        }

        const res = await fetch(ENDPOINT, {
            method: 'POST',
            headers: {
                'x-api-key': this.apiKey,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json',
                'anthropic-dangerous-direct-browser-access': 'true',
            },
            body: JSON.stringify(payload),
            signal: req.signal,
        })

        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw AIProviderError.fromResponse(PROVIDER, res.status, body)
        }
        if (!res.body) {
            throw new AIProviderError(PROVIDER, 'network', 'empty response body')
        }

        for await (const ev of parseSSE(res.body)) {
            if (ev.event === 'error') {
                let data: AnthropicStreamError | undefined
                try {
                    data = JSON.parse(ev.data) as AnthropicStreamError
                } catch {
                    data = undefined
                }
                throw new AIProviderError(
                    PROVIDER,
                    'server',
                    data?.error?.message ?? 'stream error',
                )
            }
            if (ev.event === 'message_stop') {
                return
            }
            if (ev.event === 'content_block_delta') {
                let d: AnthropicDelta
                try {
                    d = JSON.parse(ev.data) as AnthropicDelta
                } catch {
                    // Skip unparseable data lines; don't crash the stream.
                    continue
                }
                if (
                    d.delta?.type === 'text_delta'
                    && typeof d.delta.text === 'string'
                    && d.delta.text
                ) {
                    yield d.delta.text
                }
            }
            // All other events (message_start, content_block_start/stop, ping,
            // message_delta, …) are intentionally ignored.
        }
    }

    /**
     * Cheap credential/liveness probe for the settings UI. Issues a minimal
     * 1-token stream and consumes a single delta. Never throws: failures are
     * reported as `{ ok: false, error }`, with auth errors surfaced via the
     * typed {@link AIProviderError} message.
     */
    async testConnection (): Promise<{ ok: boolean; error?: string }> {
        try {
            const probe: ChatRequest = {
                messages: [{ role: 'user', content: 'ping' }],
                model: this.model,
                maxTokens: 1,
            }
            for await (const _delta of this.stream(probe)) {
                // One delta is enough to prove the connection is live.
                void _delta
                break
            }
            return { ok: true }
        } catch (err) {
            if (err instanceof AIProviderError) {
                return { ok: false, error: err.message }
            }
            const e = err as { message?: unknown } | undefined
            return {
                ok: false,
                error: String(e?.message ?? err),
            }
        }
    }
}
