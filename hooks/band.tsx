import type { ThemeKey } from 'claude-code'

import type { CoverageView, RunRecord } from '../types'
import { cardRows, gridLine, layoutGrid, middle, tableFits, tableLines, type GridRow, type Part, type Segment, type Ui } from './grid'

const LABEL_WIDTH = 9
const COMMAND_WIDTH = 70

// Local time as HH:MM.
export function clock(at: number): string {
  return new Date(at).toTimeString().slice(0, 5)
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`

export function duration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}

export const percent = (value: number | undefined): string => (value === undefined ? '—' : `${value}%`)

// A count that stands out only when it is not zero.
function count(label: string, value: number, color?: ThemeKey): Segment {
  return value ? { label, text: String(value), color } : { label, text: '0', dim: true }
}

const SPARK = '▁▂▃▄▅▆▇█'

// A run of values as a line of bars, each as high as its place between the lowest and the highest value.
export function sparkline(values: readonly number[]): string {
  if (!values.length) return ''
  const [low, high] = [Math.min(...values), Math.max(...values)]
  return values.map(value => SPARK[high === low ? SPARK.length - 1 : Math.round(((value - low) / (high - low)) * (SPARK.length - 1))]).join('')
}

// Coverage color: a warning under the target, success at or above it, none when no target is set.
function levelColor(value: number | undefined, target: number): ThemeKey | undefined {
  if (value === undefined || !target) return undefined
  return value >= target ? 'success' : 'warning'
}

function deltaPart(last: RunRecord): Part[] {
  const now = last.coverage?.lines
  if (now === undefined || last.previousLines === undefined) return []
  const change = Math.round((now - last.previousLines) * 10) / 10
  if (change === 0) return [{ text: ' ±0', dim: true }]
  return [{ text: ` ${change > 0 ? '▲' : '▼'}${Math.abs(change)}`, color: change > 0 ? 'success' : 'error' }]
}

function runRow(last: RunRecord): GridRow {
  return {
    label: 'Run',
    cells: [
      { label: 'runner', text: last.runner },
      { label: 'took', text: duration(last.durationMs) },
      { label: 'scope', text: last.scope, dim: last.scope === 'full', color: last.scope === 'partial' ? 'warning' : undefined },
      // Four figures, like the Tests row, so no cell of the table is left blank.
      { label: 'reports', text: String(last.reports), dim: !last.reports, color: last.reports ? undefined : 'warning', optional: true },
    ],
  }
}

function testsRow(last: RunRecord): GridRow {
  const tests = last.tests
  if (!tests) return { label: 'Tests', cells: [], span: { text: 'no test counts in the reports or in the output', dim: true } }
  return {
    label: 'Tests',
    cells: [
      { label: 'total', text: String(tests.total) },
      { label: 'passed', text: String(tests.passed), color: tests.failed ? undefined : 'success' },
      count('failed', tests.failed, 'error'),
      count('skipped', tests.skipped, 'warning'),
    ],
  }
}

function coverageRow(last: RunRecord, target: number): GridRow {
  const coverage = last.coverage
  if (!coverage) return { label: 'Coverage', cells: [], span: { text: 'no coverage report: run the tests with coverage on', color: 'warning' } }
  const lines: Segment = { label: 'lines', text: percent(coverage.lines), color: levelColor(coverage.lines, target), bold: true, more: deltaPart(last) }
  const missing = (label: string, value: number | undefined): Segment => ({ label, text: percent(value), dim: value === undefined })
  const cells = [lines, missing('branches', coverage.branches), missing('functions', coverage.functions)]
  cells.push({ label: 'target', text: target ? `${target}%` : 'off', dim: true, optional: true })
  return { label: 'Coverage', cells }
}

function patchRow(last: RunRecord): GridRow | undefined {
  const patch = last.patch
  if (!patch) return undefined
  const rate = Math.round((patch.covered / patch.total) * 100)
  const missed = patch.total - patch.covered
  const worst = patch.uncovered[0]
  return {
    label: 'Patch',
    cells: [
      { label: 'changed lines', text: `${patch.covered}/${patch.total}`, more: [{ text: ` ${rate}%`, color: missed ? 'warning' : 'success' }] },
      count('uncovered', missed, 'warning'),
      { label: 'worst', text: worst ? `${worst.file} (${worst.count})` : '—', dim: !worst, optional: true },
    ],
  }
}

function failingRow(last: RunRecord): GridRow | undefined {
  const first = last.failures[0]
  if (!first) return undefined
  const failed = last.tests?.failed ?? last.failures.length
  const where = first.file ? `  ${first.file}${first.line ? `:${first.line}` : ''}` : ''
  const more: Part[] = []
  if (where) more.push({ text: where, dim: true })
  if (failed > 1) more.push({ text: `  +${failed - 1} more`, dim: true })
  return { label: 'Failing', cells: [], span: { text: first.name, color: 'error', more } }
}

function slowRow(last: RunRecord): GridRow | undefined {
  const slow = last.slowest
  if (!slow) return undefined
  return { label: 'Slow', cells: [], span: { text: 'slowest', dim: true, more: [{ text: ` ${duration(slow.ms)} `, color: slow.ms >= 5000 ? 'warning' : undefined }, { text: middle(slow.name, 60) }] } }
}

function flakyRow(view: CoverageView): GridRow | undefined {
  if (!view.flaky.length) return undefined
  const more: Part[] = view.flaky.length > 1 ? [{ text: `  +${view.flaky.length - 1} more`, dim: true }] : []
  return { label: 'Flaky', cells: [], span: { text: middle(view.flaky[0]!, 70), color: 'warning', more } }
}

function trendRow(view: CoverageView): GridRow | undefined {
  const points = view.history.slice(-12)
  if (points.length < 2) return undefined
  const lines = points.flatMap(point => (point.lines === undefined ? [] : [point.lines]))
  const pass = points.flatMap(point => (point.passRate === undefined ? [] : [point.passRate]))
  const cells: Segment[] = []
  if (lines.length > 1) cells.push({ label: 'coverage', text: sparkline(lines), more: [{ text: ` ${percent(lines.at(-1))}`, dim: true }] })
  if (pass.length > 1) cells.push({ label: 'pass rate', text: sparkline(pass), more: [{ text: ` ${percent(pass.at(-1))}`, dim: true }] })
  return cells.length ? { label: 'Trend', cells } : undefined
}

// What to do next, in plain words and in order: fix failures, cover the new code, reach the target, run again.
export function nextStep(view: CoverageView, target: number): Segment {
  const last = view.last
  if (!last) return { text: 'run your tests and this band reads them', dim: true }
  const steps: string[] = []
  const failed = last.tests?.failed ?? 0
  if (failed) steps.push(`fix ${plural(failed, 'failing test')}`)
  else if (!last.ok) steps.push('fix the failing command')
  const missed = last.patch ? last.patch.total - last.patch.covered : 0
  const worst = last.patch?.uncovered[0]
  if (missed) steps.push(`cover ${plural(missed, 'changed line')}${worst ? ` in ${worst.file}` : ''}`)
  const lines = last.coverage?.lines
  if (target && lines !== undefined && lines < target) steps.push(`raise coverage from ${lines}% to ${target}%`)
  if (!last.coverage) steps.push('run with coverage on')
  if (view.staleFiles) steps.push(`run the tests again, ${plural(view.staleFiles, 'file')} changed since`)
  if (!steps.length) return { text: 'nothing to do, the tests are green', color: 'success' }
  const text = steps.length === 1 ? steps[0]! : `${steps.slice(0, -1).join(', ')}, then ${steps.at(-1)}`
  return { text, color: failed ? 'error' : 'warning' }
}

// The rows under the title: short figures in aligned columns, messages across the row.
export function bandRows(view: CoverageView, target: number): GridRow[] {
  const { last } = view
  if (!last) {
    if (view.error) return [{ label: 'Error', cells: [], span: { text: view.error, color: 'error' } }]
    return [{ label: 'Run', cells: [], span: { text: view.isScanning ? 'reading the test reports' : 'no test run yet, the band reads each run the agent makes', dim: true } }]
  }
  const stale: GridRow | undefined = view.staleFiles
    ? { label: 'Stale', cells: [], span: { text: `${plural(view.staleFiles, 'file')} changed since this run, the figures may be out of date`, color: 'warning' } }
    : undefined
  const note: GridRow | undefined = view.error
    ? { label: 'Error', cells: [], span: { text: view.error, color: 'error' } }
    : last.note
      ? { label: 'Note', cells: [], span: { text: last.note, color: last.reports ? undefined : 'warning', dim: Boolean(last.reports) } }
      : undefined
  return [
    runRow(last),
    { label: 'Command', cells: [], span: { text: middle(last.command.replace(/\s+/g, ' '), COMMAND_WIDTH), dim: true } },
    testsRow(last),
    coverageRow(last, target),
    patchRow(last),
    failingRow(last),
    slowRow(last),
    flakyRow(view),
    trendRow(view),
    stale,
    { label: 'Next', cells: [], span: nextStep(view, target) },
    note,
  ].filter((row): row is GridRow => row !== undefined)
}

type Mark = { text: string; color?: ThemeKey }

// The title row's status: how the last run went and when, or that a reading runs now.
export function runMark(view: CoverageView): Mark {
  const { last } = view
  if (view.isScanning) return { text: '○ reading' }
  if (!last) return { text: view.error ? '● failed' : '○ waiting', color: view.error ? 'error' : undefined }
  return last.ok ? { text: `● passed ${clock(last.endedAt)}`, color: 'success' } : { text: `● failed ${clock(last.endedAt)}`, color: 'error' }
}

// Rows that leave first, in this order, when the band is too short for every row.
const DROP_FIRST = ['Trend', 'Slow', 'Flaky', 'Command']

// Keeps at most `limit` rows: the rows in DROP_FIRST leave before the rest, then rows leave from the bottom.
export function fitRows(rows: readonly GridRow[], limit: number): GridRow[] {
  let kept = [...rows]
  for (const label of DROP_FIRST) if (kept.length > limit) kept = kept.filter(row => row.label !== label)
  return kept.slice(0, Math.max(1, limit))
}

// The frame and title need five rows of room; below that the rows stay bare.
export function isFramed(maxRows: number): boolean {
  return maxRows >= 5
}

// The band above the prompt, drawn like Git Inspector's: cards on the desktop; on the terminal one bordered table when
// the band has the height for it, the one-line grid otherwise. Title on the left, runner and run state on the right.
export function coverageBand(ui: Ui, view: CoverageView, target: number, columns: number, maxRows: number, surface: string = 'terminal') {
  const { Box, Text } = ui
  const allRows = bandRows(view, target)
  const isDesktop = surface === 'desktop'
  const tableRows = fitRows(allRows, Math.floor((maxRows - 4) / 2))
  const coreRows = allRows.filter(row => !DROP_FIRST.includes(row.label)).length
  const isTable = !isDesktop && tableFits(maxRows, tableRows.length) && tableRows.length >= coreRows
  const isCards = isDesktop || isTable
  const framed = isTable || isFramed(maxRows)
  const rows = isDesktop ? allRows : isTable ? tableRows : fitRows(allRows, framed ? maxRows - 3 : maxRows)
  const width = columns - (framed ? 4 : 0)
  const lines = isDesktop
    ? cardRows(ui, rows, width, LABEL_WIDTH)
    : (isTable ? tableLines(rows, width, LABEL_WIDTH) : layoutGrid(rows, width, LABEL_WIDTH)).map(parts => gridLine(ui, parts))
  if (!framed) return <Box flexDirection="column">{lines}</Box>

  const mark = runMark(view)
  const wrap = isCards ? 'wrap' : undefined
  return (
    <Box flexDirection="column" borderStyle="round" borderDimColor paddingX={1} gap={0}>
      <Box flexDirection="row" justifyContent="space-between" flexWrap={wrap}>
        <Text bold color="claude">
          Coverage Inspector
        </Text>
        <Box flexDirection="row" columnGap={3} flexWrap={wrap}>
          {view.last && <Text bold>{view.last.runner}</Text>}
          <Text color={mark.color} dimColor={!mark.color}>
            {mark.text}
          </Text>
        </Box>
      </Box>
      {lines}
    </Box>
  )
}
