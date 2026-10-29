import { Database } from 'bun:sqlite'
import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export interface OmpGateway { host: string; port: number }
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value)

/** Resolve only a literal, an environment name, or a single home-relative file read; never run a command. */
export function gatewayBearer(home: string, reference: string) {
  let value = reference
  if (reference.startsWith('!')) {
    const match = /^!cat ~\/([A-Za-z0-9._/-]+)$/.exec(reference)
    if (!match || match[1].split('/').some((part) => !part || part === '.' || part === '..')) throw new Error('OMP isolation only supports a single home-relative gateway bearer file.')
    const descriptors: number[] = []
    try {
      let parent = openSync(home, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      descriptors.push(parent)
      const parts = match[1].split('/')
      for (const [index, part] of parts.entries()) {
        const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | (index < parts.length - 1 ? constants.O_DIRECTORY : 0)
        parent = openSync(`/proc/self/fd/${parent}/${part}`, flags)
        descriptors.push(parent)
      }
      const stat = fstatSync(parent)
      if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error('Unsafe file')
      value = readFileSync(parent, 'utf8').trim()
    } catch {
      throw new Error('OMP isolation cannot safely read the gateway bearer file; it must be a private user-owned regular file without symlinks.')
    } finally {
      for (const fd of descriptors.reverse()) closeSync(fd)
    }
  } else if (/^[A-Z_][A-Z0-9_]*$/.test(reference)) {
    value = process.env[reference] ?? ''
  }
  if (!/^[A-Za-z0-9._~+\/=-]+$/.test(value) || /^[A-Z_][A-Z0-9_]*$/.test(value)) throw new Error('OMP isolation requires a literal gateway bearer or a safely resolved bearer reference.')
  return value
}

/** Import only credentials for the explicitly selected OMP providers, never its settings database. */
export function ompCredentials(home: string, models: (string | undefined)[]) {
  const dir = join(home, '.omp/agent')
  const config = join(dir, 'config.yml')
  const parsed = existsSync(config) ? Bun.YAML.parse(readFileSync(config, 'utf8')) as { modelRoles?: { default?: unknown } } : {}
  const fallback = typeof parsed?.modelRoles?.default === 'string' ? parsed.modelRoles.default : undefined
  const selected = models.map((m) => m || fallback)
  if (!selected.length || selected.some((m) => !m || !/^[\w.-]+\/[^/\s]+$/.test(m))) throw new Error('OMP isolation requires a fully qualified provider/model or an OMP default model.')
  const providers = new Set(selected.map((m) => m!.split('/')[0]))
  const modelsFile = join(dir, 'models.yml')
  const sourceConfig = existsSync(modelsFile) ? Bun.YAML.parse(readFileSync(modelsFile, 'utf8')) : undefined
  if (sourceConfig !== undefined && (!object(sourceConfig) || !object(sourceConfig.providers))) throw new Error('OMP isolation cannot read the provider models configuration.')
  const configured = object(sourceConfig) && object(sourceConfig.providers) ? sourceConfig.providers : {}
  const isolated: Record<string, unknown> = {}
  const gateways: OmpGateway[] = []
  for (const provider of providers) {
    const entry = configured[provider]
    if (entry === undefined) continue
    if (!object(entry) || entry.transport !== 'pi-native') throw new Error(`OMP isolation does not support the configured provider ${provider}; only explicit pi-native gateways are supported.`)
    if (typeof entry.baseUrl !== 'string' || typeof entry.apiKey !== 'string' || entry.api !== 'openai-codex-responses') throw new Error(`OMP isolation requires an HTTPS pi-native gateway with a supported API and bearer for provider ${provider}.`)
    let url: URL
    try { url = new URL(entry.baseUrl) } catch { throw new Error(`OMP isolation has an invalid gateway URL for provider ${provider}.`) }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !/^[a-z0-9-]+\.[a-z0-9-]+\.ts\.net$/.test(url.hostname) || url.pathname !== '/') throw new Error(`OMP isolation requires a Tailscale HTTPS gateway origin for provider ${provider}.`)
    const apiKey = gatewayBearer(home, entry.apiKey)
    if (!Array.isArray(entry.models)) throw new Error(`OMP isolation requires explicit models for gateway provider ${provider}.`)
    const wanted = selected.filter((m) => m!.startsWith(`${provider}/`)).map((m) => m!.slice(provider.length + 1))
    const modelList = wanted.map((id) => {
      const matches = (entry.models as unknown[]).filter((m) => object(m) && m.id === id)
      if (matches.length !== 1 || !object(matches[0])) throw new Error(`OMP isolation requires exactly one explicit gateway model ${provider}/${id}.`)
      const model = matches[0]
      // These are model metadata only, not provider headers, credential resolvers or commands.
      const result: Record<string, unknown> = { id }
      for (const key of ['name', 'reasoning', 'contextWindow', 'maxTokens', 'supportsTools']) {
        const value = model[key]
        if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') result[key] = value
      }
      if (Array.isArray(model.input) && model.input.every((v) => typeof v === 'string')) result.input = model.input
      if (object(model.cost)) result.cost = Object.fromEntries(Object.entries(model.cost).filter(([k, v]) => ['input', 'output', 'cacheRead', 'cacheWrite'].includes(k) && typeof v === 'number'))
      return result
    })
    isolated[provider] = { transport: 'pi-native', baseUrl: entry.baseUrl, apiKey, api: entry.api, models: modelList }
    gateways.push({ host: url.hostname, port: Number(url.port || 443) })
  }
  const storedProviders = new Set([...providers].filter((p) => !(p in isolated)))
  const source = join(dir, 'agent.db')
  if (storedProviders.size && !existsSync(source)) throw new Error('OMP isolation requires stored provider credentials in ~/.omp/agent/agent.db.')
  const credentials: { provider: string; credential: { type: string; key: string; source?: string } }[] = []
  if (storedProviders.size) {
    const db = new Database(source, { readonly: true })
    try {
      db.exec('BEGIN')
      const rows = db.query('SELECT rowid AS id, provider, credential_type FROM auth_credentials WHERE disabled_cause IS NULL').all() as { id: number; provider: string; credential_type: string }[]
      const selectedRows = rows.filter((r) => storedProviders.has(r.provider))
      for (const provider of storedProviders) {
        const matches = selectedRows.filter((r) => r.provider === provider)
        if (!matches.length) throw new Error(`OMP isolation has no stored credentials for provider ${provider}. Store an API key for this provider in OMP.`)
        if (matches.length > 1) throw new Error(`OMP isolation cannot safely select among multiple credentials for provider ${provider}. Leave one enabled API key.`)
        if (matches[0].credential_type !== 'api_key') throw new Error(`OMP isolation cannot copy OAuth or other non-API-key credentials for provider ${provider}; store an API key instead. OAuth refresh tokens may be rotated and invalidate the host login.`)
      }
      const data = db.query<{ data: string }, [number]>('SELECT data FROM auth_credentials WHERE rowid = ?')
      for (const r of selectedRows) {
        const row = data.get(r.id)
        if (!row || typeof row.data !== 'string') throw new Error(`OMP isolation cannot read the API key for provider ${r.provider}.`)
        const value: unknown = JSON.parse(row.data)
        if (!object(value) || typeof value.key !== 'string' || !value.key) throw new Error(`OMP isolation cannot read the API key for provider ${r.provider}.`)
        credentials.push({ provider: r.provider, credential: { type: 'api_key', key: value.key, ...(typeof value.source === 'string' ? { source: value.source } : {}) } })
      }
    } finally { db.close() }
  }
  return { model: selected[0]!, models: selected as string[], credentials: JSON.stringify({ version: 1, credentials }), hasCredentials: credentials.length > 0, modelsConfig: JSON.stringify({ providers: isolated }), gateways }
}
