/**
 * ANSI / terminal escape-sequence stripping.
 *
 * Framework-free and pure: {@link stripAnsi} takes a raw terminal string (as it
 * arrives on `BaseTerminalTabComponent.output$`, which still carries ANSI/most
 * OSC bytes) and returns readable plain text. It is used by the error-explain
 * decorator to clean captured command output before sending it to the model, so
 * the prompt is not polluted with colour codes and cursor moves.
 *
 * What it removes:
 *  - CSI sequences (ESC[ … final-byte): all SGR colour codes, cursor moves,
 *    erase-line/screen, scroll-region, etc.;
 *  - OSC sequences (ESC] … BEL | ST): window-title (0/2), hyperlinks (8),
 *    FinalTerm/shell-integration markers (133), VS Code (633), iTerm2 (1337),
 *    clipboard (52);
 *  - DCS / SOS / PM / APC string sequences (ESC P|X|^|_ … ST);
 *  - other two/three-byte escapes (ESC + optional intermediates + final byte,
 *    e.g. charset selection `ESC(B`, `ESC=`, `ESC>`, full reset `ESC c`);
 *  - any remaining lone ESC / 8-bit C1 introducer (e.g. a sequence split across
 *    chunks whose terminator never arrived);
 *  - non-printable C0 control bytes (BEL, backspace, etc.).
 *
 * What it KEEPS: ordinary printable text plus the whitespace a human reading a
 * transcript expects — newline (\n), carriage return (\r) and tab (\t).
 *
 * Implementation note: this is a single-pass regex strip, not a full terminal
 * emulator. It does not replay cursor moves / backspaces to reconstruct the
 * on-screen text; for the error-explain use case (feed recent output to an LLM)
 * removing the control bytes is sufficient and far cheaper.
 */

/* eslint-disable no-control-regex */

// CSI: either ESC '[' (7-bit) or the single 8-bit CSI byte 0x9b, followed by
// parameter bytes (0x30-0x3F), intermediate bytes (0x20-0x2F), then a final
// byte (0x40-0x7E).
const CSI = /(?:\x1b\[|\x9b)[\x30-\x3f]*[\x20-\x2f]*[\x40-\x7e]/g

// OSC: either ESC ']' (7-bit) or the single 8-bit OSC byte 0x9d, any payload,
// terminated by BEL (0x07), ST (ESC '\' = 0x1b 0x5c) or 8-bit ST (0x9c).
// Payload is non-greedy.
const OSC = /(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c)/g

// DCS (ESC P), SOS (ESC X), PM (ESC ^), APC (ESC _), each terminated by ST
// (ESC '\') or 8-bit ST (0x9c). Payload is non-greedy. The 8-bit forms of these
// introducers (0x90/0x98/0x9e/0x9f) are handled by the lone-C1 pass below.
const STRING_SEQ = /\x1b[P^_X][\s\S]*?(?:\x1b\\|\x9c)/g

// A two/three-byte escape: ESC, optional intermediate bytes (0x20-0x2f), then a
// single final byte (0x30-0x7e). Covers charset selection (ESC ( B), keypad
// modes (ESC =, ESC >), full reset (ESC c), etc. Runs AFTER the CSI/OSC/string
// passes so it never eats their introducers.
const ESC_SEQ = /\x1b[\x20-\x2f]*[\x30-\x7e]/g

// Any remaining lone ESC or 8-bit C1 control introducer that did not form a
// recognised sequence (e.g. a sequence split across chunks whose tail never
// arrived). Range 0x80-0x9f is the C1 set.
const LONE_C1 = /[\x1b\x80-\x9f]/g

// Non-printable C0 control characters EXCEPT the whitespace we keep:
// \t (0x09), \n (0x0a), \r (0x0d). Also drops BEL (0x07), backspace (0x08),
// vertical tab / form-feed, SI/SO and DEL (0x7f).
const C0_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g

/**
 * Remove ANSI/OSC/escape control sequences from `s`, returning readable text.
 *
 * Pure and total: never throws, returns `''` for empty/nullish input, and
 * preserves \n / \r / \t. Order matters — multi-byte sequences (CSI, OSC,
 * string sequences) are removed before the generic single-escape pass so their
 * introducers are not mis-consumed.
 */
export function stripAnsi (s: string): string {
    if (!s) {
        return ''
    }
    return s
        .replace(CSI, '')
        .replace(OSC, '')
        .replace(STRING_SEQ, '')
        .replace(ESC_SEQ, '')
        .replace(LONE_C1, '')
        .replace(C0_CONTROLS, '')
}
