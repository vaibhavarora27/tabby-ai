import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'

import {
    AIProvider,
    AISettings,
    ChatRequest,
    DEFAULT_AI_SETTINGS,
    AnthropicAdapter,
    OpenAIAdapter,
    GeminiAdapter,
    OllamaAdapter,
} from '../providers'

/**
 * Angular-facing entry point for the AI layer.
 *
 * Responsibilities:
 *  - read/normalise persisted settings from Tabby's `ConfigService`
 *    (`config.store.ai`), merged over {@link DEFAULT_AI_SETTINGS};
 *  - construct the correct provider adapter for those settings via the pure
 *    {@link AIProviderService.makeProvider} factory;
 *  - delegate `complete` / `stream` / `testConnection` to the active provider.
 *
 * All non-trivial logic lives in the static {@link AIProviderService.makeProvider}
 * factory so it can be exercised without bootstrapping Angular.
 */
@Injectable({ providedIn: 'root' })
export class AIProviderService {
    constructor (private config: ConfigService) {}

    /**
     * Current AI settings: {@link DEFAULT_AI_SETTINGS} shallow-merged with
     * whatever the user persisted under `config.store.ai`. Missing/partial
     * stores degrade to the defaults (Ollama, localhost).
     */
    getSettings (): AISettings {
        const store = this.config.store as { ai?: Partial<AISettings> }
        return AIProviderService.mergeSettings(store?.ai)
    }

    /**
     * Build the provider adapter for the given settings (defaults to the
     * persisted settings). Pure aside from the settings read; see
     * {@link AIProviderService.makeProvider}.
     */
    getProvider (settings?: AISettings): AIProvider {
        return AIProviderService.makeProvider(settings ?? this.getSettings())
    }

    /** Run a buffered completion against the active provider. */
    complete (req: ChatRequest): Promise<string> {
        return this.getProvider().complete(this.applyDefaults(req))
    }

    /** Stream text deltas from the active provider. */
    stream (req: ChatRequest): AsyncIterable<string> {
        return this.getProvider().stream(this.applyDefaults(req))
    }

    /** Probe the active provider's credentials/reachability for the settings UI. */
    testConnection (): Promise<{ ok: boolean; error?: string }> {
        return this.getProvider().testConnection()
    }

    /**
     * Fill in `model` / `maxTokens` on a request from settings when the caller
     * left them unset, so call sites can pass only `messages` (+ optional
     * `system` / `signal`).
     */
    private applyDefaults (req: ChatRequest): ChatRequest {
        const settings = this.getSettings()
        return {
            ...req,
            model: req.model || settings.model,
            maxTokens: req.maxTokens ?? settings.maxTokens,
        }
    }

    /**
     * Shallow-merge a partial persisted blob over the defaults. Static + pure so
     * tests can validate normalisation without Angular.
     */
    static mergeSettings (stored?: Partial<AISettings>): AISettings {
        return { ...DEFAULT_AI_SETTINGS, ...(stored ?? {}) }
    }

    /**
     * Pure factory: construct the adapter for `settings.provider`.
     *
     * Each adapter receives exactly the inputs its constructor needs — the
     * relevant API key (or base URL for Ollama) plus the default model — so this
     * function has no Angular/Tabby dependency and is the single place adapter
     * wiring is tested.
     */
    static makeProvider (settings: AISettings): AIProvider {
        switch (settings.provider) {
            case 'anthropic':
                return new AnthropicAdapter(settings.anthropicApiKey ?? '', settings.model)
            case 'openai':
                return new OpenAIAdapter(settings.openaiApiKey ?? '', settings.model)
            case 'gemini':
                return new GeminiAdapter(settings.geminiApiKey ?? '', settings.model)
            case 'ollama':
                return new OllamaAdapter(settings.ollamaBaseUrl, settings.model)
            default:
                // Exhaustive: `provider` is a closed union. The `never` binding
                // makes adding a provider without a case a compile error.
                return assertNeverProvider(settings.provider)
        }
    }
}

/** Compile-time exhaustiveness guard for the provider switch. */
function assertNeverProvider (provider: never): never {
    throw new Error(`Unsupported AI provider: ${String(provider)}`)
}
