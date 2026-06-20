/**
 * Hotkey contribution for the AI natural-language command overlay.
 *
 * Per Tabby's hotkey convention there are two cooperating pieces, both
 * registered as `multi: true` providers in `src/index.ts`:
 *
 *  1. {@link AINLCommandHotkeyProvider} — declares the hotkey *id* + display
 *     name (the `HotkeyDescription`). It carries no key bindings: the abstract
 *     `HotkeyProvider` only contributes `{ id, name }`.
 *  2. {@link AINLCommandHotkeyConfigProvider} — declares the DEFAULT key
 *     bindings for that id (⌘-I on macOS, Ctrl-I elsewhere), keyed by the same
 *     id. Defaults live in a `ConfigProvider`, not the `HotkeyProvider`.
 *
 * The id is consumed by {@link NLCommandLauncher}, which subscribes to
 * `HotkeysService.hotkey$` (a stream of plain id strings) and acts when it sees
 * {@link AI_NL_COMMAND_HOTKEY}.
 */

import { Injectable } from '@angular/core'
import {
    ConfigProvider,
    HotkeyDescription,
    HotkeyProvider,
    Platform,
} from 'tabby-core'

/** The hotkey id shared by the provider, the config defaults, and the launcher. */
export const AI_NL_COMMAND_HOTKEY = 'ai-nl-command'

/** @hidden Declares the hotkey id + human-readable name. */
@Injectable()
export class AINLCommandHotkeyProvider extends HotkeyProvider {
    hotkeys: HotkeyDescription[] = [
        { id: AI_NL_COMMAND_HOTKEY, name: 'AI: natural language command' },
    ]

    async provide (): Promise<HotkeyDescription[]> {
        return this.hotkeys
    }
}

/**
 * @hidden Default key bindings for {@link AI_NL_COMMAND_HOTKEY}.
 *
 * `defaults` is the cross-platform fallback (empty so platform defaults win);
 * `platformDefaults` binds ⌘-I on macOS and Ctrl-I on Windows/Linux. Tabby
 * deep-merges these into the global `hotkeys` config subtree.
 */
export class AINLCommandHotkeyConfigProvider extends ConfigProvider {
    defaults = {
        hotkeys: {
            [AI_NL_COMMAND_HOTKEY]: [],
        },
    }

    platformDefaults = {
        [Platform.macOS]: {
            hotkeys: {
                [AI_NL_COMMAND_HOTKEY]: ['⌘-I'],
            },
        },
        [Platform.Windows]: {
            hotkeys: {
                [AI_NL_COMMAND_HOTKEY]: ['Ctrl-I'],
            },
        },
        [Platform.Linux]: {
            hotkeys: {
                [AI_NL_COMMAND_HOTKEY]: ['Ctrl-I'],
            },
        },
    }
}
