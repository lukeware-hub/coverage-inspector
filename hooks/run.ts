import type { FileCoverage, PatchCoverage, RunRecord, RunScope, Stored, TestCase, TrendPoint } from '../types'
import { summarize } from './coverage'
import { countCases, parseSummaryOutput } from './parsers/results'
import type { Reports } from './scan'

export const HISTORY_LIMIT = 20
const OUTCOME_LIMIT = 10
// Outcomes are kept for at most this many tests, so the store stays small.
const OUTCOME_TESTS = 300

export type Finished = {
  command: string
  runner: string
  scope: RunScope
  startedAt: number
  endedAt: number
  exitCode?: number
  // The text the command printed, used only to read a summary line when no result report exists.
  output?: string
}

// Builds the record of one run from what the command did and what its reports said. Nothing here is invented: a figure
// with no source is left out and `note` says why.
export function buildRun(run: Finished, reports: Reports, patch: PatchCoverage | undefined, previous: Stored | undefined): RunRecord {
  const merged: FileCoverage[] = reports.coverage
  const coverage = merged.length ? summarize(merged) : undefined
  const fromReports = reports.cases.length > 0
  const outputCounts = fromReports || !run.output ? undefined : parseSummaryOutput(run.output)
  const tests = fromReports ? countCases(reports.cases) : outputCounts
  const failing = reports.cases.filter(one => one.outcome === 'failed')
  const timed = reports.cases.filter(one => one.ms !== undefined).sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0))[0]
  const ok = (run.exitCode === undefined || run.exitCode === 0) && !(tests?.failed ?? 0)
  const lastFull = previous?.history.filter(point => point.scope === 'full' && point.lines !== undefined).at(-1)

  const notes: string[] = []
  if (!reports.count) notes.push('no coverage or result report found')
  else if (!coverage) notes.push('no coverage report found')
  if (reports.skipped) notes.push(`${reports.skipped} report${reports.skipped === 1 ? '' : 's'} could not be read`)
  if (run.exitCode !== undefined && run.exitCode !== 0 && !(tests?.failed ?? 0)) notes.push(`the command exited with code ${run.exitCode}`)

  return {
    command: run.command,
    runner: run.runner,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    durationMs: Math.max(0, run.endedAt - run.startedAt),
    ok,
    exitCode: run.exitCode,
    scope: run.scope,
    testsFrom: tests ? (fromReports ? 'report' : 'output') : undefined,
    tests,
    failures: failing.slice(0, 10).map(({ name, file, line }) => ({ name, file, line })),
    slowest: timed?.ms ? { name: timed.name, ms: timed.ms } : undefined,
    coverage,
    previousLines: run.scope === 'full' && coverage?.lines !== undefined ? lastFull?.lines : undefined,
    patch,
    reports: reports.count,
    note: notes.length ? notes.join('; ') : undefined,
  }
}

// A test that flips between passing and failing: at least two changes of outcome in its last results.
export function isFlaky(outcomes: string): boolean {
  let changes = 0
  for (let at = 1; at < outcomes.length; at++) if (outcomes[at] !== outcomes[at - 1]) changes++
  return changes >= 2
}

export function flakyTests(stored: Stored): string[] {
  return Object.entries(stored.outcomes)
    .filter(([, outcomes]) => isFlaky(outcomes))
    .map(([name]) => name)
}

// Adds a run to what is kept for the project: a trend point and the outcomes of the tests that failed or are being watched.
// Partial runs join the trend (marked) but only full runs set the baseline the next delta is measured from.
export function addRun(stored: Stored | undefined, record: RunRecord, cases: readonly TestCase[]): Stored {
  const base: Stored = stored ?? { history: [], outcomes: {} }
  const passRate = record.tests?.total ? Math.round((record.tests.passed / record.tests.total) * 1000) / 10 : undefined
  const point: TrendPoint = { at: record.endedAt, lines: record.coverage?.lines, passRate, scope: record.scope }
  const outcomes = { ...base.outcomes }
  // Only a full result report says every test's outcome; a partial run still tells about the tests it ran.
  const known = new Set(Object.keys(outcomes))
  for (const one of cases) {
    if (one.outcome === 'skipped') continue
    if (one.outcome === 'failed' || known.has(one.name)) {
      if (!known.has(one.name) && Object.keys(outcomes).length >= OUTCOME_TESTS) continue
      outcomes[one.name] = `${outcomes[one.name] ?? ''}${one.outcome === 'failed' ? 'f' : 'p'}`.slice(-OUTCOME_LIMIT)
    }
  }
  // A test that has passed for the whole window and never flipped is dropped, so the map does not grow without end.
  for (const [name, text] of Object.entries(outcomes)) if (text.length >= OUTCOME_LIMIT && !text.includes('f')) delete outcomes[name]
  return { last: record, history: [...base.history, point].slice(-HISTORY_LIMIT), outcomes }
}
