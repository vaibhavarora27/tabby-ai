/**
 * Google Gemini adapter.
 *
 * Talks to the Generative Language API's streaming endpoint using the RAW
 * global `fetch` (no vendor SDK) and the shared {@link parseSSE} utility. The
 * API key travels in the query string (`?key=…`), not a header, and the system
 * prompt is carried in a dedicated `systemInstruction` field rather than as a
 * conversation turn. Assistant turns map to Gemini's `model` role; there is no
 * `system` role inside `contents`.
 *
 * Implements {@link AIProvider}; transport failures are normalised through
 * {@link AIProviderError.fromResponse}.
 */

import { AIProvider, ChatRequest, AIProviderError } from './types'
import { parseSSE } from './sse'
import { SUGGESTED_MODELS } from './config'

const PROVIDER = 'gemini'

/** A single Gemini `contents[]` turn on the wire. */
interface GeminiContent {
    role: 'user' | 'model'
    parts: Array<{ text: string }>
}

/** The request payload sent to `:streamGenerateContent`. */
interface GeminiPayload {
    systemInstruction?: { parts: Array<{ text: string }> }
    contents: GeminiContent[]
}

export class GeminiAdapter implements AIProvider {
    constructor (private apiKey: string, private model: string) {}

    /**
     * Buffer the full streamed response and resolve the concatenated text.
     * Single HTTP path: drain {@link GeminiAdapter.stream}.
     */
    async complete (req: ChatRequest): Promise<string> {
        let out = ''
        for await (const d of this.stream(req)) {
            out += d
        }
        return out
    }

    /**
     * Stream incremental text deltas. Forwards `req.signal` to `fetch` so an
     * abort cancels the in-flight request; never swallows `AbortError`.
     */
    async *stream (req: ChatRequest): AsyncGenerator<string, void, unknown> {
        const model = req.model || this.model || SUGGESTED_MODELS[PROVIDER][0]
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(this.apiKey)}`

        const payload: GeminiPayload = {
            ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
            contents: req.messages
                .filter(m => m.role !== 'system')
                .map(m => ({
                    role: m.role === 'assistant' ? 'model' : 'user',
                    parts: [{ text: m.content }],
                })),
        }

        const res = await fetch(url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
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
            // Gemini SSE has no explicit DONE sentinel; the stream just closes.
            let g: unknown
            try {
                g = JSON.parse(ev.data)
            } catch {
                // Skip unparseable data lines rather than crashing the stream.
                continue
            }
            const parts = (g as {
                candidates?: Array<{ content?: { parts?: unknown } }>
            }).candidates?.[0]?.content?.parts
            if (Array.isArray(parts)) {
                for (const p of parts) {
                    const text = (p as { text?: unknown }).text
                    if (typeof text === 'string' && text) {
                        yield text
                    }
                }
            }
        }
    }

    /**
     * Cheap credential/liveness probe: open a minimal 1-turn stream and, on the
     * first delta (or clean close), report success. Never throws — failures are
     * returned as `{ ok: false, error }`. Auth errors surface as such.
     */
    async testConnection (): Promise<{ ok: boolean; error?: string }> {
        try {
            const probe: ChatRequest = {
                model: this.model,
                messages: [{ role: 'user', content: 'ping' }],
                maxTokens: 1,
            }
            for await (const _delta of this.stream(probe)) {
                // One delta is enough to prove the endpoint + key work.
                void _delta
                break
            }
            return { ok: true }
        } catch (err) {
            if (err instanceof AIProviderError) {
                return { ok: false, error: err.message }
            }
            const message = (err as { message?: unknown })?.message
            return { ok: false, error: String(typeof message === 'string' ? message : err) }
        }
    }
}
