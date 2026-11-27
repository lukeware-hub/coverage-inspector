// What coverage-inspector reads from the test runs of the session's project.

// A covered count out of a total, such as 42 of 50 lines.
export type Totals = { covered: number; total: number }

// Coverage of one source file, as one report says it. `lines` maps a line number to its hit count; `linesTotal` stands in
// when a report only has totals (Istanbul's coverage-summary.json).
export type FileCoverage = {
  file: string
  lines?: Record<number, number>
  linesTotal?: Totals
  branches?: Totals
  functions?: Totals
}

// One test case as a result report says it.
export type TestOutcome = 'passed' | 'failed' | 'skipped'

export type TestCase = { name: string; outcome: TestOutcome; ms?: number; file?: string; line?: number }

export type TestCounts = { total: number; passed: number; failed: number; skipped: number }

export type Percentages = { lines?: number; branches?: number; functions?: number }

// Coverage of the lines the working tree changed since the last commit (`git diff -U0 HEAD`).
export type PatchCoverage = { covered: number; total: number; uncovered: { file: string; count: number }[] }

export type RunScope = 'full' | 'partial'

// One test run, as the band shows it. Summaries only: no output and no environment are kept.
export type RunRecord = {
  command: string
  runner: string
  startedAt: number
  endedAt: number
  durationMs: number
  // False when the command failed or any test failed.
  ok: boolean
  exitCode?: number
  scope: RunScope
  // Where the test counts came from.
  testsFrom?: 'report' | 'output'
  tests?: TestCounts
  failures: { name: string; file?: string; line?: number }[]
  slowest?: { name: string; ms: number }
  coverage?: Percentages
  // The previous full run's line coverage, when this run is a full one with coverage.
  previousLines?: number
  patch?: PatchCoverage
  // How many report files were read.
  reports: number
  // What went wrong while reading, in plain words.
  note?: string
}

// One point of the trend: a run's line coverage and pass rate.
export type TrendPoint = { at: number; lines?: number; passRate?: number; scope: RunScope }

// What is kept between sessions for one project.
export type Stored = {
  last?: RunRecord
  history: TrendPoint[]
  // Per test that ever failed: its last outcomes, oldest first, `p` passed and `f` failed.
  outcomes: Record<string, string>
}

// What the band draws.
export type CoverageView = {
  last?: RunRecord
  history: TrendPoint[]
  // Tests that flip between passing and failing.
  flaky: string[]
  // Files changed after the last run finished.
  staleFiles: number
  // Test runs whose reports are still being read or awaited.
  isScanning: boolean
  error?: string
  // The project folder the readings are for.
  root?: string
}

declare module 'claude-code' {
  // The coverage_status tool takes no input.
  interface McpToolInputs {
    'mcp__coverage-inspector__coverage_status': {}
  }

  interface PluginState {
    'coverage-inspector': { view: Shaped<CoverageView> }
  }
}
