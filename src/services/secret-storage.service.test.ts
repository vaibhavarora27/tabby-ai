/**
 * Unit tests for {@link SecretStorageService}.
 *
 * Fully offline and Angular-free: the service is constructed directly with a
 * fake `safeStorage`-like accessor, so we exercise the pure tag-parsing and
 * fallback logic without Electron present. Covered:
 *   - encrypt/decrypt round-trip against a fake encrypting backend;
 *   - the raw fallback path when encryption is unavailable (no backend, the
 *     backend reports unavailable, and Linux's unprotected `basic_text`);
 *   - tag parsing of legacy (untagged) and explicit `raw:v1:` values;
 *   - unrecoverable `enc:v1:` blobs decrypting to empty rather than ciphertext.
 */

import { describe, expect, it } from 'vitest'

import {
    SafeStorageLike,
    SecretStorageService,
} from './secret-storage.service'

/**
 * A deterministic fake of Electron's `safeStorage`.
 *
 * "Encryption" is a reversible byte-wise XOR so a round-trip is verifiable
 * without any real crypto. `available` and `backend` are configurable to drive
 * the availability branches.
 */
function fakeSafeStorage (opts: {
    available?: boolean
    backend?: string
    throwOnEncrypt?: boolean
    throwOnDecrypt?: boolean
} = {}): SafeStorageLike {
    const available = opts.available ?? true
    const KEY = 0x5a
    return {
        isEncryptionAvailable (): boolean {
            return available
        },
        encryptString (plainText: string): Buffer {
            if (opts.throwOnEncrypt) {
                throw new Error('encrypt failed')
            }
            const bytes = Buffer.from(plainText, 'utf8').map(b => b ^ KEY)
            return Buffer.from(bytes)
        },
        decryptString (encrypted: Buffer): string {
            if (opts.throwOnDecrypt) {
                throw new Error('decrypt failed')
            }
            const bytes = Buffer.from(encrypted).map(b => b ^ KEY)
            return Buffer.from(bytes).toString('utf8')
        },
        getSelectedStorageBackend (): string {
            return opts.backend ?? 'keychain'
        },
    }
}

/** Build a service whose accessor returns `backend` (or null). */
function serviceWith (backend: SafeStorageLike | null): SecretStorageService {
    return new SecretStorageService(() => backend)
}

const SECRET = 'sk-test-ABC123-üñîçødé'

describe('SecretStorageService.isEncryptionActive', () => {
    it('is true when the backend reports an available, protected backend', () => {
        const svc = serviceWith(fakeSafeStorage({ available: true, backend: 'keychain' }))
        expect(svc.isEncryptionActive()).toBe(true)
    })

    it('is false when no backend is reachable', () => {
        const svc = serviceWith(null)
        expect(svc.isEncryptionActive()).toBe(false)
    })

    it('is false when the backend reports encryption unavailable', () => {
        const svc = serviceWith(fakeSafeStorage({ available: false }))
        expect(svc.isEncryptionActive()).toBe(false)
    })

    it('treats Linux basic_text as unavailable (it stores unprotected)', () => {
        const svc = serviceWith(fakeSafeStorage({ available: true, backend: 'basic_text' }))
        expect(svc.isEncryptionActive()).toBe(false)
    })
})

describe('SecretStorageService encrypt/decrypt round-trip', () => {
    it('round-trips a secret through the enc:v1: path', () => {
        const svc = serviceWith(fakeSafeStorage())
        const stored = svc.encrypt(SECRET)

        expect(stored.startsWith('enc:v1:')).toBe(true)
        // The plaintext must NOT appear in the stored blob.
        expect(stored).not.toContain(SECRET)
        expect(svc.decrypt(stored)).toBe(SECRET)
    })

    it('produces valid base64 after the enc:v1: tag', () => {
        const svc = serviceWith(fakeSafeStorage())
        const stored = svc.encrypt('hello')
        const b64 = stored.slice('enc:v1:'.length)
        expect(b64).toMatch(/^[A-Za-z0-9+/]*={0,2}$/)
    })

    it('returns empty string for empty input (no key stays no key)', () => {
        const svc = serviceWith(fakeSafeStorage())
        expect(svc.encrypt('')).toBe('')
        expect(svc.decrypt('')).toBe('')
    })
})

describe('SecretStorageService raw fallback', () => {
    it('stores raw:v1: when no backend is available', () => {
        const svc = serviceWith(null)
        const stored = svc.encrypt(SECRET)

        expect(stored).toBe('raw:v1:' + SECRET)
        expect(svc.isEncryptionActive()).toBe(false)
        expect(svc.decrypt(stored)).toBe(SECRET)
    })

    it('stores raw:v1: when the backend reports unavailable', () => {
        const svc = serviceWith(fakeSafeStorage({ available: false }))
        const stored = svc.encrypt(SECRET)
        expect(stored).toBe('raw:v1:' + SECRET)
        expect(svc.decrypt(stored)).toBe(SECRET)
    })

    it('falls back to raw:v1: when encryptString unexpectedly throws', () => {
        const svc = serviceWith(fakeSafeStorage({ throwOnEncrypt: true }))
        const stored = svc.encrypt(SECRET)
        expect(stored).toBe('raw:v1:' + SECRET)
        expect(svc.decrypt(stored)).toBe(SECRET)
    })
})

describe('SecretStorageService tag parsing', () => {
    it('strips the raw:v1: tag on decrypt', () => {
        const svc = serviceWith(fakeSafeStorage())
        expect(svc.decrypt('raw:v1:plain-key')).toBe('plain-key')
    })

    it('returns untagged legacy values verbatim', () => {
        const svc = serviceWith(fakeSafeStorage())
        expect(svc.decrypt('legacy-plaintext-key')).toBe('legacy-plaintext-key')
    })

    it('returns empty for an enc:v1: blob when the backend is gone', () => {
        // Encrypt with a working backend, then decrypt with no backend.
        const enc = serviceWith(fakeSafeStorage()).encrypt(SECRET)
        expect(serviceWith(null).decrypt(enc)).toBe('')
    })

    it('returns empty for an enc:v1: blob that fails to decrypt', () => {
        const enc = serviceWith(fakeSafeStorage()).encrypt(SECRET)
        const svc = serviceWith(fakeSafeStorage({ throwOnDecrypt: true }))
        expect(svc.decrypt(enc)).toBe('')
    })
})
