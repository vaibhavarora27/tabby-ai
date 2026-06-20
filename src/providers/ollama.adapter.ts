/**
 * Ollama provider adapter (local, no auth).
 *
 * Talks to a user-configured Ollama server (default `http://localhost:11434`)
 * via the RAW global `fetch` — no vendor SDK. The chat endpoint streams
 * newline-delimited JSON (NDJSON, *not* SSE), so this adapter parses
 * `res.body` with {@link parseNDJSON}. It is the one adapter with a discovery
 * endpoint (`GET /api/tags`), so it implements {@link AIProvider.listModels}
 * and uses that cheap GET as its connection probe.
 *
 * Wire facts (2026):
 *  - Chat:   POST <base>/api/chat  { model, messages, stream: true }
 *            header `content-type: application/json` only (no auth).
 *            Each NDJSON line: { message: { content }, done: boolean }.
 *            Text deltas live at `message.content`; stop at `done === true`.
 *  - Models: GET  <base>/api/tags  -> { models: [{ name, ... }] }.
 */

import { AIProvider, ChatRequest, AIProviderError } from './types'
import { parseNDJSON } from './sse'
import { SUGGESTED_MODELS } from './config'

const PROVIDER = 'ollama'

/** Adapter for a local/remote Ollama server. */
export class OllamaAdapter implements AIProvider {
    /**
     * @param baseUrl Base URL of the Ollama server (e.g. "http://localhost:11434").
     *                Trailing slashes are stripped before building endpoints.
     * @param model   Default model id used when a request omits one.
     */
    constructor (private baseUrl: string, private model: string) {}

    /** Strip trailing slashes so `<base>/api/...` never doubles up. */
    private base (): string {
        return this.baseUrl.replace(/\/+$/, '')
    }

    /** Effective model: request override -> constructor default -> first suggested. */
    private effectiveModel (req: ChatRequest): string {
        return req.model || this.model || SUGGESTED_MODELS[PROVIDER][0]
    }

    /**
     * Buffer the full streamed response and resolve the concatenated text.
     * Implemented purely by draining {@link OllamaAdapter.stream}.
     */
    async complete (req: ChatRequest): Promise<string> {
        let out = ''
        for await (const d of this.stream(req)) {
            out += d
        }
        return out
    }

    /**
     * Stream incremental text deltas from `POST <base>/api/chat`.
     *
     * Forwards `req.signal` to `fetch` so an abort cancels the in-flight
     * request; an `AbortError` is allowed to propagate (never swallowed).
     */
    async *stream (req: ChatRequest): AsyncGenerator<string, void, unknown> {
        const base = this.base()
        const model = this.effectiveModel(req)

        const messages = [
            ...(req.system ? [{ role: 'system', content: req.system }] : []),
            ...req.messages.map(m => ({ role: m.role, content: m.content })),
        ]
        const payload = { model, messages, stream: true }

        const res = await fetch(`${base}/api/chat`, {
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

        for await (const obj of parseNDJSON(res.body)) {
            const text = obj?.message?.content
            if (typeof text === 'string' && text) {
                yield text
            }
            if (obj?.done === true) {
                return
            }
        }
    }

    /**
     * Enumerate model ids from `GET <base>/api/tags`.
     *
     * @returns the `name` of every entry under `models` (filtered to strings).
     */
    async listModels (): Promise<string[]> {
        const base = this.base()
        const res = await fetch(`${base}/api/tags`, { method: 'GET' })
        if (!res.ok) {
            const body = await res.text().catch(() => '')
            throw AIProviderError.fromResponse(PROVIDER, res.status, body)
        }
        const j = await res.json()
        return Array.isArray(j?.models)
            ? j.models
                .map((m: any) => m?.name)
                .filter((n: any): n is string => typeof n === 'string')
            : []
    }

    /**
     * Cheap liveness probe: hit `GET /api/tags` via {@link listModels}.
     * Never throws — failures are reported as `{ ok: false, error }`.
     */
    async testConnection (): Promise<{ ok: boolean; error?: string }> {
        try {
            await this.listModels()
            return { ok: true }
        } catch (err) {
            if (err instanceof AIProviderError) {
                return { ok: false, error: err.message }
            }
            return { ok: false, error: String((err as { message?: unknown })?.message ?? err) }
        }
    }
}
