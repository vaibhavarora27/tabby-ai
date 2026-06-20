/**
 * Streaming body parsers.
 *
 * Two pure async generators that turn a web `ReadableStream<Uint8Array>`
 * (i.e. `Response.body`) into structured events:
 *
 *  - {@link parseSSE}    — Server-Sent Events (Anthropic / OpenAI / Gemini)
 *  - {@link parseNDJSON} — newline-delimited JSON (Ollama)
 *
 * Both correctly reassemble lines/events that are split across chunk
 * boundaries, decode UTF-8 incrementally (so a multi-byte codepoint split
 * across two chunks is not corrupted), and propagate cancellation: when the
 * underlying fetch is aborted the stream errors/closes and the `for await`
 * loop here terminates. The generators always cancel the underlying stream and
 * release the reader lock in a `finally`, so an abort mid-iteration — or a
 * consumer that stops early (every normal `return` on the provider sentinel,
 * plus every `break` in a `testConnection()` probe) — tears the body down
 * instead of leaking the socket.
 *
 * No Angular, no Tabby, no global state — fully unit-testable from a fake
 * `ReadableStream`.
 */

/** A parsed SSE event. `event` is the most recent `event:` field (if any) and
 * `data` is the joined `data:` payload for the event block. */
export interface SSEEvent {
    event?: string
    data: string
}

/**
 * Lazily read a `ReadableStream<Uint8Array>` and yield decoded UTF-8 *lines*.
 *
 * - Uses a streaming `TextDecoder` so multi-byte characters spanning chunk
 *   boundaries decode correctly.
 * - Splits on `\n` and strips a trailing `\r` (handles both `\n` and `\r\n`).
 * - Buffers a partial trailing line across chunks and flushes any remaining
 *   buffered text once the stream ends.
 */
async function* readLines (
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string, void, unknown> {
    const reader = stream.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    try {
        for (;;) {
            const { value, done } = await reader.read()
            if (done) {
                break
            }
            if (value === undefined) {
                continue
            }
            // `stream: true` keeps incomplete multi-byte sequences buffered
            // inside the decoder until their continuation bytes arrive.
            buffer += decoder.decode(value, { stream: true })
            let newlineIndex = buffer.indexOf('\n')
            while (newlineIndex !== -1) {
                let line = buffer.slice(0, newlineIndex)
                if (line.endsWith('\r')) {
                    line = line.slice(0, -1)
                }
                yield line
                buffer = buffer.slice(newlineIndex + 1)
                newlineIndex = buffer.indexOf('\n')
            }
        }
        // Flush any bytes the decoder was still holding, then any trailing
        // line that was not newline-terminated.
        buffer += decoder.decode()
        if (buffer.length > 0) {
            if (buffer.endsWith('\r')) {
                buffer = buffer.slice(0, -1)
            }
            yield buffer
        }
    } finally {
        // Cancel the underlying stream first so an early-return/break (e.g. a
        // provider sentinel like message_stop / [DONE] / done===true, or a
        // testConnection() probe that breaks after one delta) actually closes
        // the HTTP body / frees the socket instead of leaking it until GC.
        // cancel() is a no-op when the stream is already closed or errored
        // (e.g. after an abort), so it is safe on completion, error and abort
        // paths alike. Releasing the lock afterwards lets the stream be torn
        // down cleanly.
        try {
            await reader.cancel()
        } catch {
            // Already errored/closed — nothing to cancel.
        }
        reader.releaseLock()
    }
}

/**
 * Parse a Server-Sent Events stream.
 *
 * An event block is terminated by a blank line. Within a block:
 *  - `event: <name>` sets the event type,
 *  - `data: <payload>` lines accumulate (joined with `\n`, per the SSE spec),
 *  - lines beginning with `:` are comments and skipped,
 *  - other fields (`id:`, `retry:`) are ignored.
 *
 * A blank line emits the accumulated event (only if it carried any `data`).
 * Whatever is buffered when the stream ends is flushed as a final event.
 */
export async function* parseSSE (
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<SSEEvent, void, unknown> {
    let eventName: string | undefined
    const dataLines: string[] = []
    let sawData = false

    const flush = function* (): Generator<SSEEvent, void, unknown> {
        if (sawData) {
            yield { event: eventName, data: dataLines.join('\n') }
        }
        eventName = undefined
        dataLines.length = 0
        sawData = false
    }

    for await (const line of readLines(stream)) {
        if (line === '') {
            // Blank line: dispatch the buffered event block.
            yield* flush()
            continue
        }
        if (line.startsWith(':')) {
            // Comment line (also used as a keep-alive heartbeat).
            continue
        }
        const colon = line.indexOf(':')
        let field: string
        let valueRaw: string
        if (colon === -1) {
            // A field name with no value, per spec.
            field = line
            valueRaw = ''
        } else {
            field = line.slice(0, colon)
            valueRaw = line.slice(colon + 1)
        }
        // A single leading space after the colon is part of the framing, not data.
        const value = valueRaw.startsWith(' ') ? valueRaw.slice(1) : valueRaw

        if (field === 'event') {
            eventName = value
        } else if (field === 'data') {
            dataLines.push(value)
            sawData = true
        }
        // `id` / `retry` / unknown fields are intentionally ignored.
    }
    // Stream ended without a trailing blank line: emit any pending block.
    yield* flush()
}

/**
 * Parse a newline-delimited JSON stream (Ollama's `/api/chat`).
 *
 * Each non-empty line is `JSON.parse`d and yielded. Blank lines are skipped.
 * Chunk boundaries that split a line are reassembled by {@link readLines}.
 */
export async function* parseNDJSON (
    stream: ReadableStream<Uint8Array>,
): AsyncGenerator<any, void, unknown> {
    for await (const line of readLines(stream)) {
        const trimmed = line.trim()
        if (trimmed === '') {
            continue
        }
        yield JSON.parse(trimmed)
    }
}
