import type { FileCoverage } from '../../types'

// LCOV (`lcov.info`): written by lcov, c8, nyc, vitest, jest, Dart, Rust llvm-cov, gcov and many more.
// SF: file, DA:line,hits, BRDA:line,block,branch,taken, FNF/FNH functions found and hit, end_of_record.
export function parseLcov(text: string): FileCoverage[] {
  const files: FileCoverage[] = []
  let current: FileCoverage | undefined
  let branches = { covered: 0, total: 0 }
  let functions = { covered: 0, total: 0 }
  let hasFunctionTotals = false
  const flush = () => {
    if (!current) return
    if (branches.total) current.branches = branches
    if (hasFunctionTotals) current.functions = functions
    files.push(current)
    current = undefined
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('SF:')) {
      flush()
      current = { file: line.slice(3), lines: {} }
      branches = { covered: 0, total: 0 }
      functions = { covered: 0, total: 0 }
      hasFunctionTotals = false
    } else if (!current) {
      continue
    } else if (line.startsWith('DA:')) {
      const [number, hits] = line.slice(3).split(',')
      const at = Number(number)
      if (Number.isInteger(at)) current.lines![at] = Math.max(current.lines![at] ?? 0, Number(hits) || 0)
    } else if (line.startsWith('BRDA:')) {
      const taken = line.slice(5).split(',')[3]
      branches.total++
      if (taken !== undefined && taken !== '-' && Number(taken) > 0) branches.covered++
    } else if (line.startsWith('FNF:')) {
      functions.total = Number(line.slice(4)) || 0
      hasFunctionTotals = true
    } else if (line.startsWith('FNH:')) {
      functions.covered = Number(line.slice(4)) || 0
    } else if (line === 'end_of_record') {
      flush()
    }
  }
  flush()
  return files
}
