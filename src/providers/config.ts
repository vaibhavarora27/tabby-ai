/**
 * Persisted AI settings and provider metadata.
 *
 * Framework-free: the Angular service reads/writes these via Tabby's
 * `ConfigService.store.ai`, but the shape and defaults live here so they can be
 * unit-tested and reused by the pure provider factory.
 */

/** The four supported providers. */
export type AIProviderId = 'anthropic' | 'openai' | 'gemini' | 'ollama'

/**
 * The user-configurable AI settings blob (stored under `config.store.ai`).
 *
 * API keys are per-provider so switching providers does not clobber the others.
 * `ollamaBaseUrl` is always present (Ollama is the zero-config default); the
 * other providers ignore it.
 */
export interface AISettings {
    provider: AIProviderId
    anthropicApiKey?: string
    openaiApiKey?: string
    geminiApiKey?: string
    /** Selected model id for the active provider. Empty string = "use the
     * provider's default / first suggested model". */
    model: string
    /** Base URL for the local Ollama server (e.g. "http://localhost:11434"). */
    ollamaBaseUrl: string
    /** Upper bound on generated tokens (required by Anthropic, forwarded where
     * supported). */
    maxTokens: number
}

/**
 * Defaults applied when no settings (or partial settings) are persisted.
 *
 * Defaults to Ollama so the plugin works out-of-the-box with no API key once a
 * local server is running. `model` is intentionally empty: the settings UI
 * fills it from {@link SUGGESTED_MODELS} or a live `listModels()` call.
 */
export const DEFAULT_AI_SETTINGS: AISettings = {
    provider: 'ollama',
    anthropicApiKey: '',
    openaiApiKey: '',
    geminiApiKey: '',
    model: '',
    ollamaBaseUrl: 'http://localhost:11434',
    maxTokens: 1024,
}

/**
 * Suggested model ids per provider for the settings dropdown.
 *
 * Ordered roughly cheap/fast -> capable. Ollama has no canonical list (models
 * are whatever the user has pulled), so it is populated live from
 * `GET /api/tags`; a small seed is provided as a fallback.
 */
export const SUGGESTED_MODELS: Record<AIProviderId, string[]> = {
    anthropic: [
        'claude-haiku-4-5',
        'claude-sonnet-4-6',
        'claude-opus-4-8',
    ],
    openai: [
        'gpt-4o-mini',
        'gpt-4o',
    ],
    gemini: [
        'gemini-2.0-flash',
        'gemini-2.5-pro',
    ],
    ollama: [
        'llama3.1',
        'qwen2.5',
        'mistral',
    ],
}
