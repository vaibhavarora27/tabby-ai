import { NgModule } from '@angular/core'
import { CommonModule } from '@angular/common'
import { FormsModule } from '@angular/forms'

import TabbyCoreModule from 'tabby-core'

/** @hidden */
@NgModule({
    imports: [
        CommonModule,
        FormsModule,
        TabbyCoreModule,
    ],
    providers: [
        // AI extension points (multi: true providers) will be registered here.
    ],
    declarations: [],
})
export default class TabbyAIModule {
    constructor () {
        // eslint-disable-next-line no-console
        console.log('tabby-ai loaded')
    }
}
