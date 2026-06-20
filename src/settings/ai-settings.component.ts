/**
 * "AI Assistant" settings tab component.
 *
 * Inline template + styles only — the plugin's webpack build has loaders for
 * `.scss`/`.css` but NO pug-loader, so an external `templateUrl`/`.pug` would
 * break the build. State is a local working copy of the persisted `ai` settings
 * subtree (`config.store.ai`); edits are committed back and `config.save()`d on
 * each change. API keys are wrapped via {@link SecretStorageService} before they
 * touch the YAML store and unwrapped for display.
 *
 * No long-lived RxJS subscriptions are held here (only one-shot promises for
 * "Fetch models" / "Test Connection"); {@link AISettingsComponent.ngOnDestroy}
 * sets a `destroyed` flag so a probe that resolves after the tab closes cannot
 * write back into a dead view.
 *
 * Free-text / secret inputs persist on `(change)`/`(blur)` rather than on every
 * keystroke, so encrypting the API key (an OS-keychain round-trip) and writing
 * the YAML config happen once per edit, not once per character.
 */

import { Component, OnDestroy, OnInit } from '@angular/core'
import { ConfigService } from 'tabby-core'

import {
    AISettings,
    AIProviderId,
    DEFAULT_AI_SETTINGS,
    SUGGESTED_MODELS,
} from '../providers'
import { AIProviderService } from '../services/ai-provider.service'
import { SecretStorageService } from '../services/secret-storage.service'

/** Providers that authenticate with an API key (vs. local Ollama). */
const CLOUD_PROVIDERS: AIProviderId[] = ['anthropic', 'openai', 'gemini']

/** Outcome of the most recent "Test Connection" click. */
interface TestResult {
    ok: boolean
    error?: string
}

/** @hidden */
@Component({
    selector: 'ai-settings-tab',
    template: `
        <div class="ai-settings content-box">
            <h3 class="mb-3">AI Assistant</h3>

            <div class="form-line">
                <div class="header">
                    <div class="title">Provider</div>
                    <div class="description">Which AI backend to talk to.</div>
                </div>
                <select
                    class="form-control"
                    [ngModel]="settings.provider"
                    (ngModelChange)="onProviderChange($event)"
                >
                    <option value="anthropic">Anthropic</option>
                    <option value="openai">OpenAI</option>
                    <option value="gemini">Gemini</option>
                    <option value="ollama">Ollama (local)</option>
                </select>
            </div>

            <div class="form-line" *ngIf="isCloud()">
                <div class="header">
                    <div class="title">API key</div>
                    <div class="description">
                        Stored
                        <ng-container *ngIf="encryptionActive">encrypted via your OS keychain</ng-container>
                        <ng-container *ngIf="!encryptionActive">
                            <strong class="text-warning">unencrypted</strong>
                            (no OS keychain available)
                        </ng-container>.
                    </div>
                </div>
                <div class="input-group">
                    <input
                        class="form-control"
                        [type]="showApiKey ? 'text' : 'password'"
                        [(ngModel)]="apiKey"
                        (change)="onApiKeyChange()"
                        (ngModelChange)="markApiKeyEdited()"
                        autocomplete="off"
                        spellcheck="false"
                        placeholder="Paste your API key"
                    />
                    <button
                        type="button"
                        class="btn btn-secondary"
                        (click)="showApiKey = !showApiKey"
                    >{{ showApiKey ? 'Hide' : 'Show' }}</button>
                </div>
            </div>

            <div class="form-line" *ngIf="settings.provider === 'ollama'">
                <div class="header">
                    <div class="title">Ollama base URL</div>
                    <div class="description">Where your local Ollama server is listening.</div>
                </div>
                <input
                    class="form-control"
                    type="text"
                    [(ngModel)]="settings.ollamaBaseUrl"
                    (change)="persist()"
                    placeholder="http://localhost:11434"
                />
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Model</div>
                    <div class="description">Pick a suggested model or type one in.</div>
                </div>
                <div class="model-row">
                    <select
                        class="form-control"
                        [ngModel]="settings.model"
                        (ngModelChange)="onModelSelect($event)"
                    >
                        <option value="">(custom / type below)</option>
                        <option *ngFor="let m of modelOptions" [value]="m">{{ m }}</option>
                    </select>
                    <button
                        *ngIf="settings.provider === 'ollama'"
                        type="button"
                        class="btn btn-secondary"
                        [disabled]="fetchingModels"
                        (click)="fetchModels()"
                    >
                        <span *ngIf="fetchingModels" class="spinner"></span>
                        Fetch models
                    </button>
                </div>
                <input
                    class="form-control mt-2"
                    type="text"
                    [(ngModel)]="settings.model"
                    (change)="persist()"
                    placeholder="model id (free text)"
                />
                <div class="text-danger mt-1" *ngIf="fetchError">{{ fetchError }}</div>
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Max tokens</div>
                    <div class="description">Upper bound on generated tokens per response.</div>
                </div>
                <input
                    class="form-control"
                    type="number"
                    min="1"
                    [(ngModel)]="settings.maxTokens"
                    (change)="persist()"
                />
            </div>

            <div class="form-line">
                <div class="header">
                    <div class="title">Connection</div>
                    <div class="description">Verify the provider is reachable with these settings.</div>
                </div>
                <div class="test-row">
                    <button
                        type="button"
                        class="btn btn-primary"
                        [disabled]="testing"
                        (click)="testConnection()"
                    >
                        <span *ngIf="testing" class="spinner"></span>
                        Test Connection
                    </button>
                    <span class="test-result text-success" *ngIf="testResult?.ok">&#10003; Connected</span>
                    <span class="test-result text-danger" *ngIf="testResult && !testResult.ok">
                        &#10007; {{ testResult.error || 'Connection failed' }}
                    </span>
                </div>
            </div>
        </div>
    `,
    styles: [`
        .ai-settings .form-line {
            display: flex;
            flex-direction: column;
            margin-bottom: 1.25rem;
        }
        .ai-settings .header {
            margin-bottom: 0.35rem;
        }
        .ai-settings .header .title {
            font-weight: 600;
        }
        .ai-settings .header .description {
            opacity: 0.7;
            font-size: 0.85em;
        }
        .ai-settings .input-group,
        .ai-settings .model-row,
        .ai-settings .test-row {
            display: flex;
            align-items: center;
            gap: 0.5rem;
        }
        .ai-settings .model-row .form-control {
            flex: 1 1 auto;
        }
        .ai-settings .test-result {
            font-weight: 600;
        }
        .ai-settings .spinner {
            display: inline-block;
            width: 0.9em;
            height: 0.9em;
            margin-right: 0.35rem;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            vertical-align: -0.1em;
            animation: ai-spin 0.7s linear infinite;
        }
        @keyframes ai-spin {
            to { transform: rotate(360deg); }
        }
    `],
})
export class AISettingsComponent implements OnInit, OnDestroy {
    /** Working copy of `config.store.ai`, normalised over the defaults. */
    settings: AISettings = { ...DEFAULT_AI_SETTINGS }

    /** Decrypted, in-memory plaintext of the current provider's API key. */
    apiKey = ''
    showApiKey = false

    /** Whether OS-backed encryption is currently active (drives the UI warning). */
    encryptionActive = false

    /** Model dropdown options (suggested registry, replaced by a live fetch). */
    modelOptions: string[] = []

    fetchingModels = false
    fetchError = ''

    testing = false
    testResult: TestResult | null = null

    /**
     * True when the key loaded for the active provider was an `enc:v1:` blob
     * that could not be decrypted (keyring vanished / different machine). In
     * that state {@link apiKey} is the empty string but the stored ciphertext is
     * still recoverable elsewhere, so {@link persist} must NOT clobber it with
     * `encrypt('')`. Cleared as soon as the user edits the key or switches
     * provider (which reloads and recomputes it).
     */
    private apiKeyDecryptFailed = false

    private destroyed = false

    constructor (
        public config: ConfigService,
        private ai: AIProviderService,
        private secrets: SecretStorageService,
    ) {}

    ngOnInit (): void {
        const stored = (this.config.store as { ai?: Partial<AISettings> }).ai
        this.settings = { ...DEFAULT_AI_SETTINGS, ...(stored ?? {}) }
        this.encryptionActive = this.secrets.isEncryptionActive()
        this.refreshModelOptions()
        this.loadApiKey()
    }

    ngOnDestroy (): void {
        // The provider's testConnection() does not accept an AbortSignal (see
        // AIProvider in providers/types.ts), so there is no in-flight request to
        // cancel here. The `destroyed` flag below makes any probe that resolves
        // after teardown a no-op, so a closed tab never writes into a dead view.
        this.destroyed = true
    }

    /** True when the active provider authenticates with an API key. */
    isCloud (): boolean {
        return CLOUD_PROVIDERS.includes(this.settings.provider)
    }

    /** Provider changed: reset the model to that provider's first suggestion. */
    onProviderChange (provider: AIProviderId): void {
        this.settings.provider = provider
        this.refreshModelOptions()
        this.settings.model = this.modelOptions[0] ?? ''
        this.fetchError = ''
        this.testResult = null
        this.loadApiKey()
        this.persist()
    }

    /** Model picked from the dropdown (empty option = keep free-text value). */
    onModelSelect (model: string): void {
        if (model) {
            this.settings.model = model
            this.persist()
        }
    }

    /**
     * The user typed in the key field. Clear the "unrecoverable blob" guard
     * immediately so the next {@link persist} writes the freshly-entered key
     * instead of preserving the stale ciphertext. Does not itself persist —
     * persistence is deferred to {@link onApiKeyChange} on `(change)`/blur so we
     * do not encrypt + disk-write on every keystroke.
     */
    markApiKeyEdited (): void {
        this.apiKeyDecryptFailed = false
    }

    /** API key committed (on blur/change): re-wrap and persist it. */
    onApiKeyChange (): void {
        this.apiKeyDecryptFailed = false
        this.persist()
    }

    /**
     * Fetch the live model list for the current settings (Ollama `/api/tags`).
     * Guarded against concurrent clicks via {@link fetchingModels}.
     */
    async fetchModels (): Promise<void> {
        if (this.fetchingModels) {
            return
        }
        this.fetchingModels = true
        this.fetchError = ''
        try {
            const provider = this.ai.getProvider(this.currentSettings())
            const models = provider.listModels ? await provider.listModels() : []
            if (this.destroyed) {
                return
            }
            if (models.length) {
                this.modelOptions = models
                if (!models.includes(this.settings.model)) {
                    this.settings.model = models[0]
                    this.persist()
                }
            } else {
                this.fetchError = 'No models returned by the server.'
            }
        } catch (err) {
            if (!this.destroyed) {
                this.fetchError = errorMessage(err)
            }
        } finally {
            if (!this.destroyed) {
                this.fetchingModels = false
            }
        }
    }

    /**
     * Probe the provider with the current settings. Guarded against concurrent
     * clicks. The provider's `testConnection()` does not accept a cancellation
     * signal, so we cannot abort the in-flight request; the {@link destroyed}
     * guard instead ensures a probe that resolves after the tab closes is a
     * no-op rather than a write into a dead view.
     */
    async testConnection (): Promise<void> {
        if (this.testing) {
            return
        }
        this.testing = true
        this.testResult = null
        try {
            const result = await this.ai.getProvider(this.currentSettings()).testConnection()
            if (!this.destroyed) {
                this.testResult = result
            }
        } catch (err) {
            if (!this.destroyed) {
                this.testResult = { ok: false, error: errorMessage(err) }
            }
        } finally {
            if (!this.destroyed) {
                this.testing = false
            }
        }
    }

    /**
     * Commit the working copy back to `config.store.ai` and persist to disk.
     * The plaintext `apiKey` is wrapped via {@link SecretStorageService} into the
     * provider-specific field; the others are preserved untouched.
     *
     * Key-loss guard: if the loaded key was an `enc:v1:` blob this machine could
     * not decrypt ({@link apiKeyDecryptFailed}), the in-memory {@link apiKey} is
     * empty even though a recoverable ciphertext exists. In that case the stored
     * blob is preserved verbatim rather than overwritten with `encrypt('')`, so
     * an unrelated edit (model / max-tokens / re-selecting the provider) cannot
     * silently destroy a key the user never re-entered.
     */
    persist (): void {
        const store = this.config.store as { ai: AISettings }
        const next: AISettings = {
            ...this.settings,
            maxTokens: normaliseMaxTokens(this.settings.maxTokens),
        }
        if (this.isCloud()) {
            const field = apiKeyField(this.settings.provider)
            if (this.apiKey === '' && this.apiKeyDecryptFailed) {
                // The stored key is an enc:v1: blob we could not decrypt here
                // (keyring vanished / different machine). It is still recoverable
                // elsewhere, so preserve it verbatim rather than overwriting it
                // with encrypt('') and permanently destroying a key the user
                // never re-entered.
                next[field] = this.settings[field]
            } else {
                next[field] = this.secrets.encrypt(this.apiKey)
            }
        }
        store.ai = next
        this.settings = { ...next }
        void this.config.save()
    }

    /** Suggested models for the active provider (used by the dropdown). */
    private refreshModelOptions (): void {
        this.modelOptions = [...(SUGGESTED_MODELS[this.settings.provider] ?? [])]
    }

    /**
     * Decrypt the stored key for the active cloud provider into {@link apiKey}.
     *
     * Also records, via {@link apiKeyDecryptFailed}, whether the stored value was
     * an `enc:v1:` blob that decrypted to empty — i.e. an unrecoverable
     * ciphertext (keyring gone / different machine) rather than a genuinely
     * absent key. {@link persist} uses that flag to avoid clobbering the blob.
     */
    private loadApiKey (): void {
        if (!this.isCloud()) {
            this.apiKey = ''
            this.apiKeyDecryptFailed = false
            return
        }
        const stored = this.settings[apiKeyField(this.settings.provider)] ?? ''
        this.apiKey = this.secrets.decrypt(stored)
        this.apiKeyDecryptFailed = stored.startsWith('enc:v1:') && this.apiKey === ''
    }

    /**
     * Settings for a provider call: the working copy with the API key swapped
     * back to its decrypted plaintext (adapters expect the raw key).
     */
    private currentSettings (): AISettings {
        const out: AISettings = { ...this.settings }
        if (this.isCloud()) {
            out[apiKeyField(this.settings.provider)] = this.apiKey
        }
        return out
    }
}

/** The {@link AISettings} field holding a given cloud provider's API key. */
function apiKeyField (provider: AIProviderId): 'anthropicApiKey' | 'openaiApiKey' | 'geminiApiKey' {
    switch (provider) {
        case 'openai':
            return 'openaiApiKey'
        case 'gemini':
            return 'geminiApiKey'
        case 'anthropic':
        default:
            return 'anthropicApiKey'
    }
}

/** Coerce the bound (possibly string, from the number input) max-tokens value. */
function normaliseMaxTokens (value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value)
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_AI_SETTINGS.maxTokens
}

/** Best-effort human-readable message from an unknown thrown value. */
function errorMessage (err: unknown): string {
    if (err instanceof Error) {
        return err.message
    }
    const m = (err as { message?: unknown })?.message
    return typeof m === 'string' ? m : String(err)
}
