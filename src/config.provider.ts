/**
 * Tabby {@link ConfigProvider} for the AI plugin.
 *
 * Seeds the global config store's `ai` subtree from {@link DEFAULT_AI_SETTINGS}
 * so every key the settings UI binds to (`config.store.ai.*`) resolves through
 * the ConfigProxy even before the user has saved anything. Tabby deep-merges
 * each provider's `defaults` into the single global store (arrays replaced, not
 * concatenated); the convention is one unique top-level key per plugin — here
 * `ai`.
 *
 * Registration (in `src/index.ts`, `multi: true` is mandatory):
 *
 *   { provide: ConfigProvider, useClass: AISettingsConfigProvider, multi: true }
 *
 * Tabby's own ConfigProvider impls carry no `@Injectable()` decorator (only
 * `useClass` instantiation is needed, never direct DI of the provider), so this
 * one follows suit.
 */

import { ConfigProvider } from 'tabby-core'

import { DEFAULT_AI_SETTINGS } from './providers'

/** @hidden */
export class AISettingsConfigProvider extends ConfigProvider {
    defaults = {
        ai: { ...DEFAULT_AI_SETTINGS },
    }

    platformDefaults = {}
}
