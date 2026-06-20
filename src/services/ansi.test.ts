/**
 * Unit tests for {@link stripAnsi}.
 *
 * Pure function, no Angular: each case feeds a raw terminal string (with real
 * escape bytes) and asserts the readable text that remains.
 */

import { describe, expect, it } from 'vitest'

import { stripAnsi } from './ansi'

const ESC = '\x1b'
const BEL = '\x07'

describe('stripAnsi', () => {
    it('returns empty string for empty/falsy input', () => {
        expect(stripAnsi('')).toBe('')
        // Defensive: the guard tolerates nullish input even though the type is
        // `string` (cast to exercise it without a compile error).
        expect(stripAnsi(undefined as unknown as string)).toBe('')
        expect(stripAnsi(null as unknown as string)).toBe('')
    })

    it('leaves plain text untouched', () => {
        expect(stripAnsi('hello world')).toBe('hello world')
    })

    it('strips a single SGR colour code', () => {
        expect(stripAnsi(`${ESC}[31mred${ESC}[0m`)).toBe('red')
    })

    it('strips compound SGR (bold + colour) codes', () => {
        expect(stripAnsi(`${ESC}[1;32mok${ESC}[0m done`)).toBe('ok done')
    })

    it('strips cursor-movement CSI sequences', () => {
        expect(stripAnsi(`a${ESC}[2Cb${ESC}[1Ac`)).toBe('abc')
    })

    it('strips erase-line / clear-screen CSI sequences', () => {
        expect(stripAnsi(`${ESC}[2K${ESC}[2Jclean`)).toBe('clean')
    })

    it('strips an OSC window-title sequence terminated by BEL', () => {
        expect(stripAnsi(`${ESC}]0;my title${BEL}body`)).toBe('body')
    })

    it('strips an OSC sequence terminated by ST (ESC backslash)', () => {
        expect(stripAnsi(`${ESC}]2;title${ESC}\\after`)).toBe('after')
    })

    it('strips OSC 133 FinalTerm markers', () => {
        const raw = `${ESC}]133;A${BEL}${ESC}]133;C${BEL}output${ESC}]133;D;1${BEL}`
        expect(stripAnsi(raw)).toBe('output')
    })

    it('strips an OSC 8 hyperlink wrapper but keeps the link text', () => {
        const raw = `${ESC}]8;;https://example.com${BEL}link text${ESC}]8;;${BEL}`
        expect(stripAnsi(raw)).toBe('link text')
    })

    it('strips charset-selection and keypad escapes', () => {
        expect(stripAnsi(`${ESC}(Btext${ESC}=more${ESC}>end`)).toBe('textmoreend')
    })

    it('strips a DCS string sequence', () => {
        expect(stripAnsi(`${ESC}Psome dcs payload${ESC}\\visible`)).toBe('visible')
    })

    it('preserves newlines, carriage returns and tabs', () => {
        expect(stripAnsi(`a\nb\tc\rd`)).toBe('a\nb\tc\rd')
    })

    it('removes BEL and other lone C0 control bytes', () => {
        expect(stripAnsi(`a${BEL}b\x08c`)).toBe('abc')
    })

    it('removes a lone trailing ESC (incomplete sequence)', () => {
        expect(stripAnsi(`text${ESC}`)).toBe('text')
    })

    it('strips an 8-bit CSI introducer (0x9b)', () => {
        expect(stripAnsi(`x\x9b31mred`)).toBe('xred')
    })

    it('handles a realistic colourised failure line', () => {
        const raw = `${ESC}[0m${ESC}[31mError:${ESC}[0m command not found: ${ESC}[1mfoo${ESC}[0m\n`
        expect(stripAnsi(raw)).toBe('Error: command not found: foo\n')
    })

    it('is idempotent (stripping twice equals stripping once)', () => {
        const raw = `${ESC}[31mred${ESC}[0m ${ESC}]0;t${BEL}plain`
        const once = stripAnsi(raw)
        expect(stripAnsi(once)).toBe(once)
    })
})
