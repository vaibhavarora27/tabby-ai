/**
 * Settings-tab contribution for the AI plugin.
 *
 * Surfaces an "AI Assistant" tab inside Tabby's Settings window. Tabby injects
 * `SettingsTabProvider[]` (multi-token), so this is registered with
 * `multi: true` in `src/index.ts`:
 *
 *   { provide: SettingsTabProvider, useClass: AISettingsTabProvider, multi: true }
 *
 * `getComponentType()` returns the bare component class; Tabby instantiates it
 * via Angular DI (no `@Input()`s, no `entryComponents` under Ivy / Angular 15).
 */

import { Injectable } from '@angular/core'
import { SettingsTabProvider } from 'tabby-settings'

import { AISettingsComponent } from './ai-settings.component'

/** @hidden */
@Injectable()
export class AISettingsTabProvider extends SettingsTabProvider {
    id = 'ai'
    icon = 'robot'
    title = 'AI Assistant'

    getComponentType (): any {
        return AISettingsComponent
    }
}
