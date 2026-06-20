/**
 * Hotkey launcher for the AI natural-language command overlay.
 *
 * Wires together the three runtime pieces:
 *  - subscribes to `HotkeysService.hotkey$` (a stream of plain id strings) and
 *    reacts to {@link AI_NL_COMMAND_HOTKEY};
 *  - resolves the currently active tab and guards that it is a terminal
 *    (`instanceof BaseTerminalTabComponent`) — a no-op otherwise;
 *  - opens {@link NLCommandOverlayComponent} as an ng-bootstrap modal, seeding
 *    it with the terminal's shell name + a snapshot of recent output;
 *  - on confirm (the modal resolves with a command string) feeds it into the
 *    terminal via `sendInput(command + '\n')` to run it.
 *
 * `init()` (called once from the module constructor) starts the subscription.
 * The single long-lived subscription is owned for the lifetime of the plugin;
 * there is no per-tab teardown because the launcher itself lives as long as the
 * app.
 */

import { Injectable } from '@angular/core'
import { AppService, BaseTabComponent, HotkeysService } from 'tabby-core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'
import { Subscription } from 'rxjs'

import { BaseTerminalTabComponent } from 'tabby-terminal'

import { AI_NL_COMMAND_HOTKEY } from '../hotkeys.provider'
import { NLCommandContext } from './nl-command.service'
import { NLCommandOverlayComponent } from '../components/nl-command-overlay.component'

/** How many trailing terminal lines to snapshot as model context. */
const RECENT_OUTPUT_LINES = 40

/** @hidden */
@Injectable({ providedIn: 'root' })
export class NLCommandLauncher {
    private subscription?: Subscription

    constructor (
        private app: AppService,
        private hotkeys: HotkeysService,
        private ngbModal: NgbModal,
    ) {}

    /**
     * Start listening for the hotkey. Idempotent: a second call is a no-op so
     * the module constructor can call it unconditionally.
     */
    init (): void {
        if (this.subscription) {
            return
        }
        this.subscription = this.hotkeys.hotkey$.subscribe((hotkey: string) => {
            if (hotkey === AI_NL_COMMAND_HOTKEY) {
                void this.open()
            }
        })
    }

    /**
     * Open the overlay for the active terminal, then run the chosen command.
     * Guards when the active tab is not a terminal (e.g. settings, a profiles
     * tab, or an empty workspace) — nothing happens in that case.
     */
    private async open (): Promise<void> {
        const terminal = this.getActiveTerminal()
        if (!terminal) {
            return
        }

        const modal = this.ngbModal.open(NLCommandOverlayComponent)
        const instance: NLCommandOverlayComponent = modal.componentInstance
        instance.context = await this.describe(terminal)

        let command: string
        try {
            command = await modal.result
        } catch {
            // Dismissed (Esc / Cancel) — nothing to run.
            return
        }
        if (command) {
            terminal.sendInput(command + '\n')
        }
    }

    /**
     * The active tab as a terminal, or null. Handles the common single-pane
     * case directly via `instanceof`; split-pane workspaces (where `activeTab`
     * is a SplitTabComponent) simply fall through to null here.
     */
    private getActiveTerminal (): BaseTerminalTabComponent | null {
        const tab: BaseTabComponent | null = this.app.activeTab
        if (tab instanceof BaseTerminalTabComponent) {
            return tab
        }
        return null
    }

    /**
     * Capture context for the model: the shell/profile name and a snapshot of
     * the last {@link RECENT_OUTPUT_LINES} lines from the xterm.js buffer.
     * Output capture is best-effort — any failure yields an empty snapshot
     * rather than blocking the overlay.
     */
    private async describe (terminal: BaseTerminalTabComponent): Promise<NLCommandContext> {
        return {
            shell: readShellName(terminal),
            recentOutput: readRecentOutput(terminal, RECENT_OUTPUT_LINES),
        }
    }
}

/**
 * Best-effort human-readable shell / profile name for the active terminal.
 *
 * `profile` is exposed by the connectable terminal subclasses (local / SSH) but
 * is NOT on the base `BaseTerminalTabComponent` type, so it is read defensively
 * via a cast. Falls back to the tab title when no profile name is available.
 */
function readShellName (terminal: BaseTerminalTabComponent): string | undefined {
    const profileName = (terminal as { profile?: { name?: string } }).profile?.name
    return profileName || terminal.title || undefined
}

/**
 * Read the last `lines` rows of the terminal's xterm.js buffer.
 *
 * Reaches into the concrete XTermFrontend's public `xterm` instance (the base
 * `Frontend` type exposes no buffer accessor). Defensive: any missing field or
 * thrown error yields an empty string so context capture never breaks the
 * overlay.
 */
function readRecentOutput (terminal: BaseTerminalTabComponent, lines: number): string {
    try {
        const xterm = (terminal.frontend as { xterm?: any } | undefined)?.xterm
        const buffer = xterm?.buffer?.active
        if (!buffer || typeof buffer.getLine !== 'function') {
            return ''
        }
        const end: number = (buffer.baseY ?? 0) + (xterm.rows ?? 0)
        const start = Math.max(0, end - lines)
        const out: string[] = []
        for (let i = start; i < end; i++) {
            const line = buffer.getLine(i)
            out.push(line?.translateToString(true) ?? '')
        }
        return out.join('\n').replace(/\n+$/, '')
    } catch {
        return ''
    }
}
