/**
 * Auto-explain-failed-command terminal decorator (issue #5).
 *
 * Registered as a multi-provider `TerminalDecorator` (see `src/index.ts`), so
 * Tabby calls {@link ErrorExplainDecorator.attach} once per terminal tab. On
 * attach it subscribes to the tab's `output$` stream and feeds every chunk to a
 * per-tab {@link CommandTracker}, which parses OSC 133 shell-integration markers
 * to detect command boundaries and exit codes.
 *
 * When a command finishes with a failure exit code (per
 * {@link ErrorExplainerService.shouldExplain}) AND the user has not disabled the
 * feature (`config.store.ai.autoExplainErrors !== false`), it:
 *   1. strips ANSI/OSC noise from the captured output ({@link stripAnsi});
 *   2. asks {@link ErrorExplainerService.explain} for an explanation + fix;
 *   3. opens the {@link ErrorExplainPanelComponent} modal showing the result;
 *   4. if the user clicks "Apply Fix", feeds the fix into the terminal via
 *      `terminal.sendInput(fix + '\n')`.
 *
 * Lifecycle / safety:
 *  - the output subscription is registered with `subscribeUntilDetached(...)`
 *    so it is auto-unsubscribed on detach; `detach()` also resets the tab's
 *    tracker and aborts any in-flight explanation, then calls `super.detach()`;
 *  - explanations are STRICTLY one-at-a-time PER TAB: while one is being
 *    generated or its modal is open, subsequent failures are skipped (no spam,
 *    no overlapping model calls);
 *  - all per-tab state lives in WeakMaps keyed by the terminal, so multiple
 *    tabs are independent and state is GC'd with the tab.
 *
 * The decorator stays THIN: prompt building, model output parsing, and the
 * should-explain policy are all in {@link ErrorExplainerService}; marker parsing
 * is in {@link CommandTracker}; ANSI stripping is {@link stripAnsi}.
 */

import { Injectable } from '@angular/core'
import { ConfigService } from 'tabby-core'
import { NgbModal } from '@ng-bootstrap/ng-bootstrap'

import { BaseTerminalTabComponent, TerminalDecorator } from 'tabby-terminal'

import { CommandTracker, CompletedCommand } from '../services/command-tracker'
import { ErrorExplainerService } from '../services/error-explainer.service'
import { stripAnsi } from '../services/ansi'
import { ErrorExplainPanelComponent } from '../components/error-explain-panel.component'

/** Per-tab runtime state the decorator keeps alongside each terminal. */
interface TabState {
    tracker: CommandTracker
    /** Aborts the in-flight explanation request on detach. */
    abort?: AbortController
    /** True while an explanation is being generated or its modal is open, so a
     * second failure does not start an overlapping flow. */
    busy: boolean
}

/** @hidden */
@Injectable()
export class ErrorExplainDecorator extends TerminalDecorator {
    private states = new WeakMap<BaseTerminalTabComponent, TabState>()

    constructor (
        private config: ConfigService,
        private explainer: ErrorExplainerService,
        private ngbModal: NgbModal,
    ) {
        super()
    }

    attach (terminal: BaseTerminalTabComponent): void {
        // One tracker per tab; its completion callback drives the explain flow.
        const tracker = new CommandTracker((command: CompletedCommand) => {
            void this.onCommandFinished(terminal, command)
        })
        const state: TabState = { tracker, busy: false }
        this.states.set(terminal, state)

        // Feed raw output chunks to the tracker. output$ still carries ANSI/OSC
        // (including the 133 markers), which is exactly what the tracker parses.
        const sub = terminal.output$.subscribe((chunk: string) => {
            try {
                tracker.push(chunk)
            } catch {
                // A tracker fault must never break the terminal output pipe.
            }
        })
        this.subscribeUntilDetached(terminal, sub)
    }

    detach (terminal: BaseTerminalTabComponent): void {
        const state = this.states.get(terminal)
        if (state) {
            state.abort?.abort()
            state.tracker.reset()
            this.states.delete(terminal)
        }
        // Unsubscribes the output subscription registered above.
        super.detach(terminal)
    }

    /**
     * Handle one completed command from the tracker: gate on policy + config,
     * then (one-at-a-time) generate and show an explanation.
     */
    private async onCommandFinished (
        terminal: BaseTerminalTabComponent,
        command: CompletedCommand,
    ): Promise<void> {
        const state = this.states.get(terminal)
        if (!state || state.busy) {
            // Either detached, or an explanation is already in flight — skip to
            // avoid overlapping model calls / modal spam.
            return
        }
        if (!this.isEnabled() || !this.explainer.shouldExplain(command.exitCode)) {
            return
        }

        const output = stripAnsi(command.output).trim()
        const shell = readShellName(terminal)

        state.busy = true
        const abort = new AbortController()
        state.abort = abort
        try {
            const result = await this.explainer.explain(
                /* failedCommand */ '',
                output,
                command.exitCode,
                shell,
                abort.signal,
            )
            if (abort.signal.aborted || !this.states.has(terminal)) {
                return
            }
            await this.showPanel(terminal, result.explanation, result.fix, command.exitCode)
        } catch {
            // Network/model failure or a dismissed modal — never surface a
            // crash from a best-effort convenience feature.
        } finally {
            // Clear busy only if this is still the active request for the tab.
            const current = this.states.get(terminal)
            if (current && current.abort === abort) {
                current.busy = false
                current.abort = undefined
            }
        }
    }

    /**
     * Open the explanation panel and, if the user applies the fix, run it.
     * Resolves once the modal closes either way.
     */
    private async showPanel (
        terminal: BaseTerminalTabComponent,
        explanation: string,
        fix: string | undefined,
        exitCode: number,
    ): Promise<void> {
        const modal = this.ngbModal.open(ErrorExplainPanelComponent, { size: 'lg' })
        const instance: ErrorExplainPanelComponent = modal.componentInstance
        instance.explanation = explanation
        instance.fix = fix
        instance.exitCode = exitCode

        let chosenFix: string
        try {
            chosenFix = await modal.result
        } catch {
            // Dismissed — nothing to run.
            return
        }
        if (chosenFix && this.states.has(terminal)) {
            terminal.sendInput(chosenFix + '\n')
        }
    }

    /** The feature is on unless the user explicitly set the toggle to false. */
    private isEnabled (): boolean {
        const ai = (this.config.store as { ai?: { autoExplainErrors?: boolean } })?.ai
        return ai?.autoExplainErrors !== false
    }
}

/**
 * Best-effort human-readable shell / profile name for the terminal, mirroring
 * the launcher's heuristic. `profile` is only on the connectable subclasses, so
 * it is read defensively via a cast; falls back to the tab title.
 */
function readShellName (terminal: BaseTerminalTabComponent): string | undefined {
    const profileName = (terminal as { profile?: { name?: string } }).profile?.name
    return profileName || terminal.title || undefined
}
