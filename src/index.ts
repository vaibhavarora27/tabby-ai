import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'

import TabbyCoreModule, { ConfigProvider, HotkeyProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'
import { TerminalDecorator } from 'tabby-terminal'

import { AIProviderService } from './services/ai-provider.service'
import { AISettingsConfigProvider } from './config.provider'
import { AISettingsTabProvider } from './settings/ai-settings-tab.provider'
import { AISettingsComponent } from './settings/ai-settings.component'
import {
    AINLCommandHotkeyConfigProvider,
    AINLCommandHotkeyProvider,
} from './hotkeys.provider'
import { NLCommandService } from './services/nl-command.service'
import { NLCommandLauncher } from './services/nl-command.launcher'
import { NLCommandOverlayComponent } from './components/nl-command-overlay.component'
import { ErrorExplainerService } from './services/error-explainer.service'
import { ErrorExplainDecorator } from './decorators/error-explain.decorator'
import { ErrorExplainPanelComponent } from './components/error-explain-panel.component'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        AIProviderService,
        { provide: ConfigProvider, useClass: AISettingsConfigProvider, multi: true },
        { provide: ConfigProvider, useClass: AINLCommandHotkeyConfigProvider, multi: true },
        { provide: SettingsTabProvider, useClass: AISettingsTabProvider, multi: true },
        { provide: HotkeyProvider, useClass: AINLCommandHotkeyProvider, multi: true },
        NLCommandService,
        NLCommandLauncher,
        ErrorExplainerService,
        { provide: TerminalDecorator, useClass: ErrorExplainDecorator, multi: true },
    ],
    declarations: [
        AISettingsComponent,
        NLCommandOverlayComponent,
        ErrorExplainPanelComponent,
    ],
    // No entryComponents: Angular 15 is Ivy; components are instantiated
    // dynamically (settings tab via getComponentType(), the overlay via
    // NgbModal.open()) without it.
})
export default class TabbyAIModule {
    constructor (launcher: NLCommandLauncher) {
        // Start listening for the AI command hotkey for the app's lifetime.
        launcher.init()
        // eslint-disable-next-line no-console
        console.log('tabby-ai loaded')
    }
}
