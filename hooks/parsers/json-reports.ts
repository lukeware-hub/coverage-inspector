import type { FileCoverage, Totals } from '../../types'

type Json = Record<string, unknown>

const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const number = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0)

function totals(value: unknown): Totals | undefined {
  if (!isObject(value)) return undefined
  const total = number(value.total)
  return total ? { covered: number(value.covered), total } : undefined
}

// Istanbul / nyc / c8 / vitest `coverage-final.json`: per file, statements (s) with their locations, functions (f) and
// branches (b). A line counts as hit when any statement that starts on it ran.
export function parseIstanbulFinal(json: unknown): FileCoverage[] {
  if (!isObject(json)) return []
  const files: FileCoverage[] = []
  for (const [key, value] of Object.entries(json)) {
    if (!isObject(value) || !isObject(value.statementMap) || !isObject(value.s)) continue
    const lines: Record<number, number> = {}
    for (const [id, where] of Object.entries(value.statementMap)) {
      const start = isObject(where) && isObject(where.start) ? number(where.start.line) : 0
      if (start) lines[start] = Math.max(lines[start] ?? 0, number((value.s as Json)[id]))
    }
    const functionHits = isObject(value.f) ? Object.values(value.f).map(number) : []
    const branchHits = isObject(value.b) ? Object.values(value.b).flatMap(list => (Array.isArray(list) ? list.map(number) : [])) : []
    files.push({
      file: typeof value.path === 'string' ? value.path : key,
      lines,
      functions: functionHits.length ? { covered: functionHits.filter(hits => hits > 0).length, total: functionHits.length } : undefined,
      branches: branchHits.length ? { covered: branchHits.filter(hits => hits > 0).length, total: branchHits.length } : undefined,
    })
  }
  return files
}

// Istanbul `coverage-summary.json`: totals only, per file and for the whole run ("total" is skipped, the files are summed).
export function parseIstanbulSummary(json: unknown): FileCoverage[] {
  if (!isObject(json)) return []
  const files: FileCoverage[] = []
  for (const [key, value] of Object.entries(json)) {
    if (key === 'total' || !isObject(value)) continue
    files.push({ file: key, linesTotal: totals(value.lines), branches: totals(value.branches), functions: totals(value.functions) })
  }
  return files
}

// coverage.py `coverage json`: executed_lines and missing_lines per file, with a summary for branches.
export function parseCoveragePy(json: unknown): FileCoverage[] {
  if (!isObject(json) || !isObject(json.files)) return []
  const files: FileCoverage[] = []
  for (const [key, value] of Object.entries(json.files)) {
    if (!isObject(value)) continue
    const lines: Record<number, number> = {}
    for (const at of Array.isArray(value.missing_lines) ? value.missing_lines : []) lines[number(at)] = 0
    for (const at of Array.isArray(value.executed_lines) ? value.executed_lines : []) lines[number(at)] = 1
    const summary = isObject(value.summary) ? value.summary : {}
    const total = number(summary.num_branches)
    files.push({ file: key, lines, branches: total ? { covered: number(summary.covered_branches), total } : undefined })
  }
  return files
}

// Which JSON report this is, by its shape; undefined when it is none of the known ones.
export function parseJsonCoverage(json: unknown): FileCoverage[] | undefined {
  if (!isObject(json)) return undefined
  if (isObject(json.files) && isObject(json.meta)) return parseCoveragePy(json)
  if (isObject(json.total) && 'lines' in json.total) return parseIstanbulSummary(json)
  const first = Object.values(json)[0]
  if (isObject(first) && 'statementMap' in first) return parseIstanbulFinal(json)
  return undefined
}
