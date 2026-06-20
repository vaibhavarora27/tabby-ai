/**
 * OpenAI chat-completions adapter.
 *
 * Talks to `POST https://api.openai.com/v1/chat/completions` using the RAW
 * global `fetch` (no vendor SDK) and the shared {@link parseSSE} stream parser.
 * The system prompt is carried INLINE as a leading `system` message (OpenAI has
 * no dedicated system field), and roles pass through unchanged.
 *
 * Implements {@link AIProvider}; constructed positionally by the service factory
 * as `new OpenAIAdapter(apiKey, model)`.
 */

import { AIProvider, ChatRequest, AIProviderError } from './types'
import { parseSSE } from './sse'
import { SUGGESTED_MODELS } from './config'

const PROVIDER = 'openai'
const OPENAI_URL = 'https://api.openai.com/v1/chat/completions'

/** A single OpenAI wire chat message (roles pass through from {@link ChatMessage}). */
interface OpenAIWireMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

/** The JSON request body posted to the chat-completions endpoint. */
interface OpenAIChatPayload {
    model: string
    messages: OpenAIWireMessage[]
    stream: true
}

export class OpenAIAdapter implements AIProvider {
    constructor (private apiKey: string, private model: string) {}

    /**
     * Buffer the full streamed response and resolve the concatenated text.
     * Implemented purely by draining {@link OpenAIAdapter.stream}.
     */
    async complete (req: ChatRequest): Promise<string> {
        let out = ''
        for await (const d of this.stream(req)) {
            out += d
        }
        return out
    }

    /**
     * Stream incremental text deltas from the chat-completions endpoint.
     *
     * Forwards `req.signal` to `fetch` so an abort cancels the in-flight
     * request; maps non-ok responses through {@link AIProviderError.fromResponse}
     * and never swallows an `AbortError`.
     */
    async *stream (req: ChatRequest): AsyncGenerator<string, void, unknown> {
        const model = req.model || this.model || SUGGESTED_MODELS[PROVIDER][0]

        const messages: OpenAIWireMessage[] = [
            ...(req.system ? [{ role: 'system' as const, content: req.system }] : []),
            ...req.messages.map(m => ({ role: m.role, content: m.content })),
        ]

        const payload: OpenAIChatPayload = {
            model,
            messages,
            stream: true,
        }

        const res = await fetch(OPENAI_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${this.apiKey}`,
                'content-type': 'application/json',
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
            if (ev.data === '[DONE]') {
                return
            }
            let chunk: unknown
            try {
                chunk = JSON.parse(ev.data)
            } catch {
                // Skip unparseable data lines; do not crash the stream.
                continue
            }
            const delta = (chunk as {
                choices?: Array<{ delta?: { content?: unknown } }>
            }).choices?.[0]?.delta?.content
            if (typeof delta === 'string' && delta) {
                yield delta
            }
        }
    }

    /**
     * Cheap credential/liveness probe for the settings UI.
     *
     * Opens a minimal 1-token-ish stream (`messages:[{role:'user',content:'ping'}]`),
     * consumes at most one delta, then resolves `{ ok: true }`. Never throws:
     * an {@link AIProviderError} (e.g. a 401 -> `auth`) is reported as
     * `{ ok: false, error }`, and any other failure is stringified.
     */
    async testConnection (): Promise<{ ok: boolean; error?: string }> {
        try {
            const model = this.model || SUGGESTED_MODELS[PROVIDER][0]
            const probe: ChatRequest = {
                model,
                maxTokens: 1,
                messages: [{ role: 'user', content: 'ping' }],
            }
            for await (const _delta of this.stream(probe)) {
                // One delta proves credentials + reachability; stop early.
                break
            }
            return { ok: true }
        } catch (err) {
            if (err instanceof AIProviderError) {
                return { ok: false, error: err.message }
            }
            return { ok: false, error: String((err as { message?: unknown })?.message ?? err) }
        }
    }
}
