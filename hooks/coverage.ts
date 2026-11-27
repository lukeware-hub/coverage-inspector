import type { FileCoverage, PatchCoverage, Percentages, Totals } from '../types'

// Paths as one spelling: forward slashes, no leading "./", lower case only matters on Windows so it is not touched.
export function normalize(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

// Two paths name the same file when one is the end of the other on a folder boundary: reports hold paths relative to
// different roots (the project, a package, a Java source folder, a Go import path).
export function samePath(a: string, b: string): boolean {
  const [x, y] = [normalize(a).toLowerCase(), normalize(b).toLowerCase()]
  if (x === y) return true
  const [long, short] = x.length >= y.length ? [x, y] : [y, x]
  return long.endsWith(`/${short}`)
}

const addTotals = (a: Totals | undefined, b: Totals | undefined): Totals | undefined => (a && b ? { covered: a.covered + b.covered, total: a.total + b.total } : (a ?? b))

// Reports of one run often overlap (a tool writes lcov and cobertura both, a monorepo writes one per package): the same
// file is merged, taking the best hit count of each line, so nothing is counted twice.
export function mergeCoverage(reports: readonly FileCoverage[]): FileCoverage[] {
  const merged: FileCoverage[] = []
  for (const report of reports) {
    const same = merged.find(one => samePath(one.file, report.file))
    if (!same) {
      merged.push({ ...report, lines: report.lines ? { ...report.lines } : undefined })
      continue
    }
    if (report.lines) {
      same.lines ??= {}
      for (const [at, hits] of Object.entries(report.lines)) same.lines[Number(at)] = Math.max(same.lines[Number(at)] ?? 0, hits)
    }
    same.linesTotal ??= report.linesTotal
    // Branch and function totals of two reports of one file describe the same code: the larger report wins, they are not added.
    if (!same.branches || (report.branches && report.branches.total > same.branches.total)) same.branches = report.branches ?? same.branches
    if (!same.functions || (report.functions && report.functions.total > same.functions.total)) same.functions = report.functions ?? same.functions
  }
  return merged
}

function lineTotals(file: FileCoverage): Totals | undefined {
  if (file.lines) {
    const hits = Object.values(file.lines)
    return { covered: hits.filter(count => count > 0).length, total: hits.length }
  }
  return file.linesTotal
}

const percent = (totals: Totals | undefined): number | undefined => (totals?.total ? Math.round((totals.covered / totals.total) * 1000) / 10 : undefined)

// Lines, branches and functions as percentages over every file; a figure no report carries is left out.
export function summarize(files: readonly FileCoverage[]): Percentages {
  let [lines, branches, functions]: (Totals | undefined)[] = [undefined, undefined, undefined]
  for (const file of files) {
    lines = addTotals(lines, lineTotals(file))
    branches = addTotals(branches, file.branches)
    functions = addTotals(functions, file.functions)
  }
  return { lines: percent(lines), branches: percent(branches), functions: percent(functions) }
}

// The lines a `git diff -U0` added, per file: `+++ b/src/a.ts` then `@@ -1,2 +3,4 @@` hunks.
export function parseChangedLines(diff: string): Map<string, Set<number>> {
  const changed = new Map<string, Set<number>>()
  let file: string | undefined
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      const path = line.slice(4).trim()
      file = path === '/dev/null' ? undefined : path.replace(/^b\//, '').replace(/^"|"$/g, '')
      if (file) changed.set(file, changed.get(file) ?? new Set())
    } else if (file && line.startsWith('@@')) {
      const hunk = /\+(\d+)(?:,(\d+))?/.exec(line)
      if (!hunk) continue
      const start = Number(hunk[1])
      const count = hunk[2] === undefined ? 1 : Number(hunk[2])
      for (let at = start; at < start + count && at - start < 20000; at++) changed.get(file)!.add(at)
    }
  }
  return changed
}

// How much of the changed code the tests ran. Only lines a report knows (code that can run) count; a changed file no
// report mentions is left out rather than counted as uncovered, because it may be a test, a doc or a file the runner skips.
export function patchCoverage(changed: ReadonlyMap<string, ReadonlySet<number>>, files: readonly FileCoverage[]): PatchCoverage | undefined {
  let [covered, total] = [0, 0]
  const uncovered: { file: string; count: number }[] = []
  for (const [path, lines] of changed) {
    const report = files.find(one => one.lines && samePath(one.file, path))
    if (!report?.lines) continue
    let missed = 0
    for (const at of lines) {
      const hits = report.lines[at]
      if (hits === undefined) continue
      total++
      if (hits > 0) covered++
      else missed++
    }
    if (missed) uncovered.push({ file: normalize(path), count: missed })
  }
  return total ? { covered, total, uncovered: uncovered.sort((a, b) => b.count - a.count).slice(0, 5) } : undefined
}
