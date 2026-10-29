// Every transcript in the private runtime homes, including native helpers, headless reviewers and cross-harness
// children. Updates reuse the existing harness readers; duplicate usage ids count once, and totals never decrease.
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { privateRuntimePath } from './autopilot-sandbox.ts'
import { HOME } from '../store.ts'
import { LogTail, readerFor } from './readers/index.ts'
import type { Reader, LogEvent } from './readers/types.ts'

function usageReader(kind: string): Reader {
  const base = readerFor(kind)!
  if (kind !== 'omp') return base
  return {
    cli: kind,
    reset: (file) => base.reset?.(file),
    parse(lines, file) {
      const events = base.parse(lines, file)
      for (const { text, offset } of lines) {
        try {
          const entry = JSON.parse(text)
          if (entry.type !== 'model_usage') continue
          const u = entry.usage
          const tokens = typeof u?.totalTokens === 'number' ? u.totalTokens : (u?.input ?? 0) + (u?.output ?? 0) + (u?.cacheRead ?? 0) + (u?.cacheWrite ?? 0)
          if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) events.push({ kind: 'usage', id: `model-usage-${entry.id ?? offset}`, at: Date.parse(entry.timestamp ?? '') || 0, tokens } as LogEvent)
        } catch { /* incomplete or malformed record */ }
      }
      return events
    },
  }
}
export class PilotUsage {
  private tails = new Map<string, LogTail>()
  private usage = new Map<string, Map<string, number>>()
  tokens(run: string) {
    const root = join(HOME, 'autopilot-runtime', run)
    if (!existsSync(root)) return 0
    const values = this.usage.get(run) ?? new Map<string, number>()
    this.usage.set(run, values)
    for (const file of new Bun.Glob('*/captures/**/*.jsonl').scanSync({ cwd: root, dot: true, absolute: true, onlyFiles: true })) {
      if (!privateRuntimePath(root, file)) continue
      const kind = file.includes('/.claude/') ? 'claude' : file.includes('/.codex/') ? 'codex' : file.includes('/.omp/') ? 'omp' : 'pi'
      let tail = this.tails.get(file)
      if (!tail) { tail = new LogTail(file, usageReader(kind)); this.tails.set(file, tail) }
      for (const event of tail.read(256 * 1024)) if (event.kind === 'usage') values.set(`${kind}:${file}:${event.id}`, Math.max(values.get(`${kind}:${file}:${event.id}`) ?? 0, event.tokens))
    }
    return [...values.values()].reduce((n, x) => n + x, 0)
  }
}
