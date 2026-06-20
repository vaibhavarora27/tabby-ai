/**
 * Dependency-free test helpers for streaming adapter tests.
 *
 * Lets a test build a `ReadableStream<Uint8Array>` from a fixed list of chunks
 * (strings or raw bytes) and stub the global `fetch` with deterministic,
 * `Response`-like objects. Used to drive {@link parseSSE} / {@link parseNDJSON}
 * and the four provider adapters without any network.
 *
 * No vitest/jest imports here so this file is safe to import from anywhere
 * (including non-test code) and has zero runtime deps.
 */

/** Encode a chunk to bytes; strings become UTF-8. */
function toBytes (chunk: string | Uint8Array): Uint8Array {
    return typeof chunk === 'string' ? new TextEncoder().encode(chunk) : chunk
}

/**
 * Build a `ReadableStream<Uint8Array>` that emits each provided chunk in order,
 * one per `read()`, then closes. Mirrors a real `Response.body`.
 *
 * Splitting your fixture across multiple chunks (even mid-line / mid-event)
 * exercises the parsers' boundary handling.
 */
export function streamFromChunks (
    chunks: (string | Uint8Array)[],
): ReadableStream<Uint8Array> {
    const queue = chunks.map(toBytes)
    let i = 0
    return new ReadableStream<Uint8Array>({
        pull (controller): void {
            if (i < queue.length) {
                controller.enqueue(queue[i])
                i += 1
            } else {
                controller.close()
            }
        },
    })
}

/** Subset of the DOM `Response` that adapters actually touch. Returned by the
 * fetch mocks so tests need not construct a full `Response`. */
export interface FakeResponse {
    ok: boolean
    status: number
    statusText: string
    headers: Headers
    body: ReadableStream<Uint8Array> | null
    /** Resolves to the full body as text (also used for error bodies). */
    text(): Promise<string>
    /** Resolves to the parsed JSON body. */
    json(): Promise<any>
}

/** Options for {@link makeResponse}. */
export interface FakeResponseInit {
    /** HTTP status (default 200). `ok` is derived as 200–299 unless overridden. */
    status?: number
    statusText?: string
    /** Streaming body, as ordered chunks. Mutually exclusive with `text`/`json`. */
    streamChunks?: (string | Uint8Array)[]
    /** Non-streaming body text (used for error bodies and `GET /api/tags`). */
    text?: string
    /** Non-streaming JSON body; serialised for `text()` and returned by `json()`. */
    json?: any
    /** Force `ok` independently of `status` (rarely needed). */
    ok?: boolean
    headers?: Record<string, string>
}

/**
 * Construct a `Response`-like object for a stubbed fetch.
 *
 * Body precedence: `streamChunks` -> `json` -> `text`. When `streamChunks` is
 * given, `body` is a live `ReadableStream` and `text()` drains it.
 */
export function makeResponse (init: FakeResponseInit = {}): FakeResponse {
    const status = init.status ?? 200
    const ok = init.ok ?? (status >= 200 && status < 300)

    let body: ReadableStream<Uint8Array> | null = null
    let bodyText: string

    if (init.streamChunks) {
        body = streamFromChunks(init.streamChunks)
        bodyText = init.streamChunks
            .map(c => (typeof c === 'string' ? c : new TextDecoder().decode(c)))
            .join('')
    } else if (init.json !== undefined) {
        bodyText = JSON.stringify(init.json)
        body = streamFromChunks([bodyText])
    } else {
        bodyText = init.text ?? ''
        body = bodyText === '' ? null : streamFromChunks([bodyText])
    }

    const headers = new Headers(init.headers ?? {})

    return {
        ok,
        status,
        statusText: init.statusText ?? '',
        headers,
        body,
        async text (): Promise<string> {
            return bodyText
        },
        async json (): Promise<any> {
            return JSON.parse(bodyText)
        },
    }
}

/** A drop-in for `typeof fetch` that records the calls it received. */
export interface FetchMock {
    (input: any, init?: any): Promise<FakeResponse>
    /** Every `[input, init]` pair this mock was invoked with, in order. */
    calls: Array<{ input: any; init: any }>
}

/** Wrap a responder fn as a {@link FetchMock} that records its calls. */
function recordingFetch (
    responder: (input: any, init: any, callIndex: number) => FakeResponse,
): FetchMock {
    const fn = (input: any, init?: any): Promise<FakeResponse> => {
        const callIndex = fn.calls.length
        fn.calls.push({ input, init })
        return Promise.resolve(responder(input, init, callIndex))
    }
    fn.calls = [] as Array<{ input: any; init: any }>
    return fn as FetchMock
}

/**
 * Build a `fetch` mock that returns `response` for the *first* call and then
 * throws on any further call (most adapter tests issue exactly one request).
 *
 * `response` may be a {@link FakeResponse} or a {@link FakeResponseInit} which
 * is passed to {@link makeResponse}.
 */
export function mockFetchOnce (
    response: FakeResponse | FakeResponseInit,
): FetchMock {
    const resolved = isFakeResponse(response) ? response : makeResponse(response)
    return recordingFetch((_input, _init, callIndex) => {
        if (callIndex > 0) {
            throw new Error('mockFetchOnce: fetch called more than once')
        }
        return resolved
    })
}

/**
 * Build a `fetch` mock that returns each provided response in sequence (call N
 * gets `responses[N]`). Throws if called more times than responses provided.
 */
export function mockFetchSequence (
    responses: Array<FakeResponse | FakeResponseInit>,
): FetchMock {
    const resolved = responses.map(r => (isFakeResponse(r) ? r : makeResponse(r)))
    return recordingFetch((_input, _init, callIndex) => {
        if (callIndex >= resolved.length) {
            throw new Error(
                `mockFetchSequence: unexpected fetch call #${callIndex + 1} (only ${resolved.length} stubbed)`,
            )
        }
        return resolved[callIndex]
    })
}

/**
 * Install `mock` as the global `fetch` and return a restore function.
 *
 *   const restore = installFetch(mockFetchOnce({ streamChunks: [...] }))
 *   try { ... } finally { restore() }
 */
export function installFetch (mock: FetchMock): () => void {
    const g = globalThis as { fetch?: unknown }
    const previous = g.fetch
    g.fetch = mock as unknown as typeof fetch
    return (): void => {
        g.fetch = previous as typeof fetch
    }
}

/** Narrow a {@link FakeResponse} | {@link FakeResponseInit} union. */
function isFakeResponse (
    r: FakeResponse | FakeResponseInit,
): r is FakeResponse {
    return typeof (r as FakeResponse).text === 'function'
        && 'ok' in r
        && 'status' in r
}
