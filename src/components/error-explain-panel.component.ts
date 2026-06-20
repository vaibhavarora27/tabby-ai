/**
 * Failed-command explanation panel (ng-bootstrap modal).
 *
 * A THIN component: it holds only the data the decorator hands it
 * (`explanation`, optional `fix`, `exitCode`, `command`) and two buttons. It
 * contains no logic beyond UI — it does not call the model, parse anything, or
 * touch the terminal. Choosing "Apply Fix" resolves the modal with the fix
 * command string; "Dismiss" / Esc / the close button rejects it. The decorator
 * owns what happens next (feeding the fix into the terminal).
 *
 * Inline template + styles only (the webpack build has no pug-loader, so an
 * external `templateUrl` would break it).
 */

import { Component, Input } from '@angular/core'
import { NgbActiveModal } from '@ng-bootstrap/ng-bootstrap'

/** @hidden */
@Component({
    selector: 'error-explain-panel',
    template: `
        <div class="ee-panel">
            <div class="ee-header">
                <span class="ee-title">Command failed</span>
                <span class="ee-exit" *ngIf="exitCode !== null">exit code {{ exitCode }}</span>
            </div>

            <pre class="ee-command" *ngIf="command">{{ command }}</pre>

            <div class="ee-explanation">{{ explanation }}</div>

            <ng-container *ngIf="fix">
                <div class="ee-fix-label">Suggested fix</div>
                <pre class="ee-fix">{{ fix }}</pre>
            </ng-container>

            <div class="ee-actions">
                <button
                    type="button"
                    class="btn btn-primary"
                    *ngIf="fix"
                    (click)="applyFix()"
                >Apply Fix</button>

                <button
                    type="button"
                    class="btn btn-secondary"
                    (click)="dismiss()"
                >Dismiss</button>
            </div>
        </div>
    `,
    styles: [`
        .ee-panel {
            display: flex;
            flex-direction: column;
            gap: 0.6rem;
            padding: 1.1rem 1.25rem;
            min-width: 28rem;
            max-width: 44rem;
        }
        .ee-header {
            display: flex;
            align-items: baseline;
            justify-content: space-between;
        }
        .ee-title {
            font-weight: 600;
            font-size: 1.05em;
        }
        .ee-exit {
            opacity: 0.7;
            font-size: 0.85em;
            font-family: monospace;
        }
        .ee-command {
            margin: 0;
            padding: 0.45rem 0.6rem;
            border-radius: 0.25rem;
            background: rgba(127, 127, 127, 0.12);
            white-space: pre-wrap;
            word-break: break-all;
            font-family: monospace;
            opacity: 0.85;
        }
        .ee-explanation {
            white-space: pre-wrap;
            line-height: 1.4;
        }
        .ee-fix-label {
            font-weight: 600;
            font-size: 0.85em;
            opacity: 0.8;
        }
        .ee-fix {
            margin: 0;
            padding: 0.6rem 0.75rem;
            border-radius: 0.25rem;
            background: rgba(127, 127, 127, 0.18);
            white-space: pre-wrap;
            word-break: break-all;
            font-family: monospace;
        }
        .ee-actions {
            display: flex;
            gap: 0.5rem;
            justify-content: flex-end;
            margin-top: 0.25rem;
        }
    `],
})
export class ErrorExplainPanelComponent {
    /** Plain-English explanation of the failure (required). */
    @Input() explanation = ''
    /** Suggested fix command; when absent, no "Apply Fix" button is shown. */
    @Input() fix?: string
    /** The command that failed, shown for context. */
    @Input() command = ''
    /** Exit code of the failed command, or null to hide the badge. */
    @Input() exitCode: number | null = null

    constructor (private modal: NgbActiveModal) {}

    /** Resolve the modal with the fix command (the decorator runs it). */
    applyFix (): void {
        if (this.fix) {
            this.modal.close(this.fix)
        }
    }

    /** Close without applying anything (Dismiss / Esc / close button). */
    dismiss (): void {
        this.modal.dismiss()
    }
}
