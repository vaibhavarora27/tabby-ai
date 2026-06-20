/**
 * Unit tests for {@link ErrorExplainerService}.
 *
 * Angular-free: the service is constructed directly with a stub
 * {@link AIProviderService}, exercising the pure policy / prompt-building /
 * parsing logic plus the `explain()` happy path without Angular or the network.
 */

import { describe, expect, it } from 'vitest'

// Same rationale as nl-command.service.test.ts: value-importing the real
// AIProviderService would drag Angular's JIT path into vitest-node. Stub the
// module so importing the service stays Angular-free; we inject a plain stub.
import { vi } from 'vitest'
vi.mock('./ai-provider.service', () => ({ AIProviderService: class {} }))

import { ErrorExplainerService } from './error-explainer.service'
import type { AIProviderService } from './ai-provider.service'
import { AISettings, ChatRequest, DEFAULT_AI_SETTINGS } from '../providers'

function makeService (opts: {
    settings?: Partial<AISettings>
    complete?: (req: ChatRequest) => Promise<string>
} = {}): { service: ErrorExplainerService; lastRequest: () => ChatRequest | undefined } {
    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, model: 'test-model', maxTokens: 321, ...opts.settings }
    let captured: ChatRequest | undefined
    const provider = {
        async complete (req: ChatRequest): Promise<string> {
            captured = req
            return opts.complete ? opts.complete(req) : 'It failed.'
        },
        stream (): AsyncIterable<string> {
            throw new Error('not used')
        },
        async testConnection (): Promise<{ ok: boolean }> {
            return { ok: true }
        },
    }
    const ai = {
        getSettings: () => settings,
        getProvider: () => provider,
    } as unknown as AIProviderService
    return { service: new ErrorExplainerService(ai), lastRequest: () => captured }
}

describe('ErrorExplainerService.shouldExplain', () => {
    const { service } = makeService()

    it('explains a generic non-zero exit code', () => {
        expect(service.shouldExplain(1)).toBe(true)
        expect(service.shouldExplain(127)).toBe(true)
        expect(service.shouldExplain(255)).toBe(true)
    })

    it('never explains exit code 0', () => {
        expect(service.shouldExplain(0)).toBe(false)
    })

    it('does not explain Ctrl-C (130)', () => {
        expect(service.shouldExplain(130)).toBe(false)
    })

    it('does not explain stop codes 146 and 148', () => {
        expect(service.shouldExplain(146)).toBe(false)
        expect(service.shouldExplain(148)).toBe(false)
    })

    it('rejects non-finite exit codes', () => {
        expect(service.shouldExplain(NaN)).toBe(false)
        expect(service.shouldExplain(Infinity)).toBe(false)
    })
})

describe('ErrorExplainerService.parseExplanation', () => {
    const { service } = makeService()

    it('returns just the explanation when there is no FIX line', () => {
        const parsed = service.parseExplanation('The file does not exist.')
        expect(parsed.explanation).toBe('The file does not exist.')
        expect(parsed.fix).toBeUndefined()
    })

    it('splits a trailing FIX: line from the explanation', () => {
        const parsed = service.parseExplanation(
            'The package is not installed.\nFIX: npm install left-pad',
        )
        expect(parsed.explanation).toBe('The package is not installed.')
        expect(parsed.fix).toBe('npm install left-pad')
    })

    it('is case-insensitive about the FIX: prefix', () => {
        const parsed = service.parseExplanation('Missing dir.\nfix: mkdir build')
        expect(parsed.fix).toBe('mkdir build')
    })

    it('strips wrapping backticks from the fix command', () => {
        const parsed = service.parseExplanation('Bad.\nFIX: `git pull --rebase`')
        expect(parsed.fix).toBe('git pull --rebase')
    })

    it('strips a single pair of surrounding quotes from the fix', () => {
        const parsed = service.parseExplanation('Bad.\nFIX: "rm -rf build"')
        expect(parsed.fix).toBe('rm -rf build')
    })

    it('keeps quotes that are part of the fix arguments', () => {
        const parsed = service.parseExplanation('Bad.\nFIX: grep "foo bar" file')
        expect(parsed.fix).toBe('grep "foo bar" file')
    })

    it('treats an empty FIX: line as no fix', () => {
        const parsed = service.parseExplanation('Just an explanation.\nFIX:')
        expect(parsed.fix).toBeUndefined()
        expect(parsed.explanation).toBe('Just an explanation.')
    })

    it('uses only the first FIX: line and keeps later text as explanation', () => {
        const parsed = service.parseExplanation('A.\nFIX: do-thing\nB explanation continues')
        expect(parsed.fix).toBe('do-thing')
        expect(parsed.explanation).toBe('A.\nB explanation continues')
    })

    it('falls back to a generic explanation when only a fix is present', () => {
        const parsed = service.parseExplanation('FIX: chmod +x run.sh')
        expect(parsed.fix).toBe('chmod +x run.sh')
        expect(parsed.explanation.length).toBeGreaterThan(0)
    })

    it('handles empty model output', () => {
        const parsed = service.parseExplanation('')
        expect(parsed.explanation).toBe('')
        expect(parsed.fix).toBeUndefined()
    })

    it('normalises CRLF line endings', () => {
        const parsed = service.parseExplanation('Line one.\r\nFIX: echo ok')
        expect(parsed.explanation).toBe('Line one.')
        expect(parsed.fix).toBe('echo ok')
    })
})

describe('ErrorExplainerService.buildPrompt', () => {
    const { service } = makeService()

    it('system prompt fixes the FIX: contract and the shell name', () => {
        const { system } = service.buildPrompt('npm run build', 'error', 'zsh')
        expect(system).toContain('zsh')
        expect(system).toMatch(/fix:/i)
        expect(system).toMatch(/non-zero/i)
    })

    it('includes the failed command, output, and shell line', () => {
        const { user } = service.buildPrompt('cat missing.txt', 'No such file', 'bash')
        expect(user).toContain('Shell: bash')
        expect(user).toContain('Failed command:')
        expect(user).toContain('cat missing.txt')
        expect(user).toContain('Output:')
        expect(user).toContain('No such file')
    })

    it('notes when there was no captured output', () => {
        const { user } = service.buildPrompt('false', '   ', 'bash')
        expect(user).toMatch(/no captured output/i)
    })

    it('omits the Shell line when no shell is provided', () => {
        const { user } = service.buildPrompt('false', 'boom')
        expect(user).not.toContain('Shell:')
    })

    it('truncates very large output to the tail', () => {
        const big = 'HEAD-MARKER\n' + 'x'.repeat(8000) + '\nTAIL-MARKER'
        const { user } = service.buildPrompt('cmd', big, 'bash')
        expect(user).toContain('TAIL-MARKER')
        expect(user).not.toContain('HEAD-MARKER')
        expect(user).toMatch(/truncated/i)
    })
})

describe('ErrorExplainerService.explain', () => {
    it('passes settings model/maxTokens + built prompt and parses the result', async () => {
        const { service, lastRequest } = makeService({
            settings: { model: 'gpt-4o-mini', maxTokens: 222 },
            complete: async () => 'The directory is missing.\nFIX: mkdir -p out',
        })

        const result = await service.explain('cp a out/a', 'No such file or directory', 1, 'bash')

        expect(result.exitCode).toBe(1)
        expect(result.explanation).toBe('The directory is missing.')
        expect(result.fix).toBe('mkdir -p out')

        const req = lastRequest()!
        expect(req.model).toBe('gpt-4o-mini')
        expect(req.maxTokens).toBe(222)
        expect(req.system).toMatch(/bash/i)
        expect(req.messages).toHaveLength(1)
        expect(req.messages[0].role).toBe('user')
        expect(req.messages[0].content).toContain('Failed command:')
    })

    it('forwards an AbortSignal to the provider request', async () => {
        const { service, lastRequest } = makeService({ complete: async () => 'x' })
        const controller = new AbortController()

        await service.explain('false', 'boom', 1, 'bash', controller.signal)

        expect(lastRequest()!.signal).toBe(controller.signal)
    })
})
