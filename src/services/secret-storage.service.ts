/**
 * At-rest protection for AI provider API keys.
 *
 * Keys are persisted inside Tabby's YAML config store (`config.store.ai.*`),
 * which is plaintext on disk, so we wrap each key with Electron's
 * `safeStorage` (OS keychain / DPAPI / libsecret) when it is available. When it
 * is not — Linux without a keyring, or running outside Electron entirely (e.g.
 * tabby-web) — we degrade gracefully to storing the raw string behind an
 * explicit `raw:v1:` tag so the value is recoverable and the UI can flag that
 * it is unencrypted.
 *
 * Tag format (so legacy / cross-machine values stay parseable):
 *   - `enc:v1:<base64>`  -> base64 of `safeStorage.encryptString()`
 *   - `raw:v1:<plain>`   -> the literal key, stored unencrypted (fallback)
 *   - anything else      -> treated as a legacy raw value and returned as-is
 *
 * The actual `electron`/`@electron/remote` import is isolated behind the
 * injectable {@link SAFE_STORAGE_ACCESSOR} so the tag-parsing / fallback logic
 * is exercised in unit tests against a fake backend with no Electron present.
 */

import { Inject, Injectable, InjectionToken, Optional } from '@angular/core'

/** Tag prefixes. `v1` leaves room to migrate the wrapping scheme later. */
const ENC_PREFIX = 'enc:v1:'
const RAW_PREFIX = 'raw:v1:'

/**
 * The slice of Electron's main-process `safeStorage` this service uses. Kept as
 * a local interface (rather than depending on `Electron.SafeStorage` types,
 * which aren't installed) so a plain object can stand in for it in tests.
 */
export interface SafeStorageLike {
    isEncryptionAvailable(): boolean
    encryptString(plainText: string): Buffer | Uint8Array
    decryptString(encrypted: Buffer): string
    /** Optional on older Electron; `basic_text` on Linux means UNPROTECTED. */
    getSelectedStorageBackend?(): string
}

/**
 * DI token for the `safeStorage` accessor. Returns the live backend, or `null`
 * when none is reachable. Defaults (when not overridden) to a guarded lookup of
 * Electron's `safeStorage` via `@electron/remote`; tests provide a fake.
 */
export const SAFE_STORAGE_ACCESSOR = new InjectionToken<() => SafeStorageLike | null>(
    'tabby-ai.SafeStorageAccessor',
)

/**
 * Reach Electron's main-process `safeStorage` from a renderer plugin.
 *
 * Modern `@electron/remote` exposes `safeStorage` as a top-level property; the
 * `remote.require('electron')` path is a belt-and-suspenders fallback. Returns
 * `null` (never throws) when not running under Electron.
 */
export function defaultSafeStorageAccessor (): SafeStorageLike | null {
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const remote = require('@electron/remote')
        if (remote?.safeStorage) {
            return remote.safeStorage as SafeStorageLike
        }
        const electron = remote?.require?.('electron')
        return (electron?.safeStorage as SafeStorageLike) ?? null
    } catch {
        return null
    }
}

@Injectable({ providedIn: 'root' })
export class SecretStorageService {
    private readonly accessor: () => SafeStorageLike | null

    constructor (
        @Optional() @Inject(SAFE_STORAGE_ACCESSOR) accessor?: () => SafeStorageLike | null,
    ) {
        this.accessor = accessor ?? defaultSafeStorageAccessor
    }

    /**
     * True when OS-backed encryption is usable right now. Linux's `basic_text`
     * backend stores items unprotected, so it is treated as unavailable.
     */
    isEncryptionActive (): boolean {
        const ss = this.backend()
        if (!ss || !ss.isEncryptionAvailable()) {
            return false
        }
        const backend = ss.getSelectedStorageBackend?.()
        return backend !== 'basic_text'
    }

    /**
     * Wrap a plaintext secret for storage.
     *
     * Empty input yields an empty string (so "no key" stays "no key" rather than
     * an encrypted empty blob). Returns an `enc:v1:` tagged base64 blob when
     * encryption is active, otherwise a `raw:v1:` tagged plaintext fallback.
     */
    encrypt (plain: string): string {
        if (!plain) {
            return ''
        }
        if (this.isEncryptionActive()) {
            const ss = this.backend()
            if (ss) {
                try {
                    const buf = ss.encryptString(plain)
                    const base64 = Buffer.from(buf).toString('base64')
                    return ENC_PREFIX + base64
                } catch {
                    // Encryption unexpectedly failed — fall through to raw.
                }
            }
        }
        return RAW_PREFIX + plain
    }

    /**
     * Unwrap a stored secret back to plaintext.
     *
     * Handles all three shapes: `enc:v1:` (decrypt), `raw:v1:` (strip tag), and
     * untagged legacy values (returned verbatim). An `enc:v1:` blob that cannot
     * be decrypted (keyring vanished / wrong machine) yields an empty string so
     * the UI shows "no key" rather than ciphertext.
     */
    decrypt (stored: string): string {
        if (!stored) {
            return ''
        }
        if (stored.startsWith(RAW_PREFIX)) {
            return stored.slice(RAW_PREFIX.length)
        }
        if (stored.startsWith(ENC_PREFIX)) {
            const ss = this.backend()
            if (!ss || !ss.isEncryptionAvailable()) {
                return ''
            }
            try {
                const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64')
                return ss.decryptString(buf)
            } catch {
                return ''
            }
        }
        // Untagged legacy value — assume it was already plaintext.
        return stored
    }

    /** Resolve the backend once per call (cheap; the accessor itself guards). */
    private backend (): SafeStorageLike | null {
        return this.accessor()
    }
}
