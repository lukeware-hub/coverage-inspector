import { describe, expect, test } from 'bun:test'

import type { CoverageView, RunRecord } from '../types'
import { bandRows, clock, coverageBand, duration, fitRows, isFramed, nextStep, percent, runMark, sparkline } from '../hooks/band'
import { cardColumns, cardRows, fit, gridLine, layoutGrid, middle, tableFits, tableLines, type GridRow } from '../hooks/grid'
import { findAll, textsOf, ui } from './fake'

const run = (over: Partial<RunRecord> = {}): RunRecord => ({
  command: 'npm test',
  runner: 'npm test',
  startedAt: 1000,
  endedAt: Date.UTC(2026, 10, 27, 14, 2),
  durationMs: 3000,
  ok: true,
  scope: 'full',
  failures: [],
  reports: 2,
  tests: { total: 10, passed: 10, failed: 0, skipped: 0 },
  coverage: { lines: 80, branches: 70, functions: 60 },
  ...over,
})

const view = (over: Partial<CoverageView> = {}, last: Partial<RunRecord> | null = {}): CoverageView => ({
  history: [],
  flaky: [],
  staleFiles: 0,
  isScanning: false,
  ...(last === null ? {} : { last: run(last) }),
  ...over,
})

const labels = (rows: GridRow[]) => rows.map(row => row.label)
const row = (rows: GridRow[], label: string) => rows.find(one => one.label === label)

describe('small formatters', () => {
  test('time, duration and percent', () => {
    expect(clock(Date.UTC(2026, 10, 27, 14, 2))).toMatch(/^\d\d:\d\d$/)
    expect(duration(250)).toBe('250 ms')
    expect(duration(3000)).toBe('3.0 s')
    expect(duration(12_400)).toBe('12 s')
    expect(duration(125_000)).toBe('2 min 5 s')
    expect(percent(undefined)).toBe('—')
    expect(percent(87.5)).toBe('87.5%')
  })

  test('sparkline', () => {
    expect(sparkline([])).toBe('')
    expect(sparkline([1, 2, 3])).toBe('▁▅█')
    expect(sparkline([4, 4])).toBe('██')
  })

  test('framing and row fitting', () => {
    expect(isFramed(5)).toBe(true)
    expect(isFramed(4)).toBe(false)
    const rows = ['Run', 'Command', 'Tests', 'Trend', 'Slow', 'Flaky', 'Next'].map(label => ({ label, cells: [] }))
    expect(labels(fitRows(rows, 20))).toEqual(labels(rows))
    expect(labels(fitRows(rows, 6))).toEqual(['Run', 'Command', 'Tests', 'Slow', 'Flaky', 'Next'])
    expect(labels(fitRows(rows, 3))).toEqual(['Run', 'Tests', 'Next'])
    expect(labels(fitRows(rows, 0))).toEqual(['Run'])
  })
})

describe('rows', () => {
  test('before any run: idle, reading, or the error', () => {
    expect(textsOf(bandRows(view({}, null), 0).map(one => one.span?.text))).toEqual(['no test run yet, the band reads each run the agent makes'])
    expect(bandRows(view({ isScanning: true }, null), 0)[0]!.span!.text).toBe('reading the test reports')
    const failed = bandRows(view({ error: 'boom' }, null), 0)
    expect(failed[0]).toMatchObject({ label: 'Error', span: { text: 'boom', color: 'error' } })
  })

  test('a full run draws every row it has something to say about', () => {
    const rows = bandRows(
      view(
        { history: [{ at: 1, lines: 70, passRate: 90, scope: 'full' }, { at: 2, lines: 80, passRate: 100, scope: 'full' }], flaky: ['a flaky one', 'another'], staleFiles: 2 },
        {
          ok: false,
          tests: { total: 12, passed: 8, failed: 3, skipped: 1 },
          failures: [{ name: 't > bad', file: 'a.test.ts', line: 4 }],
          slowest: { name: 't > slow', ms: 6000 },
          previousLines: 70,
          patch: { covered: 3, total: 5, uncovered: [{ file: 'src/a.ts', count: 2 }] },
          note: 'a note',
        },
      ),
      90,
    )
    expect(labels(rows)).toEqual(['Run', 'Command', 'Tests', 'Coverage', 'Patch', 'Failing', 'Slow', 'Flaky', 'Trend', 'Stale', 'Next', 'Note'])
    expect(row(rows, 'Run')!.cells.map(cell => cell.text)).toEqual(['npm test', '3.0 s', 'full', '2'])
    expect(row(rows, 'Tests')!.cells.map(cell => cell.text)).toEqual(['12', '8', '3', '1'])
    expect(row(rows, 'Coverage')!.cells.map(cell => cell.label)).toEqual(['lines', 'branches', 'functions', 'target'])
    expect(row(rows, 'Coverage')!.cells[0]!.more![0]!.text).toBe(' ▲10')
    expect(row(rows, 'Patch')!.cells.map(cell => cell.text)).toEqual(['3/5', '2', 'src/a.ts (2)'])
    expect(row(rows, 'Failing')!.span!.more!.map(part => part.text)).toEqual(['  a.test.ts:4', '  +2 more'])
    expect(row(rows, 'Slow')!.span!.more![0]!.color).toBe('warning')
    expect(row(rows, 'Flaky')!.span!.more![0]!.text).toBe('  +1 more')
    expect(row(rows, 'Trend')!.cells.map(cell => cell.label)).toEqual(['coverage', 'pass rate'])
    expect(row(rows, 'Stale')!.span!.text).toBe('2 files changed since this run, the figures may be out of date')
    expect(row(rows, 'Note')!.span).toMatchObject({ text: 'a note', dim: true })
  })

  test('rows with nothing to say are left out, and missing figures say so', () => {
    const rows = bandRows(
      view({}, { tests: undefined, coverage: undefined, reports: 0, note: 'no reports', patch: { covered: 4, total: 4, uncovered: [] }, failures: [{ name: 'only' }], slowest: { name: 'fast', ms: 10 } }),
      0,
    )
    expect(labels(rows)).toEqual(['Run', 'Command', 'Tests', 'Coverage', 'Patch', 'Failing', 'Slow', 'Next', 'Note'])
    expect(row(rows, 'Run')!.cells[3]).toMatchObject({ text: '0', color: 'warning' })
    expect(row(rows, 'Tests')!.span!.text).toBe('no test counts in the reports or in the output')
    expect(row(rows, 'Coverage')!.span!.text).toBe('no coverage report: run the tests with coverage on')
    expect(row(rows, 'Patch')!.cells[2]).toMatchObject({ text: '—', dim: true })
    expect(row(rows, 'Failing')!.span!.more).toEqual([])
    expect(row(rows, 'Slow')!.span!.more![0]!.color).toBeUndefined()
    expect(row(rows, 'Note')!.span).toMatchObject({ color: 'warning', dim: false })
  })

  test('a failing test with a file but no line, and a read error replacing the note', () => {
    const rows = bandRows(view({ error: 'could not read' }, { failures: [{ name: 'x', file: 'f.ts' }], tests: { total: 3, passed: 2, failed: 1, skipped: 0 } }), 0)
    expect(row(rows, 'Failing')!.span!.more![0]!.text).toBe('  f.ts')
    expect(row(rows, 'Error')!.span!.text).toBe('could not read')
    expect(row(rows, 'Tests')!.cells[2]).toMatchObject({ text: '1', color: 'error' })
    expect(row(rows, 'Tests')!.cells[1]!.color).toBeUndefined()
  })

  test('coverage colors and the change since the last full run', () => {
    const cell = (lines: number | undefined, target: number, previous?: number) => row(bandRows(view({}, { coverage: { lines }, previousLines: previous }), target), 'Coverage')!.cells[0]!
    expect(cell(85, 80).color).toBe('success')
    expect(cell(70, 80).color).toBe('warning')
    expect(cell(70, 0).color).toBeUndefined()
    expect(cell(undefined, 80).color).toBeUndefined()
    expect(cell(70, 0, 70).more![0]!.text).toBe(' ±0')
    expect(cell(70, 0, 71.5).more![0]).toMatchObject({ text: ' ▼1.5', color: 'error' })
    expect(cell(70, 0, undefined).more).toEqual([])
    expect(cell(undefined, 0, 70).more).toEqual([])
    const missing = row(bandRows(view({}, { coverage: { lines: 50 } }), 0), 'Coverage')!.cells
    expect(missing.slice(1).map(one => one.text)).toEqual(['—', '—', 'off'])
  })

  test('the trend needs two runs and a figure to draw', () => {
    const trend = (history: CoverageView['history']) => row(bandRows(view({ history }), 0), 'Trend')
    expect(trend([{ at: 1, lines: 50, scope: 'full' }])).toBeUndefined()
    expect(trend([{ at: 1, scope: 'full' }, { at: 2, scope: 'full' }])).toBeUndefined()
    expect(trend([{ at: 1, lines: 50, scope: 'full' }, { at: 2, lines: 60, scope: 'full' }])!.cells.map(cell => cell.label)).toEqual(['coverage'])
    expect(trend([{ at: 1, passRate: 50, scope: 'full' }, { at: 2, passRate: 60, scope: 'full' }])!.cells.map(cell => cell.label)).toEqual(['pass rate'])
  })
})

describe('next step', () => {
  const step = (over: Partial<RunRecord>, target = 0, extra: Partial<CoverageView> = {}) => nextStep(view(extra, over), target)
  test('no run yet', () => expect(nextStep(view({}, null), 0)).toEqual({ text: 'run your tests and this band reads them', dim: true }))
  test('green', () => expect(step({})).toEqual({ text: 'nothing to do, the tests are green', color: 'success' }))
  test('failing tests, uncovered lines, a target and stale files, in order', () => {
    const next = step(
      { ok: false, tests: { total: 5, passed: 3, failed: 2, skipped: 0 }, patch: { covered: 1, total: 4, uncovered: [{ file: 'a.ts', count: 3 }] }, coverage: { lines: 50 } },
      80,
      { staleFiles: 1 },
    )
    expect(next.text).toBe('fix 2 failing tests, cover 3 changed lines in a.ts, raise coverage from 50% to 80%, then run the tests again, 1 file changed since')
    expect(next.color).toBe('error')
  })
  test('a pass nothing backs up asks for a report', () => {
    expect(step({ tests: undefined, coverage: undefined }).text).toBe('run with coverage on, then make the runner write a report or print its totals')
  })

  test('a failing command with no failed test, a patch with no named file, no coverage', () => {
    expect(step({ ok: false, tests: undefined, coverage: undefined }).text).toBe('fix the failing command, run with coverage on, then make the runner write a report or print its totals')
    expect(step({ patch: { covered: 0, total: 2, uncovered: [] } }).text).toBe('cover 2 changed lines')
    expect(step({ coverage: { lines: undefined } }, 80).text).toBe('nothing to do, the tests are green')
    expect(step({ patch: { covered: 0, total: 1, uncovered: [] } }).color).toBe('warning')
  })
})

describe('title mark', () => {
  test('reading, waiting, failed to read, passed and failed', () => {
    expect(runMark(view({ isScanning: true }, null))).toEqual({ text: '○ reading' })
    expect(runMark(view({}, null))).toEqual({ text: '○ waiting', color: undefined })
    expect(runMark(view({ error: 'x' }, null))).toEqual({ text: '● failed', color: 'error' })
    expect(runMark(view({}, { ok: true })).text).toMatch(/^● passed \d\d:\d\d$/)
    expect(runMark(view({}, { ok: false })).color).toBe('error')
    expect(runMark(view({}, { tests: undefined, coverage: undefined })).text).toMatch(/^○ ran, no results \d\d:\d\d$/)
    expect(runMark(view({}, { tests: undefined })).text).toMatch(/^● passed/)
    expect(runMark(view({}, { coverage: undefined })).text).toMatch(/^● passed/)
  })
})

describe('the band drawn on each surface', () => {
  const rich = view({ history: [{ at: 1, lines: 70, scope: 'full' }, { at: 2, lines: 80, scope: 'full' }], flaky: ['f'] }, {
    ok: false,
    tests: { total: 4, passed: 3, failed: 1, skipped: 0 },
    failures: [{ name: 't > bad' }],
    slowest: { name: 'slow', ms: 100 },
    patch: { covered: 1, total: 2, uncovered: [{ file: 'a.ts', count: 1 }] },
  })

  test('a terminal band with the height draws one table inside the frame', () => {
    const tree = coverageBand(ui, rich, 80, 120, 40)
    const texts = textsOf(tree)
    expect(texts).toContain('Coverage Inspector')
    expect(texts).toContain('npm test')
    expect(texts.some(text => /^╭─+┬/.test(text))).toBe(true)
    expect(texts.some(text => /^● failed/.test(text))).toBe(true)
    expect(findAll(tree, 'Box')[0]!.props.borderStyle).toBe('round')
  })

  test('a short terminal band drops rows and draws one line per row', () => {
    const texts = textsOf(coverageBand(ui, rich, 0, 120, 8))
    expect(texts).toContain('Coverage Inspector')
    expect(texts.some(text => text.startsWith('╭'))).toBe(false)
    expect(texts.map(text => text.trim())).toContain('Run')
    expect(texts.map(text => text.trim())).not.toContain('Trend')
  })

  test('under five rows the frame and title are dropped', () => {
    const tree = coverageBand(ui, rich, 0, 120, 3) as { props: Record<string, unknown> }
    expect(textsOf(tree)).not.toContain('Coverage Inspector')
    expect(tree.props.borderStyle).toBeUndefined()
  })

  test('the desktop draws cards', () => {
    const tree = coverageBand(ui, rich, 80, 120, 40, 'desktop')
    expect(findAll(tree, 'Box').filter(box => box.props.borderStyle === 'round').length).toBeGreaterThan(2)
    expect(textsOf(tree)).toContain('Coverage Inspector')
  })

  test('before a run the title has no runner and the idle message shows', () => {
    const texts = textsOf(coverageBand(ui, view({}, null), 0, 100, 30))
    expect(texts).toContain('○ waiting')
    expect(texts).toContain('no test run yet, the band reads each run the agent makes')
  })
})

describe('grid helpers the band relies on', () => {
  const rows: GridRow[] = [
    { label: 'Run', cells: [], span: { text: 'abcdefghijklmnopqrstuvwxyz', bold: true, more: [{ text: ' x' }, { text: 'y'.repeat(60), dim: true }] } },
    { label: 'Tests', cells: [{ label: 'total', text: '10' }, { label: 'passed', text: '9', color: 'success' }, { label: 'failed', text: '1', color: 'error', more: [{ text: '!' }] }, { label: 'opt', text: 'o', optional: true }] },
    { label: 'Cov', cells: [{ label: 'lines', text: '5%', color: 'warning' }] },
  ]

  test('fit, middle and card columns', () => {
    expect(fit('abc', 5)).toBe('abc')
    expect(fit('abcdef', 4)).toBe('abc…')
    expect(middle('abcdefghij', 5)).toBe('ab…ij')
    expect(middle('abc', 5)).toBe('abc')
    expect(cardColumns(90)).toBe(4)
    expect(cardColumns(50)).toBe(2)
    expect(cardColumns(10)).toBe(1)
    expect(tableFits(12, 4)).toBe(true)
    expect(tableFits(5, 4)).toBe(false)
  })

  test('the one-line grid keeps columns aligned, cuts spans and drops columns from the right', () => {
    for (const width of [120, 60, 30, 14]) {
      const lines = layoutGrid(rows, width, 9)
      expect(lines).toHaveLength(3)
    }
    expect(layoutGrid(rows, 14, 9)[1]!.map(part => part.text).join('')).toContain('…')
  })

  test('tables and cards, wide and narrow, with optional figures leaving first', () => {
    const wide = tableLines(rows, 100, 9)
    expect(wide[0]![1]!.text.startsWith('╭')).toBe(true)
    const narrow = tableLines(rows, 50, 9)
    expect(narrow.flat().some(part => part.text.includes('opt'))).toBe(false)
    expect(tableLines(rows, 20, 9).length).toBe(wide.length)
    const cards = cardRows(ui, rows, 100, 9)
    expect(cards).toHaveLength(3)
    expect(findAll(cards, 'Box').some(box => box.props.borderColor === 'error')).toBe(true)
    expect(cardRows(ui, rows, 60, 9)).toHaveLength(3)
    expect(cardRows(ui, rows, 30, 9)).toHaveLength(3)
    expect(cardRows(ui, [{ label: 'Warn', cells: [], span: { text: 'careful', color: 'warning' } }], 100, 9)).toHaveLength(1)
    expect(textsOf(gridLine(ui, [{ text: 'a' }, { text: 'b', bold: true }]))).toEqual(['a', 'b'])
  })
})
