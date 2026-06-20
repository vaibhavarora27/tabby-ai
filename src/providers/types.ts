/**
 * Provider-agnostic AI types.
 *
 * This module is intentionally framework-free (no Angular, no Tabby) so it can
 * be imported by both the runtime adapters and unit tests. Every adapter
 * (Anthropic / OpenAI / Gemini / Ollama) implements {@link AIProvider} and maps
 * transport errors through {@link AIProviderError.fromResponse}.
 */

/** A single chat turn. `role` mirrors the OpenAI-style triad; adapters that use
 * a different wire vocabulary (e.g. Gemini's "model") translate internally. */
export interface ChatMessage {
    role: 'system' | 'user' | 'assistant'
    content: string
}

/**
 * A provider-agnostic chat completion request.
 *
 * `system` is kept separate from `messages` because several providers
 * (Anthropic, Gemini) carry the system prompt in a dedicated field rather than
 * as a message. Adapters that *do* want it inline (OpenAI, Ollama) prepend it
 * themselves.
 */
export interface ChatRequest {
    /** Optional system / developer instruction. */
    system?: string
    /** Ordered conversation turns. Should not normally include a `system` turn;
     * put the system prompt in {@link ChatRequest.system} instead. */
    messages: ChatMessage[]
    /** Provider-specific model id (e.g. "claude-haiku-4-5", "gpt-4o-mini"). */
    model: string
    /** Upper bound on generated tokens. Required by Anthropic; optional elsewhere. */
    maxTokens?: number
    /** Cancellation signal; adapters MUST forward this to `fetch`. */
    signal?: AbortSignal
}

/**
 * The uniform surface every provider adapter exposes.
 *
 * Implementations are constructed by the service factory (see
 * `ai-provider.service.ts`) and are otherwise pure: a single adapter instance
 * holds only its credentials / base URL / default model and performs no
 * Angular or Tabby work.
 */
export interface AIProvider {
    /** Buffer the full streamed response and resolve the concatenated text. */
    complete(req: ChatRequest): Promise<string>
    /** Stream incremental text deltas as they arrive. Each yielded string is a
     * fragment to append; callers concatenate. */
    stream(req: ChatRequest): AsyncIterable<string>
    /** Optionally enumerate model ids usable for the settings dropdown. Adapters
     * without a discovery endpoint omit this. */
    listModels?(): Promise<string[]>
    /** Cheap liveness/credential probe for the settings UI. Never throws: a
     * failure is reported as `{ ok: false, error }`. */
    testConnection(): Promise<{ ok: boolean; error?: string }>
}

/** Normalised failure categories shared across every provider. */
export type AIErrorKind =
    | 'auth'
    | 'rate_limit'
    | 'network'
    | 'bad_request'
    | 'not_found'
    | 'server'
    | 'unknown'

/**
 * A typed error carrying the originating provider, a normalised {@link AIErrorKind},
 * and (when it came from an HTTP response) the status code and server body.
 */
export class AIProviderError extends Error {
    readonly provider: string
    readonly kind: AIErrorKind
    readonly status?: number

    constructor (
        provider: string,
        kind: AIErrorKind,
        message: string,
        status?: number,
    ) {
        super(message)
        this.name = 'AIProviderError'
        this.provider = provider
        this.kind = kind
        this.status = status
        // Restore the prototype chain (TS target ES2019 / extending built-in Error).
        Object.setPrototypeOf(this, AIProviderError.prototype)
    }

    /**
     * Map an HTTP status + response body into a typed error.
     *
     * Status mapping: 401/403 -> auth, 429 -> rate_limit, 400 -> bad_request,
     * 404 -> not_found, >=500 -> server, anything else -> unknown.
     *
     * `bodyText` is best-effort: if it parses as JSON with a recognisable
     * `error.message` / `error` / `message` field, that is surfaced; otherwise
     * the raw (truncated) body is used.
     */
    static fromResponse (
        provider: string,
        status: number,
        bodyText: string,
    ): AIProviderError {
        let kind: AIErrorKind
        if (status === 401 || status === 403) {
            kind = 'auth'
        } else if (status === 429) {
            kind = 'rate_limit'
        } else if (status === 400) {
            kind = 'bad_request'
        } else if (status === 404) {
            kind = 'not_found'
        } else if (status >= 500) {
            kind = 'server'
        } else {
            kind = 'unknown'
        }
        const detail = extractErrorMessage(bodyText)
        const message = `${provider} request failed (${status} ${kind})${detail ? `: ${detail}` : ''}`
        return new AIProviderError(provider, kind, message, status)
    }
}

/** Pull a human-readable message out of a provider error body, tolerating
 * non-JSON and the various shapes the four providers use. */
function extractErrorMessage (bodyText: string): string {
    const trimmed = (bodyText || '').trim()
    if (!trimmed) {
        return ''
    }
    try {
        const parsed = JSON.parse(trimmed)
        if (parsed && typeof parsed === 'object') {
            const err = (parsed as { error?: unknown }).error
            if (err && typeof err === 'object') {
                const m = (err as { message?: unknown }).message
                if (typeof m === 'string' && m) {
                    return m
                }
            }
            if (typeof err === 'string' && err) {
                return err
            }
            const topMessage = (parsed as { message?: unknown }).message
            if (typeof topMessage === 'string' && topMessage) {
                return topMessage
            }
        }
    } catch {
        // Not JSON; fall through to raw body.
    }
    // Cap the raw body so a giant HTML error page does not blow up the message.
    return trimmed.length > 500 ? `${trimmed.slice(0, 500)}…` : trimmed
}
