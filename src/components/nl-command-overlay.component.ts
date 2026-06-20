/**
 * Natural-language command overlay (ng-bootstrap modal).
 *
 * A THIN component: it owns only UI state (idle / loading / ready / error) and
 * delegates every piece of real logic — prompt building, model call,
 * output sanitising — to {@link NLCommandService}. Inline template + styles
 * only (the webpack build has no pug-loader; an external `templateUrl`/`.pug`
 * would break it).
 *
 * Lifecycle:
 *  - the launcher opens it via `NgbModal.open(...)` and sets `@Input()`
 *    `context` (shell + recent output) before the first change detection;
 *  - on open the prompt input is auto-focused so the user can type immediately
 *    after the hotkey, without clicking into the field first;
 *  - the user types a request and presses Enter / clicks Generate → the
 *    component calls `NLCommandService.generate(...)` and shows the command in
 *    a `<pre>` for review;
 *  - Run resolves the modal with the command string (the launcher feeds it into
 *    the terminal); Copy / Regenerate / Cancel do the obvious thing.
 *
 * Esc and the Cancel button dismiss the modal (rejecting `modal.result`);
 * an in-flight request is aborted on regenerate / destroy so a late completion
 * never writes into a closed overlay.
 */

import { AfterViewInit, Component, ElementRef, Input, OnDestroy, ViewChild } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

import { NLCommandContext, NLCommandService } from '../services/nl-command.service'

/** Finite UI states for the overlay. */
type OverlayState = 'idle' | 'loading' | 'ready' | 'error'

/** @hidden */
@Component({
    selector: 'nl-command-overlay',
    template: `
        <div class="nl-overlay">
            <div class="nl-header">
                <span class="nl-title">AI command</span>
                <span class="nl-shell" *ngIf="context?.shell">{{ context?.shell }}</span>
            </div>

            <input
                #promptInput
                class="form-control nl-input"
                type="text"
                [(ngModel)]="prompt"
                (keydown.enter)="onEnter($event)"
                [disabled]="state === 'loading'"
                placeholder="Describe what you want to do..."
                autocomplete="off"
                spellcheck="false"
            />

            <div class="nl-status" *ngIf="state === 'loading'">
                <span class="nl-spinner"></span>
                Generating...
            </div>

            <div class="nl-error text-danger" *ngIf="state === 'error'">{{ error }}</div>

            <pre class="nl-command" *ngIf="state === 'ready'">{{ command }}</pre>

            <div class="nl-actions">
                <button
                    type="button"
                    class="btn btn-primary"
                    *ngIf="state !== 'ready'"
                    [disabled]="state === 'loading' || !prompt.trim()"
                    (click)="generate()"
                >Generate</button>

                <button
                    type="button"
                    class="btn btn-primary"
                    *ngIf="state === 'ready'"
                    (click)="run()"
                >Run</button>

                <button
                    type="button"
                    class="btn btn-secondary"
                    *ngIf="state === 'ready'"
                    (click)="copy()"
                >Copy</button>

                <button
                    type="button"
                    class="btn btn-secondary"
                    *ngIf="state === 'ready' || state === 'error'"
                    [disabled]="state === 'loading'"
                    (click)="generate()"
                >Regenerate</button>

                <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="cancel()"
                >Cancel</button>
            </div>
        </div>
    `,
    styles: [`
        .nl-overlay {
            display: flex;
            flex-direction: column;
            gap: 0.75rem;
            padding: 1.25rem;
            min-width: 28rem;
        }
        .nl-header {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
        }
        .nl-title {
            font-weight: 600;
            font-size: 1.05em;
        }
        .nl-shell {
            opacity: 0.7;
            font-size: 0.85em;
            font-family: monospace;
        }
        .nl-input {
            width: 100%;
        }
        .nl-status {
            display: flex;
            align-items: center;
            gap: 0.4rem;
            opacity: 0.8;
        }
        .nl-command {
            margin: 0;
            padding: 0.6rem 0.75rem;
            border-radius: 0.25rem;
            background: rgba(127, 127, 127, 0.15);
            white-space: pre-wrap;
            word-break: break-all;
            font-family: monospace;
        }
        .nl-actions {
            display: flex;
            gap: 0.5rem;
            justify-content: flex-end;
        }
        .nl-spinner {
            display: inline-block;
            width: 0.9em;
            height: 0.9em;
            border: 2px solid currentColor;
            border-right-color: transparent;
            border-radius: 50%;
            animation: nl-spin 0.7s linear infinite;
        }
        @keyframes nl-spin {
            to { transform: rotate(360deg); }
        }
    `],
})
export class NLCommandOverlayComponent implements AfterViewInit, OnDestroy {
    /** Context (shell + recent output) supplied by the launcher before display. */
    @Input() context: NLCommandContext = {}

    @ViewChild('promptInput') promptInput?: ElementRef<HTMLInputElement>

    prompt = ''
    command = ''
    error = ''
    state: OverlayState = 'idle'

    /** Aborts the in-flight generate() so a late result cannot land on a stale view. */
    private abort?: AbortController
    private destroyed = false

    constructor (
        private modal: NgbActiveModal,
        private nl: NLCommandService,
    ) {}

    /**
     * Focus the prompt input once the view exists. Deferred via `setTimeout` so
     * the focus lands AFTER ng-bootstrap's modal focus-trap settles (the modal
     * grabs focus on open, which would otherwise override a synchronous focus).
     */
    ngAfterViewInit (): void {
        setTimeout(() => this.promptInput?.nativeElement.focus())
    }

    ngOnDestroy (): void {
        this.destroyed = true
        this.abort?.abort()
    }

    /** Enter triggers Run when a command is ready, otherwise Generate. */
    onEnter (event: Event): void {
        event.preventDefault()
        if (this.state === 'ready') {
            this.run()
        } else {
            this.generate()
        }
    }

    /** Ask the service to translate the prompt into a command. */
    async generate (): Promise<void> {
        const request = this.prompt.trim()
        if (!request || this.state === 'loading') {
            return
        }
        // Cancel any previous in-flight request before starting a new one.
        this.abort?.abort()
        const controller = new AbortController()
        this.abort = controller
        this.state = 'loading'
        this.error = ''
        this.command = ''
        try {
            const command = await this.nl.generate(request, this.context, controller.signal)
            if (this.destroyed || controller.signal.aborted) {
                return
            }
            if (command) {
                this.command = command
                this.state = 'ready'
            } else {
                this.error = 'The model did not return a command.'
                this.state = 'error'
            }
        } catch (err) {
            if (this.destroyed || controller.signal.aborted) {
                return
            }
            this.error = errorMessage(err)
            this.state = 'error'
        }
    }

    /** Resolve the modal with the chosen command (the launcher runs it). */
    run (): void {
        if (this.state === 'ready' && this.command) {
            this.modal.close(this.command)
        }
    }

    /** Copy the generated command to the clipboard (best-effort). */
    copy (): void {
        if (this.command && typeof navigator !== 'undefined' && navigator.clipboard) {
            void navigator.clipboard.writeText(this.command)
        }
    }

    /** Dismiss the overlay without running anything (Esc / Cancel). */
    cancel (): void {
        this.abort?.abort()
        this.modal.dismiss()
    }
}

/** Best-effort human-readable message from an unknown thrown value. */
function errorMessage (err: unknown): string {
    if (err instanceof Error) {
        return err.message
    }
    const m = (err as { message?: unknown })?.message
    return typeof m === 'string' ? m : String(err)
}
