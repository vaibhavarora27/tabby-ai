/**
 * Natural-language -> shell-command translation.
 *
 * All non-trivial logic lives here (prompt construction + model-output
 * sanitising) so it can be unit-tested without bootstrapping Angular. The
 * Angular surface is only the `@Injectable()` wrapper that reads settings and
 * dispatches to {@link AIProviderService}; the overlay component and the
 * hotkey launcher delegate everything to this service.
 *
 * `generate()` is the one impure method (it talks to the active provider via
 * {@link AIProviderService.complete}); {@link NLCommandService.buildPrompt} and
 * {@link NLCommandService.extractCommand} are pure and statically reachable for
 * tests.
 */

import { Injectable } from '@angular/core'

import { ChatMessage } from '../providers'
import { AIProviderService } from './ai-provider.service'

/** Lightweight context captured from the active terminal tab. */
export interface NLCommandContext {
    /** Human-readable shell / profile name (e.g. "bash", "zsh", "PowerShell"). */
    shell?: string
    /** A snapshot of recent terminal output, used to ground the model. */
    recentOutput?: string
}

/** The two halves of a chat prompt this service produces. */
export interface NLPrompt {
    system: string
    user: string
}

@Injectable({ providedIn: 'root' })
export class NLCommandService {
    constructor (private ai: AIProviderService) {}

    /**
     * Build the system + user prompt for a natural-language request.
     *
     * The system prompt hard-instructs the model to emit ONLY the runnable
     * command for the target shell — no markdown fences, no prose, no
     * explanation — because {@link NLCommandService.extractCommand} is a safety
     * net, not a license to be sloppy. Shell + recent output are woven into the
     * user message as context, and ONLY when actually present (an empty
     * `recentOutput` adds no "Recent terminal output:" section).
     */
    buildPrompt (naturalLanguage: string, ctx: NLCommandContext = {}): NLPrompt {
        const shell = (ctx.shell ?? '').trim()
        const shellName = shell || 'the user\'s shell'

        const system = [
            `You are an expert command-line assistant for ${shellName}.`,
            `Translate the user's request into a single runnable shell command for ${shellName}.`,
            'Output ONLY the command itself.',
            'Do NOT wrap it in markdown or code fences.',
            'Do NOT add any prose, explanation, comments, or a leading shell prompt (no "$").',
            'If the task genuinely requires multiple commands, separate them with newlines, but output nothing else.',
        ].join(' ')

        const userParts: string[] = []
        if (shell) {
            userParts.push(`Shell: ${shell}`)
        }
        const recentOutput = (ctx.recentOutput ?? '').trim()
        if (recentOutput) {
            userParts.push(`Recent terminal output:\n${recentOutput}`)
        }
        userParts.push(`Request: ${naturalLanguage.trim()}`)

        return { system, user: userParts.join('\n\n') }
    }

    /**
     * Robustly reduce messy model output to a single runnable command.
     *
     * Defensive against the common failure modes of instruction-following
     * models even when told to emit only the command:
     *  - ```` ```sh ... ``` ```` fenced blocks (with or without a language tag);
     *  - a leading prose sentence ("Here is the command:", "Sure! ...");
     *  - a leading shell prompt marker ("$ ", "> ", "PS> ");
     *  - the whole thing wrapped in surrounding quotes or backticks;
     *  - a trailing explanation paragraph after the command.
     *
     * Multi-line output is preserved up to the LAST line that still looks like a
     * command, so a genuine multi-command script (or a heredoc whose body reads
     * like prose) survives intact; only a trailing explanation paragraph that
     * sits AFTER the last command line is dropped.
     */
    extractCommand (modelOutput: string): string {
        if (!modelOutput) {
            return ''
        }

        let text = modelOutput.replace(/\r\n/g, '\n').trim()

        // 1) Prefer the contents of the first fenced code block if present.
        const fenced = extractFencedBlock(text)
        if (fenced !== null) {
            text = fenced
        } else {
            // No fence: strip a leading prose lead-in like "Here is ...:" that
            // sits on its own line above the command.
            text = stripLeadingProseLine(text)
        }

        // 2) Split into lines, drop blank lines and stray fence markers. We trim
        // a leading shell-prompt marker only off the FIRST non-blank line (where
        // a copied prompt would actually appear); inner lines are left intact so
        // a genuine '#' comment in a multi-command script is never mangled.
        const rawLines = text.split('\n')
        const lines: string[] = []
        let seenFirst = false
        for (const raw of rawLines) {
            const trimmed = raw.trim()
            if (trimmed.length === 0 || trimmed === '```') {
                continue
            }
            if (!seenFirst) {
                lines.push(stripPromptMarker(trimmed))
                seenFirst = true
            } else {
                lines.push(trimmed)
            }
        }

        if (lines.length === 0) {
            return stripWrappingQuotes(text.trim())
        }

        // 3) Keep everything up to and including the LAST command-looking line.
        // This preserves multi-command scripts and heredoc/echo bodies that read
        // like prose, while still dropping a trailing explanation paragraph.
        const lastCommandIdx = lastIndexOfCommandLine(lines)
        const kept = lastCommandIdx >= 0 ? lines.slice(0, lastCommandIdx + 1) : [lines[0]]

        const command = kept.join('\n').trim()
        return stripWrappingQuotes(command)
    }

    /**
     * Generate a shell command for `naturalLanguage` using the active provider.
     *
     * Reads settings + provider through {@link AIProviderService} (so model /
     * maxTokens come from the user's config) and runs a single buffered
     * completion, then sanitises the result via {@link extractCommand}. An
     * optional {@link AbortSignal} is forwarded so the overlay can cancel an
     * in-flight request (e.g. on Esc / Regenerate).
     */
    async generate (
        naturalLanguage: string,
        ctx: NLCommandContext = {},
        signal?: AbortSignal,
    ): Promise<string> {
        const settings = this.ai.getSettings()
        const provider = this.ai.getProvider(settings)
        const { system, user } = this.buildPrompt(naturalLanguage, ctx)

        const messages: ChatMessage[] = [{ role: 'user', content: user }]
        const raw = await provider.complete({
            system,
            messages,
            model: settings.model,
            maxTokens: settings.maxTokens,
            signal,
        })
        return this.extractCommand(raw)
    }
}

/**
 * Return the contents of the first ```` ``` ```` fenced block in `text`, or
 * `null` if there is no closed fence. A leading language tag (```sh```,
 * ```bash```, ```shell```, etc.) on the opening fence line is dropped.
 */
function extractFencedBlock (text: string): string | null {
    const open = text.indexOf('```')
    if (open === -1) {
        return null
    }
    // Skip past the opening fence line (which may carry a language tag).
    const afterOpenLine = text.indexOf('\n', open)
    if (afterOpenLine === -1) {
        return null
    }
    const rest = text.slice(afterOpenLine + 1)
    const close = rest.indexOf('```')
    if (close === -1) {
        // Unterminated fence: treat everything after the opener as the body.
        return rest.trim()
    }
    return rest.slice(0, close).trim()
}

/**
 * Drop a single leading prose line that introduces the command, e.g.
 * "Here is the command:" / "Sure, try this:" — but only when it is clearly
 * prose (ends with a colon or reads like a sentence) and there is a following
 * line to keep.
 */
function stripLeadingProseLine (text: string): string {
    const newlineIndex = text.indexOf('\n')
    if (newlineIndex === -1) {
        return text
    }
    const firstLine = text.slice(0, newlineIndex).trim()
    const remainder = text.slice(newlineIndex + 1).trim()
    if (!remainder) {
        return text
    }
    const looksLikeProse =
        /:\s*$/.test(firstLine) ||
        /^(here(?:'s| is)|sure|certainly|of course|you can|to do (?:this|that)|the command)\b/i.test(firstLine)
    return looksLikeProse ? remainder : text
}

/**
 * Strip a leading shell-prompt marker ("$ ", "> ", "PS> ", "PS C:\\> ").
 *
 * NOTE: '#' is intentionally NOT treated as a prompt marker. Although it is the
 * conventional root prompt, in model output a leading '# ' is far more likely a
 * genuine shell comment (e.g. inside a multi-command script), and stripping it
 * would turn the comment text into an executable command.
 */
function stripPromptMarker (line: string): string {
    return line.replace(/^(?:PS[^>]*>|[$>])\s+/, '')
}

/**
 * Heuristic: does this line look like a command rather than a prose sentence?
 * Genuine command lines pass this; a trailing explanation paragraph fails it
 * (long, ends in sentence punctuation, contains spaces).
 */
function isLikelyCommandLine (line: string): boolean {
    if (!line) {
        return false
    }
    // A continuation, pipe, or shell logical operator is a strong command signal.
    if (/[|&;]\s*$/.test(line) || line.endsWith('\\')) {
        return true
    }
    // Sentences tend to end with a period and contain multiple words; commands
    // usually do not end in a bare period.
    const endsLikeSentence = /[.!?]$/.test(line) && /\s/.test(line)
    const wordCount = line.split(/\s+/).length
    return !(endsLikeSentence && wordCount > 6)
}

/**
 * Index of the LAST line that looks like a command, or -1 if none do. Used to
 * keep a multi-command script / heredoc body whole while trimming a trailing
 * prose paragraph that follows the real command(s).
 */
function lastIndexOfCommandLine (lines: string[]): number {
    for (let i = lines.length - 1; i >= 0; i--) {
        if (isLikelyCommandLine(lines[i])) {
            return i
        }
    }
    return -1
}

/**
 * Strip a single matching pair of wrapping quotes or backticks around the whole
 * command. Only unwraps when the quote spans the entire string so we never
 * mangle a command whose own arguments are quoted (e.g. `grep "foo bar" .`).
 */
function stripWrappingQuotes (text: string): string {
    const trimmed = text.trim()
    if (trimmed.length < 2) {
        return trimmed
    }
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === '`' || first === '"' || first === '\'') && last === first) {
        const inner = trimmed.slice(1, -1)
        // Only unwrap if the quote char does not reappear inside (otherwise the
        // outer quotes are part of the command's own argument grammar).
        if (!inner.includes(first)) {
            return inner.trim()
        }
    }
    return trimmed
}
