/**
 * Failed-command explanation service.
 *
 * Mirrors the {@link NLCommandService} shape: all non-trivial logic
 * (prompt construction, model-output parsing, the should-we-explain policy)
 * lives in pure methods/functions so it is unit-testable without bootstrapping
 * Angular; the `@Injectable()` surface is only the wrapper that reads settings
 * and dispatches to {@link AIProviderService}.
 *
 * Given a command that exited non-zero plus its captured (ANSI-stripped) output,
 * {@link ErrorExplainerService.explain} asks the model for a short plain-English
 * explanation and, when it can, a single corrected command. The model is
 * instructed to put any suggested fix on its own line beginning `FIX:` so
 * {@link ErrorExplainerService.parseExplanation} can split the human explanation
 * from the runnable fix deterministically.
 */

import { Injectable } from '@angular/core'

import { ChatMessage } from '../providers'
import { AIProviderService } from './ai-provider.service'

/** Parsed model response: prose explanation plus an optional runnable fix. */
export interface ParsedExplanation {
    /** Plain-English explanation of why the command failed. */
    explanation: string
    /** A single corrected command to offer as "Apply Fix", if the model gave
     * one. Absent when the model could not suggest a concrete fix. */
    fix?: string
}

/** The result of {@link ErrorExplainerService.explain}. */
export interface ExplanationResult extends ParsedExplanation {
    /** The exit code that triggered the explanation (echoed for the UI). */
    exitCode: number
}

/** Cap on how much captured output we send to the model, in characters. The
 * tail is the most relevant part of a failure (the error message), so when the
 * output is larger than this we keep the END. */
const MAX_OUTPUT_CHARS = 4000

/** Exit codes we deliberately do NOT explain: a user-initiated interruption or
 * stop is not an error worth annotating.
 *  - 130 = process terminated by SIGINT (Ctrl-C)
 *  - 146 = 128 + SIGTSTP (Ctrl-Z stop) on some shells
 *  - 148 = 128 + SIGTSTP on others / 128 + SIGCONT family — treated as a stop
 */
const IGNORED_EXIT_CODES = new Set([130, 146, 148])

@Injectable({ providedIn: 'root' })
export class ErrorExplainerService {
    constructor (private ai: AIProviderService) {}

    /**
     * Policy gate: should a command with this exit code be auto-explained?
     *
     * True only when the code is a genuine non-zero failure that is NOT a
     * user-initiated interrupt/stop (Ctrl-C = 130, Ctrl-Z stop = 146/148). Zero
     * (success) is never explained. Used by the decorator before it spends a
     * model call.
     */
    shouldExplain (exitCode: number): boolean {
        if (!Number.isFinite(exitCode) || exitCode === 0) {
            return false
        }
        return !IGNORED_EXIT_CODES.has(exitCode)
    }

    /**
     * Build the system + user chat prompt for explaining a failed command.
     *
     * The system prompt fixes the output contract: a short explanation, then —
     * only if a concrete fix exists — a final line starting `FIX:` carrying a
     * single runnable command and nothing else. The user message carries the
     * failed command, the (already ANSI-stripped, tail-truncated) output, and
     * the shell name when known.
     */
    buildPrompt (
        failedCommand: string,
        output: string,
        shell?: string,
    ): { system: string; user: string } {
        const shellName = (shell ?? '').trim() || 'the user\'s shell'

        const system = [
            `You are an expert command-line troubleshooting assistant for ${shellName}.`,
            'A command the user ran has FAILED (non-zero exit code).',
            'Explain, in at most 3 short sentences and plain English, WHY it failed,',
            'using the command and its output as evidence. Be concrete and practical.',
            'If — and only if — you can suggest a single corrected command that is likely to fix it,',
            'put it on the FINAL line, starting with "FIX:" followed by exactly the command to run',
            '(no markdown, no backticks, no surrounding quotes, no prose on that line).',
            'If you cannot suggest a reliable fix, do NOT output a FIX: line at all.',
            'Never include a FIX: line that just repeats the failed command unchanged.',
        ].join(' ')

        const userParts: string[] = []
        if (shell && shell.trim()) {
            userParts.push(`Shell: ${shell.trim()}`)
        }
        userParts.push(`Failed command:\n${failedCommand.trim()}`)
        const trimmedOutput = truncateTail(output.trim(), MAX_OUTPUT_CHARS)
        if (trimmedOutput) {
            userParts.push(`Output:\n${trimmedOutput}`)
        } else {
            userParts.push('Output: (the command produced no captured output)')
        }

        return { system, user: userParts.join('\n\n') }
    }

    /**
     * Split a raw model response into the prose explanation and the optional
     * `FIX:` command.
     *
     * Rules:
     *  - the explanation is every line that is NOT the fix line, trimmed;
     *  - the fix is taken from the FIRST line whose trimmed form starts with
     *    `FIX:` (case-insensitive); its value is the remainder, with any
     *    markdown fences / wrapping back-ticks / quotes stripped;
     *  - an empty fix (`FIX:` with nothing after it) is treated as no fix;
     *  - if there is no explanation text at all (the model emitted only a fix),
     *    the explanation falls back to a generic sentence so the UI is never
     *    blank.
     */
    parseExplanation (modelText: string): ParsedExplanation {
        const text = (modelText ?? '').replace(/\r\n/g, '\n').trim()
        if (!text) {
            return { explanation: '' }
        }

        const lines = text.split('\n')
        const explanationLines: string[] = []
        let fix: string | undefined

        for (const line of lines) {
            const trimmed = line.trim()
            const fixMatch = /^fix\s*:\s*(.*)$/i.exec(trimmed)
            if (fixMatch && fix === undefined) {
                const candidate = cleanFixCommand(fixMatch[1])
                if (candidate) {
                    fix = candidate
                }
                // The FIX: line itself is never part of the explanation.
                continue
            }
            explanationLines.push(line)
        }

        let explanation = explanationLines.join('\n').trim()
        if (!explanation) {
            explanation = fix
                ? 'The command failed. A suggested fix is shown below.'
                : 'The command failed.'
        }

        return fix ? { explanation, fix } : { explanation }
    }

    /**
     * Explain a failed command using the active provider.
     *
     * Reads settings + provider through {@link AIProviderService} (so model /
     * maxTokens come from the user's config), runs a single buffered completion,
     * and parses the result. An optional {@link AbortSignal} is forwarded so the
     * caller can cancel (e.g. on tab teardown). The returned object also echoes
     * the `exitCode`.
     */
    async explain (
        failedCommand: string,
        output: string,
        exitCode: number,
        shell?: string,
        signal?: AbortSignal,
    ): Promise<ExplanationResult> {
        const settings = this.ai.getSettings()
        const provider = this.ai.getProvider(settings)
        const { system, user } = this.buildPrompt(failedCommand, output, shell)

        const messages: ChatMessage[] = [{ role: 'user', content: user }]
        const raw = await provider.complete({
            system,
            messages,
            model: settings.model,
            maxTokens: settings.maxTokens,
            signal,
        })
        const parsed = this.parseExplanation(raw)
        return { ...parsed, exitCode }
    }
}

/**
 * Keep the LAST `max` characters of `text` (the tail of a failure holds the
 * actual error message). When truncating, prefix an elision marker so the model
 * knows the head was cut.
 */
function truncateTail (text: string, max: number): string {
    if (text.length <= max) {
        return text
    }
    return `…(output truncated)…\n${text.slice(text.length - max)}`
}

/**
 * Clean a candidate fix command pulled from a `FIX:` line: strip a wrapping
 * markdown fence, surrounding back-ticks, or a single matching pair of quotes,
 * then trim. Returns '' when nothing runnable remains.
 */
function cleanFixCommand (raw: string): string {
    let s = raw.trim()
    if (!s) {
        return ''
    }
    // Strip an inline code span / wrapping back-ticks: `cmd` -> cmd.
    if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) {
        s = s.slice(1, -1).trim()
    }
    // Strip a single matching pair of surrounding quotes, but only when the
    // quote char does not reappear inside (so a quoted argument is preserved).
    const first = s[0]
    const last = s[s.length - 1]
    if (s.length >= 2 && (first === '"' || first === '\'') && last === first) {
        const inner = s.slice(1, -1)
        if (!inner.includes(first)) {
            s = inner.trim()
        }
    }
    return s
}
