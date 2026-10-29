import { afterEach, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const wrapper = resolve(import.meta.dir, '../bin/shepherdr-omp-review')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'omp-review-test-')); roots.push(root)
  const home = join(root, 'home'), bin = join(root, 'bin'), agent = join(home, '.omp/agent')
  mkdirSync(agent, { recursive: true }); mkdirSync(bin)
  const fake = join(bin, 'omp')
  writeFileSync(fake, `#!/usr/bin/env node
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2);
if (args[0] === 'config' && args[1] === 'get') {
  process.stdout.write(JSON.stringify({value: {default: 'openai-codex/gpt-6.1-terra'}}));
} else if (args[0] === 'auth' && args[1] === 'export') {
  fs.appendFileSync(process.env.LOG, 'export\\n');
  process.stdout.write(process.env.EXPORT || JSON.stringify({credentials: []}));
} else if (args[0] === 'auth' && args[1] === 'import') {
  let input = ''; process.stdin.on('data', x => input += x); process.stdin.on('end', () => {
    fs.writeFileSync(path.join(process.env.PI_CODING_AGENT_DIR, 'imported.json'), input);
  });
} else {
  const dir = process.env.PI_CODING_AGENT_DIR, models = path.join(dir, 'models.yml');
  const imported = path.join(dir, 'imported.json');
  const cfg = fs.readFileSync(args[args.indexOf('--config') + 1], 'utf8');
  process.stdout.write(JSON.stringify({args, cfg, home: process.env.HOME, dir,
    models: fs.existsSync(models) ? JSON.parse(fs.readFileSync(models, 'utf8')) : null,
    imported: fs.existsSync(imported) ? JSON.parse(fs.readFileSync(imported, 'utf8')) : null,
    globalMcpExists: fs.existsSync(path.join(dir, 'mcp.json')),
    secretInherited: !!process.env.UNRELATED_SECRET}));
}
`)
  chmodSync(fake, 0o755)
  const log = join(root, 'log')
  function run(model: string | null = 'openai-codex/gpt-6.1-terra', credential?: object) {
    return spawnSync(wrapper, [...(model ? ['--model', model] : []), '--thinking', 'high', '--', 'review this diff'], {
      cwd: root, encoding: 'utf8', env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: agent,
        PATH: `${bin}:${process.env.PATH}`, LOG: log, UNRELATED_SECRET: 'do-not-copy',
        EXPORT: JSON.stringify({ credentials: credential ? [credential] : [] }) },
    })
  }
  return { root, home, agent, log, run }
}

const yaml = `providers:
  openai-codex:
    baseUrl: https://gateway.example.test:8776
    apiKey: test-bearer-value
    transport: pi-native
    api: openai-codex-responses
    models:
      - id: gpt-6.1-terra
        name: GPT-6.1 Terra
        reasoning: true
        input: [text, image]
        contextWindow: 272000
        maxTokens: 128000
      - id: other
        name: Other
  other:
    apiKey: unrelated-secret
`

describe('headless OMP reviewer', () => {
  test('isolates a YAML gateway with only the selected model and no auth export', () => {
    const f = fixture(); writeFileSync(join(f.agent, 'models.yml'), yaml)
    writeFileSync(join(f.agent, 'mcp.json'), '{"servers":{"global":{"command":"should-not-run"}}}')
    writeFileSync(join(f.root, '.mcp.json'), '{"servers":{"project":{"command":"should-not-run"}}}')
    const result = f.run(); expect(result.status).toBe(0)
    const run = JSON.parse(result.stdout)
    expect(Object.keys(run.models.providers)).toEqual(['openai-codex'])
    expect(run.models.providers['openai-codex']).toEqual({ transport: 'pi-native', baseUrl: 'https://gateway.example.test:8776', apiKey: 'test-bearer-value', api: 'openai-codex-responses', models: [{ id: 'gpt-6.1-terra', name: 'GPT-6.1 Terra', reasoning: true, input: ['text', 'image'], contextWindow: 272000, maxTokens: 128000 }] })
    expect(run.imported).toBeNull(); expect(existsSync(f.log)).toBe(false)
    expect(run.secretInherited).toBe(false); expect(run.home).not.toBe(f.home)
    expect(run.globalMcpExists).toBe(false)
    expect(run.cfg).toContain('enableProjectConfig: false')
    expect(run.args).toContain('--no-extensions'); expect(run.args[run.args.indexOf('--tools') + 1]).toBe('read,grep,glob')
    expect(run.args[run.args.indexOf('--session-dir') + 1]).toBe(join(f.agent, 'sessions/reviewers'))
    expect(run.args[run.args.indexOf('--thinking') + 1]).toBe('high')
    expect(run.args.at(-1)).toBe('review this diff')
    expect(existsSync(run.home)).toBe(false)
  })
  test('resolves the default model before entering the private home', () => {
    const f = fixture(); writeFileSync(join(f.agent, 'models.yml'), yaml)
    const result = f.run(null); expect(result.status).toBe(0)
    const args = JSON.parse(result.stdout).args
    expect(args[args.indexOf('--model') + 1]).toBe('openai-codex/gpt-6.1-terra')
  })
  test('accepts the isolated JSON models format', () => {
    const f = fixture(); writeFileSync(join(f.agent, 'models.yml'), JSON.stringify({ providers: { 'openai-codex': { baseUrl: 'https://gateway.example.test', apiKey: 'test-bearer', transport: 'pi-native', api: 'openai-codex-responses', models: [{ id: 'gpt-6.1-terra' }] } } }))
    const result = f.run(); expect(result.status).toBe(0); expect(JSON.parse(result.stdout).models.providers['openai-codex'].apiKey).toBe('test-bearer')
  })
  test('reads the supported private !cat reference without executing a command', () => {
    const f = fixture()
    chmodSync(join(f.home, '.omp'), 0o775)
    const secret = join(f.home, '.omp', 'gateway-token')
    writeFileSync(secret, 'file-bearer-value\n', { mode: 0o600 })
    writeFileSync(join(f.agent, 'models.yml'), yaml.replace('test-bearer-value', '!cat ~/.omp/gateway-token'))
    const result = f.run(); expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).models.providers['openai-codex'].apiKey).toBe('file-bearer-value')
    expect(existsSync(f.log)).toBe(false)
  })
  test('rejects insecure files, symlinks and traversal in !cat references', () => {
    const f = fixture(), secret = join(f.home, 'gateway-token'), config = join(f.agent, 'models.yml')
    writeFileSync(secret, 'file-bearer-value', { mode: 0o644 })
    writeFileSync(config, yaml.replace('test-bearer-value', '!cat ~/gateway-token'))
    let result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('private user-owned regular file')
    chmodSync(secret, 0o600)
    symlinkSync(secret, join(f.home, 'linked-token'))
    writeFileSync(config, yaml.replace('test-bearer-value', '!cat ~/linked-token'))
    result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('private user-owned regular file')
    symlinkSync(f.agent, join(f.home, 'linked-dir'))
    writeFileSync(config, yaml.replace('test-bearer-value', '!cat ~/linked-dir/models.yml'))
    result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('without symlinks')
    writeFileSync(config, yaml.replace('test-bearer-value', '!cat ~/../gateway-token'))
    result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain('must stay under HOME')
    expect(result.stderr).not.toContain('file-bearer-value'); expect(existsSync(f.log)).toBe(false)
  })
  test.each([
    [yaml.replace('https://gateway.example.test:8776', 'http://gateway.example.test'), 'safe HTTPS'],
    [yaml.replace('test-bearer-value', '!command steal'), 'safely parse'],
    [yaml.replace('test-bearer-value', 'GATEWAY_TOKEN'), 'literal bearer'],
    [yaml.replace('gpt-6.1-terra', 'another-model'), 'explicit selected model'],
    [yaml.replace('api: openai-codex-responses', 'api: other'), 'openai-codex-responses'],
    [yaml.replace('transport: pi-native', 'transport: pi-native\n    transport: pi-native'), 'Duplicate models.yml key'],
  ])('rejects unsafe or unsupported gateway config', (config, reason) => {
    const f = fixture(); writeFileSync(join(f.agent, 'models.yml'), config)
    const result = f.run(); expect(result.status).not.toBe(0); expect(result.stderr).toContain(reason)
    expect(result.stderr).not.toContain('test-bearer-value'); expect(existsSync(f.log)).toBe(false)
  })
  test('keeps API key import and refuses OAuth', () => {
    const f = fixture()
    const key = { provider: 'example', credential: { type: 'api_key', key: 'selected-key' } }
    const result = f.run('example/model', key); expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout).imported.credentials).toEqual([key])
    expect(readFileSync(f.log, 'utf8')).toBe('export\n')
    const oauth = f.run('example/model', { provider: 'example', credential: { type: 'oauth', refresh: 'not-copied' } })
    expect(oauth.status).not.toBe(0); expect(oauth.stderr).toContain('OAuth credentials cannot be safely copied')
    expect(oauth.stderr).not.toContain('not-copied')
  })
})
