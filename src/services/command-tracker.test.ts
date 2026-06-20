/**
 * Unit tests for {@link CommandTracker}.
 *
 * Pure class, no Angular: each case pushes raw output chunks containing OSC 133
 * markers and asserts the detected {@link CompletedCommand}s (exit code +
 * captured output), including markers split across chunk boundaries.
 */

import { describe, expect, it } from 'vitest'

import { CommandTracker, CompletedCommand } from './command-tracker'

const ESC = '\x1b'
const BEL = '\x07'

/** OSC 133 marker builders (BEL-terminated unless `st` requested). */
function A (st = false): string {
    return `${ESC}]133;A${st ? `${ESC}\\` : BEL}`
}
function C (st = false): string {
    return `${ESC}]133;C${st ? `${ESC}\\` : BEL}`
}
function D (code?: number | string, st = false): string {
    const arg = code === undefined ? '' : `;${code}`
    return `${ESC}]133;D${arg}${st ? `${ESC}\\` : BEL}`
}

/** Collect completions both from the return value and the callback. */
function makeTracker (): { tracker: CommandTracker; viaCallback: CompletedCommand[] } {
    const viaCallback: CompletedCommand[] = []
    const tracker = new CommandTracker(c => viaCallback.push(c))
    return { tracker, viaCallback }
}

describe('CommandTracker', () => {
    it('detects a single command with exit code 0', () => {
        const { tracker, viaCallback } = makeTracker()
        const out = tracker.push(`${C()}hello\n${D(0)}`)
        expect(out).toEqual([{ exitCode: 0, output: 'hello\n' }])
        expect(viaCallback).toEqual(out)
    })

    it('detects a non-zero exit code', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(`${C()}boom${D(127)}`)
        expect(out).toEqual([{ exitCode: 127, output: 'boom' }])
    })

    it('treats a D marker with no exit code as 0', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(`${C()}x${D()}`)
        expect(out).toEqual([{ exitCode: 0, output: 'x' }])
    })

    it('treats a non-numeric exit code as 0', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(`${C()}x${D('abc')}`)
        expect(out).toEqual([{ exitCode: 0, output: 'x' }])
    })

    it('ignores extra args after the exit code (aid=...)', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(`${C()}x${ESC}]133;D;3;aid=12345${BEL}`)
        expect(out).toEqual([{ exitCode: 3, output: 'x' }])
    })

    it('accepts the ST (ESC backslash) terminator', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(`${C(true)}done${D(1, true)}`)
        expect(out).toEqual([{ exitCode: 1, output: 'done' }])
    })

    it('handles a marker split across two chunks (mid-introducer)', () => {
        const { tracker } = makeTracker()
        // Split right after "...D" so the terminator arrives in the next chunk.
        expect(tracker.push(`${C()}partial${ESC}]133;D`)).toEqual([])
        const out = tracker.push(`;5${BEL}`)
        expect(out).toEqual([{ exitCode: 5, output: 'partial' }])
    })

    it('handles a split right at the ESC byte', () => {
        const { tracker } = makeTracker()
        expect(tracker.push(`${C()}abc${ESC}`)).toEqual([])
        const out = tracker.push(`]133;D;2${BEL}`)
        expect(out).toEqual([{ exitCode: 2, output: 'abc' }])
    })

    it('handles the C start marker split across chunks', () => {
        const { tracker } = makeTracker()
        expect(tracker.push(`${ESC}]133;`)).toEqual([])
        const out = tracker.push(`C${BEL}body${D(0)}`)
        expect(out).toEqual([{ exitCode: 0, output: 'body' }])
    })

    it('detects multiple commands in one chunk', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(
            `${C()}first${D(0)}${A()}${C()}second${D(1)}`,
        )
        expect(out).toEqual([
            { exitCode: 0, output: 'first' },
            { exitCode: 1, output: 'second' },
        ])
    })

    it('captures output streamed across several chunks between C and D', () => {
        const { tracker } = makeTracker()
        expect(tracker.push(C())).toEqual([])
        expect(tracker.push('line1\n')).toEqual([])
        expect(tracker.push('line2\n')).toEqual([])
        const out = tracker.push(D(1))
        expect(out).toEqual([{ exitCode: 1, output: 'line1\nline2\n' }])
    })

    it('discards prompt/echo text before the C marker', () => {
        const { tracker } = makeTracker()
        // Text before C (a prompt + echoed command) must not be captured.
        const out = tracker.push(`user@host:~$ ls${A()}${C()}real output${D(0)}`)
        expect(out).toEqual([{ exitCode: 0, output: 'real output' }])
    })

    it('emits a D with no preceding C using empty output', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(D(0))
        expect(out).toEqual([{ exitCode: 0, output: '' }])
    })

    it('resets the C->A capture when a new prompt starts before D', () => {
        const { tracker } = makeTracker()
        // C starts capture, then A (new prompt) aborts it; the next C/D pair is
        // the one that should be reported.
        const out = tracker.push(`${C()}aborted${A()}${C()}kept${D(0)}`)
        expect(out).toEqual([{ exitCode: 0, output: 'kept' }])
    })

    it('passes through unrelated OSC sequences as captured output', () => {
        const { tracker } = makeTracker()
        // A window-title OSC inside the command output is NOT a 133 marker, so
        // it stays in the captured output for the caller to strip later.
        const out = tracker.push(`${C()}before${ESC}]0;title${BEL}after${D(0)}`)
        expect(out).toEqual([
            { exitCode: 0, output: `before${ESC}]0;title${BEL}after` },
        ])
    })

    it('does not withhold a non-133 trailing OSC as a partial marker', () => {
        const { tracker } = makeTracker()
        // A trailing "ESC]0;..." (a title OSC prefix) is clearly not a 133
        // marker prefix, so it must flow into output, not be carried.
        expect(tracker.push(C())).toEqual([])
        tracker.push(`out${ESC}]0;ti`)
        const out = tracker.push(`tle${BEL}more${D(0)}`)
        expect(out).toEqual([
            { exitCode: 0, output: `out${ESC}]0;title${BEL}more` },
        ])
    })

    it('reset() clears in-flight capture and carry', () => {
        const { tracker } = makeTracker()
        tracker.push(`${C()}half${ESC}]133;D`)
        tracker.reset()
        // The dangling "...133;D" carry and the captured "half" are gone; a
        // fresh command is tracked cleanly.
        const out = tracker.push(`${C()}fresh${D(0)}`)
        expect(out).toEqual([{ exitCode: 0, output: 'fresh' }])
    })

    it('ignores empty chunks', () => {
        const { tracker } = makeTracker()
        expect(tracker.push('')).toEqual([])
        const out = tracker.push(`${C()}x${D(0)}`)
        expect(out).toEqual([{ exitCode: 0, output: 'x' }])
    })

    it('parses a large exit code (255)', () => {
        const { tracker } = makeTracker()
        const out = tracker.push(`${C()}x${D(255)}`)
        expect(out).toEqual([{ exitCode: 255, output: 'x' }])
    })
})
