import { Database } from 'bun:sqlite'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Import only credentials for the explicitly selected OMP providers, never its settings database. */
export function ompCredentials(home: string, models: (string | undefined)[]) {
  const config = join(home, '.omp/agent/config.yml')
  const parsed = existsSync(config) ? Bun.YAML.parse(readFileSync(config, 'utf8')) as { modelRoles?: { default?: unknown } } : {}
  const fallback = typeof parsed?.modelRoles?.default === 'string' ? parsed.modelRoles.default : undefined
  const selected = models.map((m) => m || fallback)
  if (!selected.length || selected.some((m) => !m || !/^[\w.-]+\/[^/\s]+$/.test(m))) throw new Error('OMP isolation requires a fully qualified provider/model or an OMP default model.')
  const providers = new Set(selected.map((m) => m!.split('/')[0]))
  const source = join(home, '.omp/agent/agent.db')
  if (!existsSync(source)) throw new Error('OMP isolation requires stored provider credentials in ~/.omp/agent/agent.db.')
  const db = new Database(source, { readonly: true })
  try {
    db.exec('BEGIN')
    const rows = db.query('SELECT rowid AS id, provider, credential_type FROM auth_credentials WHERE disabled_cause IS NULL').all() as { id: number; provider: string; credential_type: string }[]
    const selectedRows = rows.filter((r) => providers.has(r.provider))
    for (const provider of providers) {
      const matches = selectedRows.filter((r) => r.provider === provider)
      if (!matches.length) throw new Error(`OMP isolation has no stored credentials for provider ${provider}. Store an API key for this provider in OMP.`)
      if (matches.length > 1) throw new Error(`OMP isolation cannot safely select among multiple credentials for provider ${provider}. Leave one enabled API key.`)
      if (matches[0].credential_type !== 'api_key') throw new Error(`OMP isolation cannot copy OAuth or other non-API-key credentials for provider ${provider}; store an API key instead. OAuth refresh tokens may be rotated and invalidate the host login.`)
    }
    const data = db.query<{ data: string }, [number]>('SELECT data FROM auth_credentials WHERE rowid = ?')
    const credentials = selectedRows.map((r) => {
      const row = data.get(r.id)
      if (!row || typeof row.data !== 'string') throw new Error(`OMP isolation cannot read the API key for provider ${r.provider}.`)
      const value: unknown = JSON.parse(row.data)
      if (!value || typeof value !== 'object' || !('key' in value) || typeof value.key !== 'string' || !value.key) throw new Error(`OMP isolation cannot read the API key for provider ${r.provider}.`)
      return { provider: r.provider, credential: { type: 'api_key', key: value.key, ...('source' in value && typeof value.source === 'string' ? { source: value.source } : {}) } }
    })
    return { model: selected[0]!, models: selected as string[], credentials: JSON.stringify({ version: 1, credentials }) }
  } finally { db.close() }
}
