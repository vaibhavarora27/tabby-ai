/**
 * Pure OSC 133 (FinalTerm / shell-integration) command + exit-code tracker.
 *
 * Framework-free (no Angular, no Tabby): it consumes the raw terminal output
 * stream one chunk at a time via {@link CommandTracker.push} and detects
 * command boundaries and exit codes from the FinalTerm command markers a
 * shell-integration script emits:
 *
 *   ESC ] 133 ; C            ST   -> command execution started (output begins)
 *   ESC ] 133 ; D [; <code>] ST   -> command finished (optional exit code)
 *
 * (A = prompt start and B = command-line start are recognised and consumed but
 * carry no payload we need; they simply reset/close any in-flight capture.)
 *
 * Between a `C` marker and the next `D` marker the tracker buffers the visible
 * output (the bytes that are NOT part of a 133 marker — including any other
 * ANSI/OSC the shell emits, which the caller strips separately via
 * {@link stripAnsi}). On the `D` marker it emits a {@link CompletedCommand}
 * `{ exitCode, output }` — returned from `push()` AND delivered to the optional
 * callback passed to the constructor.
 *
 * Robustness requirements handled here:
 *  - markers split across chunk boundaries (e.g. "...\x1b]133;" in one chunk,
 *    "D;1\x07" in the next) — a trailing partial is carried into the next push;
 *  - both terminators: BEL (\x07) and ST (ESC \\ = \x1b\x5c);
 *  - a `D` marker with no exit code ("133;D") — treated as exit code 0;
 *  - extra args after the code ("133;D;1;aid=123") — only the first field is the
 *    exit code; the rest are ignored;
 *  - a non-numeric / empty exit code — treated as 0.
 *
 * It does NOT depend on receiving a `C` before a `D`: a `D` with no preceding
 * `C` (the very first prompt, or output the shell produced before integration
 * loaded) still emits a completed command with whatever output was buffered
 * since the last reset (possibly empty).
 *
 * Only the standard OSC 133 is parsed. The VS Code-proprietary OSC 633 variant
 * is intentionally NOT handled here (the shipped shell-integration snippets emit
 * 133); adding it would mean recognising a second introducer and is out of
 * scope for this tracker.
 */

/** A finished command observed on the stream. */
export interface CompletedCommand {
    /** Exit status parsed from `133;D;<code>`. Missing/blank/NaN -> 0. */
    exitCode: number
    /** Visible output captured between the command-start and command-finish
     * markers, with the 133 markers themselves removed. Other ANSI/OSC bytes
     * are left in place for the caller to strip. */
    output: string
}

/** Callback invoked for every completed command, in stream order. */
export type CompletedCommandHandler = (command: CompletedCommand) => void

// OSC introducer (ESC ]) and the 133 prefix we care about, as plain strings so
// we can do index math for the split-across-chunks carry logic.
const ESC = '\x1b'
const BEL = '\x07'
const OSC_INTRO = ESC + ']' // \x1b]

// Matches a COMPLETE FinalTerm marker: ESC ] 133 ; <A|B|C|D> optional ;args,
// terminated by BEL or ST (ESC \\). Group 1 = letter, group 2 = raw arg string
// (everything after the letter's ';' up to the terminator), or undefined.
// The arg body excludes the terminator bytes so it never swallows the BEL/ST.
const MARKER = /\x1b\]133;([A-D])(?:;([^\x07\x1b]*))?(?:\x07|\x1b\\)/

/**
 * The maximum length of a trailing fragment we will hold back as a possible
 * incomplete marker. A complete `133;D;<code>;<args>...` is short; we cap the
 * carry so a stream that merely ends in a lone "\x1b]" followed by megabytes of
 * unrelated text can never make us buffer unboundedly. If a held-back fragment
 * grows past this without completing, it was not a marker and is flushed to
 * output.
 */
const MAX_CARRY = 256

/**
 * Stateful, single-stream OSC 133 tracker. One instance per terminal session.
 * Not thread-safe (JS is single-threaded) but is re-entrant-safe in the sense
 * that the completion callback fires synchronously from within `push()`.
 */
export class CommandTracker {
    /** Bytes already scanned this push that belong to the current command's
     * visible output (between C and D). */
    private outputBuffer = ''

    /** A trailing fragment from the previous push that MIGHT be the prefix of a
     * marker split across the chunk boundary. Re-prepended to the next chunk. */
    private carry = ''

    /** True once a `C` (command-executed) marker has been seen and we are
     * actively capturing output for a command. */
    private capturing = false

    constructor (private readonly onCompleted?: CompletedCommandHandler) {}

    /**
     * Feed one raw output chunk. Returns every command that COMPLETED within
     * this chunk (normally zero or one, but a chunk can contain several markers
     * — e.g. a script that runs many commands in a burst). Each completed
     * command is also delivered to the constructor callback.
     */
    push (chunk: string): CompletedCommand[] {
        if (!chunk) {
            return []
        }

        // Re-attach any carried partial marker from the previous push so a
        // marker straddling the boundary is matched as a whole.
        let buf = this.carry + chunk
        this.carry = ''

        const completed: CompletedCommand[] = []

        // Walk the buffer, consuming complete markers and accumulating the
        // bytes between them as visible output.
        // eslint-disable-next-line no-constant-condition
        while (true) {
            const match = MARKER.exec(buf)
            if (!match) {
                break
            }
            const start = match.index
            const end = start + match[0].length

            // Text before this marker is visible output for the current command.
            this.appendOutput(buf.slice(0, start))

            const letter = match[1]
            if (letter === 'C') {
                // Command execution starts: begin a fresh capture. Anything
                // buffered before (prompt/echo) is discarded so the captured
                // output is just the command's own output.
                this.outputBuffer = ''
                this.capturing = true
            } else if (letter === 'D') {
                const command = this.finish(parseExitCode(match[2]))
                completed.push(command)
                if (this.onCompleted) {
                    this.onCompleted(command)
                }
            } else {
                // A (prompt-start) or B (command-line start): a new prompt is
                // being drawn, so close any stale capture and drop buffered
                // prompt/echo text.
                this.outputBuffer = ''
                this.capturing = false
            }

            buf = buf.slice(end)
        }

        // `buf` now has no complete marker. Its tail might be the prefix of a
        // marker split across the boundary; hold that prefix back as carry and
        // treat the rest as visible output.
        const carryStart = possiblePartialMarkerStart(buf)
        if (carryStart >= 0 && buf.length - carryStart <= MAX_CARRY) {
            this.appendOutput(buf.slice(0, carryStart))
            this.carry = buf.slice(carryStart)
        } else {
            // No plausible partial marker (or it grew too long to be one):
            // everything is visible output.
            this.appendOutput(buf)
        }

        return completed
    }

    /** Discard all buffered state. Call when the session resets / a new tab
     * takes over the tracker, so stale output never leaks into the next
     * command. */
    reset (): void {
        this.outputBuffer = ''
        this.carry = ''
        this.capturing = false
    }

    /** Append visible text to the current command's buffer (only while we are
     * actively capturing between C and D). */
    private appendOutput (text: string): void {
        if (text && this.capturing) {
            this.outputBuffer += text
        }
    }

    /** Close the current command, returning its result and clearing capture. */
    private finish (exitCode: number): CompletedCommand {
        const output = this.outputBuffer
        this.outputBuffer = ''
        this.capturing = false
        return { exitCode, output }
    }
}

/**
 * Parse the `D` marker's argument string into an exit code. The first
 * semicolon-delimited field is the code; missing/blank/non-numeric -> 0. Extra
 * fields (e.g. `aid=12345`) are ignored.
 */
function parseExitCode (args: string | undefined): number {
    if (!args) {
        return 0
    }
    const first = args.split(';', 1)[0].trim()
    if (!first) {
        return 0
    }
    const code = Number.parseInt(first, 10)
    return Number.isNaN(code) ? 0 : code
}

/**
 * Find the index where a fragment that COULD be the start of an OSC 133 marker
 * begins, scanning from the end of `buf`. Returns -1 when no suffix of `buf`
 * could grow into a marker (so the whole buffer is safe to flush as output).
 *
 * A marker begins with `ESC ]`. To be safe across a split we hold back from the
 * LAST occurrence of an introducer (or a lone trailing ESC that might become
 * one) — but only if the text from there onward is still a viable marker
 * PREFIX, i.e. it does not already contain a terminator (which would mean the
 * marker, had it been one, already completed and was either matched above or is
 * malformed and should not be withheld).
 */
function possiblePartialMarkerStart (buf: string): number {
    // A bare trailing ESC could become "ESC ]..." on the next chunk.
    if (buf.endsWith(ESC)) {
        return buf.length - 1
    }
    // Otherwise look for the last "ESC ]" introducer.
    const idx = buf.lastIndexOf(OSC_INTRO)
    if (idx < 0) {
        return -1
    }
    const tail = buf.slice(idx)
    // If the tail already contains a terminator, it is not an incomplete marker
    // (a complete/garbled one would have been consumed by MARKER above); don't
    // withhold it.
    if (tail.includes(BEL) || tail.includes(ESC + '\\')) {
        return -1
    }
    // Only withhold if the tail is consistent with being a 133 marker prefix:
    // "ESC]", "ESC]1", "ESC]13", "ESC]133", "ESC]133;", "ESC]133;D", etc. If it
    // is clearly some OTHER OSC (e.g. ESC]0;title), don't withhold it — let it
    // flow to output (the caller strips it).
    const afterIntro = tail.slice(OSC_INTRO.length)
    if (!isMarkerPrefix(afterIntro)) {
        return -1
    }
    return idx
}

/**
 * Is `s` a prefix of the literal "133;" possibly followed by a marker letter
 * and partial args — i.e. could the bytes after `ESC]` still grow into a 133
 * marker? Accepts "", "1", "13", "133", "133;", "133;D", "133;D;1", etc.
 */
function isMarkerPrefix (s: string): boolean {
    const PREFIX = '133;'
    if (s.length <= PREFIX.length) {
        return PREFIX.startsWith(s)
    }
    // Past "133;": next char must be a marker letter, then anything (args) is
    // fine as long as no terminator (already excluded by the caller).
    return s.startsWith(PREFIX) && /^[A-D]/.test(s.slice(PREFIX.length))
}
