/**
 * Unit tests for {@link NLCommandService}.
 *
 * Angular-free: the service is constructed directly with a stub
 * {@link AIProviderService}, so the pure prompt-building and output-sanitising
 * logic — plus the `generate()` happy path — are exercised without
 * bootstrapping Angular or hitting the network.
 */

import { describe, expect, it, vi } from 'vitest'

// `nl-command.service.ts` value-imports AIProviderService for Angular DI
// (its @Injectable decorator emits the type as runtime paramtype metadata),
// which would otherwise drag in Angular's partially-compiled JIT path
// (ConfigService -> @angular/common -> PlatformLocation) that vitest-node
// cannot bootstrap. Stub the module so importing the service stays Angular-free;
// the real class is never constructed here (we inject a plain stub below).
vi.mock('./ai-provider.service', () => ({ AIProviderService: class {} }))

import { NLCommandService } from './nl-command.service'
import type { AIProviderService } from './ai-provider.service'
import { AISettings, ChatRequest, DEFAULT_AI_SETTINGS } from '../providers'

/** Build a service backed by a stub AIProviderService. */
function makeService (opts: {
    settings?: Partial<AISettings>
    complete?: (req: ChatRequest) => Promise<string>
} = {}): { service: NLCommandService; lastRequest: () => ChatRequest | undefined } {
    const settings: AISettings = { ...DEFAULT_AI_SETTINGS, model: 'test-model', maxTokens: 321, ...opts.settings }
    let captured: ChatRequest | undefined
    const provider = {
        async complete (req: ChatRequest): Promise<string> {
            captured = req
            return opts.complete ? opts.complete(req) : 'echo hi'
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
    return { service: new NLCommandService(ai), lastRequest: () => captured }
}

describe('NLCommandService.extractCommand', () => {
    const { service } = makeService()

    it('returns an already-clean single command unchanged', () => {
        expect(service.extractCommand('ls -la')).toBe('ls -la')
    })

    it('strips a ```sh fenced code block', () => {
        const out = service.extractCommand('```sh\nfind . -name "*.ts"\n```')
        expect(out).toBe('find . -name "*.ts"')
    })

    it('strips a plain ``` fence with no language tag', () => {
        expect(service.extractCommand('```\ngit status\n```')).toBe('git status')
    })

    it('strips a leading "$ " shell prompt marker', () => {
        expect(service.extractCommand('$ npm test')).toBe('npm test')
    })

    it('strips a leading "PS>" PowerShell prompt marker', () => {
        expect(service.extractCommand('PS C:\\Users> Get-ChildItem')).toBe('Get-ChildItem')
    })

    it('drops a leading prose lead-in line', () => {
        const out = service.extractCommand('Here is the command:\ndocker ps -a')
        expect(out).toBe('docker ps -a')
    })

    it('drops a trailing explanation paragraph after the command', () => {
        const out = service.extractCommand(
            'rm -rf node_modules\nThis removes the installed dependencies so you can reinstall them cleanly.',
        )
        expect(out).toBe('rm -rf node_modules')
    })

    it('strips surrounding backticks', () => {
        expect(service.extractCommand('`pwd`')).toBe('pwd')
    })

    it('strips surrounding double quotes', () => {
        expect(service.extractCommand('"whoami"')).toBe('whoami')
    })

    it('does NOT unwrap quotes that are part of the command arguments', () => {
        // The outer-looking quotes belong to grep's pattern argument.
        expect(service.extractCommand('grep "foo bar" file.txt')).toBe('grep "foo bar" file.txt')
    })

    it('preserves a genuine multi-line command script', () => {
        const out = service.extractCommand('```bash\nmkdir build\ncd build\ncmake ..\n```')
        expect(out).toBe('mkdir build\ncd build\ncmake ..')
    })

    it('keeps pipes and operators intact on a single line', () => {
        const out = service.extractCommand('cat log.txt | grep ERROR | wc -l')
        expect(out).toBe('cat log.txt | grep ERROR | wc -l')
    })

    it('returns empty string for empty input', () => {
        expect(service.extractCommand('')).toBe('')
    })

    // --- Adversarial cases the docstring claims to handle (Bugs 1 & 2) ---

    it('does NOT strip a leading "#" comment as a prompt marker (Bug 1)', () => {
        // '# ' on an inner line is a real shell comment, not a root prompt; it
        // must survive verbatim instead of becoming an executable token.
        const out = service.extractCommand('```bash\n# build the project\nmake all\n```')
        expect(out).toBe('# build the project\nmake all')
    })

    it('keeps a "#" comment line in a fenced script intact', () => {
        const out = service.extractCommand('```sh\n# install deps\nnpm install\n```')
        expect(out).toBe('# install deps\nnpm install')
    })

    it('preserves a heredoc whose body reads like a sentence (Bug 2)', () => {
        const out = service.extractCommand('cat <<EOF > f.txt\nhello world this is a long line.\nEOF')
        expect(out).toBe('cat <<EOF > f.txt\nhello world this is a long line.\nEOF')
    })

    it('preserves an echo of a full sentence on its own line (Bug 2)', () => {
        const out = service.extractCommand('echo "A full sentence ends here today now."')
        expect(out).toBe('echo "A full sentence ends here today now."')
    })

    it('extracts the body of an unterminated fence (no closing ```)', () => {
        expect(service.extractCommand('```sh\nls -la')).toBe('ls -la')
    })

    it('prefers the fence body over a leading prose line', () => {
        expect(service.extractCommand('Here is the command:\n```\nls -la\n```')).toBe('ls -la')
    })

    it('does NOT unwrap single quotes that are part of the command (awk)', () => {
        // The single quotes belong to awk's program argument, and the line has a
        // pipe, so the whole command must be preserved unchanged.
        expect(service.extractCommand("awk '{print $1}' f | sort")).toBe("awk '{print $1}' f | sort")
    })
})

describe('NLCommandService.buildPrompt', () => {
    const { service } = makeService()

    it('system prompt mentions the shell and forbids prose/markdown', () => {
        const { system } = service.buildPrompt('list files', { shell: 'zsh' })
        expect(system).toContain('zsh')
        expect(system).toMatch(/only the command/i)
        expect(system).toMatch(/do not.*(markdown|fence)/i)
        expect(system).toMatch(/do not.*(prose|explanation)/i)
    })

    it('includes the shell line and recent output when present', () => {
        const { user } = service.buildPrompt('show errors', {
            shell: 'bash',
            recentOutput: 'error: something broke',
        })
        expect(user).toContain('Shell: bash')
        expect(user).toContain('Recent terminal output:')
        expect(user).toContain('error: something broke')
        expect(user).toContain('Request: show errors')
    })

    it('omits the recent-output section when it is absent or blank', () => {
        const { user } = service.buildPrompt('list files', { shell: 'bash', recentOutput: '   ' })
        expect(user).not.toContain('Recent terminal output:')
        expect(user).toContain('Shell: bash')
    })

    it('omits the Shell line when no shell is provided', () => {
        const { user, system } = service.buildPrompt('list files', {})
        expect(user).not.toContain('Shell:')
        // System still references a generic shell so the instruction is coherent.
        expect(system).toMatch(/shell/i)
    })
})

describe('NLCommandService.generate', () => {
    it('passes settings model/maxTokens + built prompt and extracts the command', async () => {
        const { service, lastRequest } = makeService({
            settings: { model: 'gpt-4o-mini', maxTokens: 222 },
            complete: async () => '```sh\nls -la\n```',
        })

        const result = await service.generate('list files in long format', { shell: 'bash' })

        expect(result).toBe('ls -la')
        const req = lastRequest()!
        expect(req.model).toBe('gpt-4o-mini')
        expect(req.maxTokens).toBe(222)
        expect(req.system).toMatch(/bash/i)
        expect(req.messages).toHaveLength(1)
        expect(req.messages[0].role).toBe('user')
        expect(req.messages[0].content).toContain('Request: list files in long format')
    })

    it('forwards an AbortSignal through to the provider request', async () => {
        const { service, lastRequest } = makeService({ complete: async () => 'pwd' })
        const controller = new AbortController()

        await service.generate('print working directory', {}, controller.signal)

        expect(lastRequest()!.signal).toBe(controller.signal)
    })
})
