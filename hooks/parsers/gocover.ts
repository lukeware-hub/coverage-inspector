import type { FileCoverage } from '../../types'

// Go's cover profile (`cover.out`, `-coverprofile`): a `mode:` line, then `file.go:1.2,3.4 stmts count` blocks.
// Every line of a block gets the block's count, the most any block gave it.
export function parseGoCover(text: string): FileCoverage[] {
  const lines = text.split(/\r?\n/)
  if (!lines[0]?.startsWith('mode:')) return []
  const files = new Map<string, Record<number, number>>()
  for (const line of lines.slice(1)) {
    const match = /^(.+):(\d+)\.\d+,(\d+)\.\d+ \d+ (\d+)$/.exec(line.trim())
    if (!match) continue
    const [, file, from, to, count] = match
    const hits = files.get(file!) ?? {}
    for (let at = Number(from); at <= Number(to) && at - Number(from) < 5000; at++) hits[at] = Math.max(hits[at] ?? 0, Number(count))
    files.set(file!, hits)
  }
  return [...files].map(([file, hits]) => ({ file, lines: hits }))
}
