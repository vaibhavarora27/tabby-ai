import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'

import TabbyCoreModule, { ConfigProvider } from 'tabby-core'
import { SettingsTabProvider } from 'tabby-settings'

import { AIProviderService } from './services/ai-provider.service'
import { AISettingsConfigProvider } from './config.provider'
import { AISettingsTabProvider } from './settings/ai-settings-tab.provider'
import { AISettingsComponent } from './settings/ai-settings.component'

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
        { provide: SettingsTabProvider, useClass: AISettingsTabProvider, multi: true },
    ],
    declarations: [
        AISettingsComponent,
    ],
})
export default class TabbyAIModule {
    constructor () {
        // eslint-disable-next-line no-console
        console.log('tabby-ai loaded')
    }
}
