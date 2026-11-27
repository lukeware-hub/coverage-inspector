import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { CoverageView, Stored } from '../types'
import { coverageBand } from './band'
import { mergeCoverage, parseChangedLines, patchCoverage } from './coverage'
import { detectRun, userPatterns } from './detect'
import { addRun, buildRun, flakyTests, type Finished } from './run'
import { findReports, readReports } from './scan'

export const PLUGIN = 'coverage-inspector'
export const TOOL = 'mcp__coverage-inspector__coverage_status'
// The band sits right above Git Inspector's, and above Session Inspector's when Git Inspector is off.
const GIT = 'git-inspector'
const SESSION = 'session-inspector'
// How often the band checks whether files changed after the last run.
const STALE_EVERY_MS = 15_000
// A test run started in the background is looked for until its reports show up, for at most this long.
const BACKGROUND_WAIT_MS = 10 * 60_000
// With no duration from the engine, reports written in this window before the end belong to the run.
const DEFAULT_WINDOW_MS = 10 * 60_000
const GIT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' }
const SHELLS = new Set(['Bash', 'PowerShell'])

const INITIAL: CoverageView = { history: [], flaky: [], staleFiles: 0, isScanning: false }
const view = atom({ plugin: 'coverage-inspector', key: 'view' } as const, INITIAL as CoverageView, { shape: 'view-1' })

const DESCRIPTION =
  "Reads the health of the project's tests as the Coverage Inspector band last saw it: the last test run (runner, command, duration, passed or failed, full or partial), test counts, line, branch and function coverage with the change since the last full run, coverage of the lines changed since the last commit (patch), the failing tests, the slowest test, tests that flip between passing and failing (flaky), the trend of the last runs, and how many files changed after the run (stale). last is absent when no test run was seen yet. Takes no input."

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

const asText = (value: unknown): string => (typeof value === 'string' ? value : '')

// What a shell tool printed: its response is text, or an object with stdout and stderr.
export function outputOf(response: unknown): string {
  if (typeof response === 'string') return response
  if (typeof response !== 'object' || response === null) return ''
  const fields = response as Record<string, unknown>
  return [fields.stdout, fields.stderr, fields.output].map(asText).filter(Boolean).join('\n')
}

// Moves this mod's row right above Git Inspector's. When Git Inspector's row has not been moved yet (it moves itself above
// Session Inspector's, and may run after this hook), this row goes above Session Inspector's, which ends in the same order.
export function orderRows<Row extends { plugin: string }>(rows: readonly Row[]): Row[] {
  const own = rows.find(row => row.plugin === PLUGIN)
  if (!own) return [...rows]
  const others = rows.filter(row => row !== own)
  const git = others.findIndex(row => row.plugin === GIT)
  const session = others.findIndex(row => row.plugin === SESSION)
  const anchor = git >= 0 && (session < 0 || git < session) ? git : session >= 0 ? session : git
  if (anchor < 0) return [...rows]
  others.splice(anchor, 0, own)
  return others
}

async function projectRoot($: EngineInterface): Promise<string> {
  return (await $.session.repo())?.root ?? (await $.session.cwd())
}

const storeKey = (root: string) => `project:${root}`

async function load($: EngineInterface, root: string): Promise<Stored | undefined> {
  const stored = (await $.store.get(storeKey(root))) as Stored | undefined
  return stored && Array.isArray(stored.history) && typeof stored.outcomes === 'object' ? stored : undefined
}

async function git($: EngineInterface, root: string, argv: readonly string[]): Promise<string | undefined> {
  try {
    const done = await $.process.run(argv, { cwd: root, env: GIT_ENV, timeoutMs: 20_000 })
    return done.exitCode === 0 ? done.stdout : undefined
  } catch {
    return undefined
  }
}

// Files that git says changed and that were written after `since`: tests that ran earlier no longer describe them.
async function countStale($: EngineInterface, root: string, since: number): Promise<number> {
  const status = await git($, root, ['git', 'status', '--porcelain'])
  if (status === undefined) return 0
  const paths = status
    .split(/\r?\n/)
    .filter(line => line.length > 3)
    .map(line => line.slice(3).split(' -> ').pop()!.replace(/^"|"$/g, ''))
    .slice(0, 200)
  let stale = 0
  for (const path of paths) {
    const stat = await $.fs.stat(`${root.replace(/[\\/]$/, '')}/${path}`).catch(() => undefined)
    if (stat && stat.kind === 'file' && stat.mtimeMs > since) stale++
  }
  return stale
}

type Block = { type?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: string }

const blocksOf = (message: { content?: unknown }): Block[] => (Array.isArray(message.content) ? (message.content as Block[]) : [])

// Shell calls the model started and whose result has not come back yet, by tool_use id, with the time each started.
const calls = new Map<string, { tool_name: string; tool_input: unknown; at: number }>()
const MAX_CALLS = 200

// What a tool_result row holds as text: its content is a string or a list of text blocks.
function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as Block[]).map(block => asText(block.text)).filter(Boolean).join('\n')
}

async function noteCalls($: EngineInterface, message: { content?: unknown }): Promise<void> {
  const uses = blocksOf(message).filter(block => block.type === 'tool_use' && block.id && SHELLS.has(block.name ?? ''))
  if (!uses.length) return
  const at = await $.clock.now()
  for (const use of uses) {
    if (calls.size >= MAX_CALLS) calls.delete(calls.keys().next().value!)
    calls.set(use.id!, { tool_name: use.name!, tool_input: use.input, at })
  }
}

async function endCalls($: EngineInterface, message: { content?: unknown }, extra: readonly RegExp[]): Promise<void> {
  for (const result of blocksOf(message).filter(block => block.type === 'tool_result' && block.tool_use_id)) {
    const call = calls.get(result.tool_use_id!)
    if (!call) continue
    calls.delete(result.tool_use_id!)
    const output = resultText(result.content)
    // A failed shell call starts its text with "Exit code N".
    const code = /^Exit code (\d+)/i.exec(output)?.[1]
    const exitCode = result.is_error ? (code === undefined ? 1 : Number(code)) : 0
    await onShell($, { tool_name: call.tool_name, tool_input: call.tool_input, duration_ms: (await $.clock.now()) - call.at }, { exitCode, output }, extra)
  }
}

type Pending = { finished: Finished; until: number }

const pending: Pending[] = []
// Runs are read one at a time, so two test commands that end together do not write the project's history over each other.
let queue: Promise<unknown> = Promise.resolve()
function enqueue<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work)
  queue = next.catch(() => undefined)
  return next
}

// Reads the reports of one finished run and shows and keeps the result. Returns false while a background run's reports are not there yet.
async function finish($: EngineInterface, finished: Finished, opts: { isLast: boolean; note?: string }): Promise<boolean> {
  const root = await projectRoot($)
  const found = await findReports($, root, finished.startedAt)
  if (!found.length && !opts.isLast) return false
  await update($, view, current => ({ ...current, isScanning: true, error: undefined }))
  try {
    const reports = await readReports($, found)
    const coverage = mergeCoverage(reports.coverage)
    const diff = coverage.length ? await git($, root, ['git', 'diff', '-U0', 'HEAD']) : undefined
    const patch = diff === undefined ? undefined : patchCoverage(parseChangedLines(diff), coverage)
    const stored = await load($, root)
    const record = buildRun(finished, { ...reports, coverage }, patch, stored)
    if (opts.note) record.note = [record.note, opts.note].filter(Boolean).join('; ')
    const next = addRun(stored, record, reports.cases)
    await $.store.set(storeKey(root), next)
    await update($, view, () => ({ last: record, history: next.history, flaky: flakyTests(next), staleFiles: 0, isScanning: false, root }))
  } catch (error) {
    await update($, view, current => ({ ...current, isScanning: false, error: `could not read the test reports: ${message(error)}` }))
  }
  return true
}

async function refreshStale($: EngineInterface): Promise<void> {
  const current = await read($, view)
  if (!current.last || current.isScanning) return
  const root = await projectRoot($)
  const staleFiles = await countStale($, root, current.last.endedAt)
  if (staleFiles !== current.staleFiles) await update($, view, latest => ({ ...latest, staleFiles }))
}

// A shell command that just ended: when it was a test run, its reports are read.
async function onShell($: EngineInterface, e: { tool_name: string; tool_input: unknown; duration_ms?: number }, outcome: { exitCode?: number; output: string }, extra: readonly RegExp[]): Promise<void> {
  if (!SHELLS.has(e.tool_name)) return
  const input = (e.tool_input ?? {}) as { command?: unknown; run_in_background?: unknown }
  const command = asText(input.command)
  const detected = detectRun(command, extra)
  if (!detected) return
  const endedAt = await $.clock.now()
  const startedAt = endedAt - (e.duration_ms ?? DEFAULT_WINDOW_MS)
  const finished: Finished = { command, runner: detected.runner, scope: detected.scope, startedAt, endedAt, exitCode: outcome.exitCode, output: outcome.output }
  await update($, view, current => ({ ...current, isScanning: true }))
  if (input.run_in_background === true) {
    // The command has only been started: its tests are still running, so the reports are looked for until they appear.
    pending.push({ finished: { ...finished, exitCode: undefined, output: undefined }, until: endedAt + BACKGROUND_WAIT_MS })
    return
  }
  await enqueue(() => finish($, finished, { isLast: true }))
}

async function checkPending($: EngineInterface): Promise<void> {
  for (const wait of [...pending]) {
    const now = await $.clock.now()
    const isLast = now >= wait.until
    const done = await enqueue(() => finish($, { ...wait.finished, endedAt: now }, { isLast, note: isLast ? 'ran in the background, results may be incomplete' : undefined }))
    if (done) pending.splice(pending.indexOf(wait), 1)
  }
  if (!pending.length) await update($, view, current => (current.isScanning ? { ...current, isScanning: false } : current))
}

export const register: Register = (on, options) => {
  const extra = userPatterns(String(options.testCommands ?? ''))
  const target = Math.max(0, Number(options.coverageTarget ?? 0)) || 0

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'coverage', description: 'Read the newest test reports now and refresh the Coverage band above the prompt' })
    await $.tool.register({ name: 'coverage_status', description: DESCRIPTION, inputSchema: { type: 'object', properties: {} } })
    const root = await projectRoot($)
    const stored = await load($, root)
    if (stored) await update($, view, () => ({ last: stored.last, history: stored.history, flaky: flakyTests(stored), staleFiles: 0, isScanning: false, root }))
    // Keeps the stale count and the background runs current with no answer needed; the engine stops the timer when the module unloads.
    $.clock.every(STALE_EVERY_MS, () => {
      checkPending($).catch(() => undefined)
      refreshStale($).catch(() => undefined)
    })
    return next(e)
  }).catch(($, e, next) => next(e))

  // The agent's shell calls are read from the conversation's rows, after the fact: the tool_use row says what ran, the
  // tool_result row how it ended. A hook in front of Bash itself would switch off its background mode and live output, and
  // a security plugin above this mod skips the classic PostToolUse hooks, so the rows are what is left to watch.
  on('session.append', { door: 'response' }, async ($, e, next) => {
    await noteCalls($, e.message)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('session.append', { door: 'tool-result' }, async ($, e, next) => {
    // A failure here must show on the band, not vanish: the engine would only skip the hook.
    try {
      await endCalls($, e.message, extra)
    } catch (error) {
      await update($, view, current => ({ ...current, isScanning: false, error: `could not read the test run: ${message(error)}` }))
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      checkPending($).catch(() => undefined)
      refreshStale($).catch(() => undefined)
    }
    return next(e)
  }).catch(($, e, next) => next(e))

  on('command.run', { command: 'coverage' }, async $ => {
    const now = await $.clock.now()
    const finished: Finished = { command: '(newest reports on disk)', runner: 'manual scan', scope: 'full', startedAt: now - 24 * 3_600_000, endedAt: now }
    await enqueue(() => finish($, finished, { isLast: true, note: 'read by /coverage, the reports may be older than the code' }))
    return { text: 'Read the newest test reports and refreshed the Coverage band.' }
  })

  on('tool.run', { tool: TOOL }, async $ => {
    try {
      // A run that just ended is still being read: the answer waits for it.
      await queue.catch(() => undefined)
      await refreshStale($)
      return { result: JSON.stringify(await read($, view)) }
    } catch (error) {
      return { deny: `Coverage status failed: ${message(error)}` }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    return coverageBand($.ui.resolve(e), await read($, view), target, e.props.bodyColumns, e.props.maxRows, e.surface)
  })

  on('ui.render', { component: 'AbovePromptList' }, ($, e, next) => next({ ...e, props: { ...e.props, rows: orderRows(e.props.rows) } }))
}
