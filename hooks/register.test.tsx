import type { On } from 'claude-code'
import { expect, mock, test, type TestBody } from 'claude-code/testing'

import { PLUGIN, TOOL, orderRows, outputOf } from './register'

type Engine = Parameters<TestBody>[0]

const ROOT = '/work/app'
const NOW = Date.UTC(2026, 10, 27, 14, 2, 11)

const BAND = {
  plugin: PLUGIN,
  component: 'AbovePrompt',
  props: { hasSurvey: false, isCollapsed: false, isWorking: false, maxRows: 24, bodyColumns: 120, scroll: { offset: 0, bodyRows: 6 }, view: {} },
} as const

const LCOV = 'SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\nSF:src/b.ts\nDA:1,1\nend_of_record\n'
const JUNIT = '<testsuite><testcase classname="s" name="ok" time="0.1"/><testcase classname="s" name="bad" time="3"><failure>x</failure></testcase></testsuite>'
const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2,2 @@\n+x\n+y\n'

// The test engine resolves a path to this machine's own spelling (C:\work\app on Windows); the stub files are kept with forward slashes.
const slashed = (path: string) => path.replace(/[\\]/g, '/').replace(/^[A-Za-z]:/, '')

type Host = { files: Record<string, { text: string; mtimeMs: number }>; diff?: string; status?: string }

// Stands for the engine: a project folder with report files, git's answers and the clock.
function stubEngine(on: On, host: Host) {
  const clock = mock.clock(on, { now: NOW })
  mock.store(on)
  on('session.cwd', () => ({ value: ROOT }))
  on('session.repo', () => ({ value: { root: ROOT, remote: null, internal: false, name: 'app' } }))
  on('fs.list', (_, e) => {
    const prefix = `${slashed(e.path).replace(/\/$/, '')}/`
    const names = new Set<string>()
    const entries = Object.entries(host.files).flatMap(([path, file]) => {
      if (!path.startsWith(prefix)) return []
      const rest = path.slice(prefix.length)
      const [first, ...more] = rest.split('/')
      if (names.has(first!)) return []
      names.add(first!)
      return [{ name: first!, kind: more.length ? ('dir' as const) : ('file' as const), size: file.text.length, mtimeMs: more.length ? 0 : file.mtimeMs, isLink: false }]
    })
    return { value: entries }
  })
  on('fs.read', (_, e) => ({ value: host.files[slashed(e.path)]?.text ?? '' }))
  on('fs.stat', (_, e) => ({ value: { kind: 'file' as const, size: 1, mtimeMs: host.files[slashed(e.path)]?.mtimeMs ?? 0, isLink: false } }))
  on('process.run', (_, e) => {
    const command = e.argv.slice(0, 2).join(' ')
    const out = command === 'git diff' ? (host.diff ?? DIFF) : command === 'git status' ? (host.status ?? '') : ''
    return { value: { exitCode: 0, stdout: out, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__coverage-inspector__${e.name}` } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('classic.PostToolUse', () => ({}))
  on('classic.PostToolUseFailure', () => ({}))
  return { clock }
}

async function bandLines($: Engine, surface: 'terminal' | 'desktop' = 'terminal', props: { bodyColumns?: number; maxRows?: number } = {}) {
  const band = await $.ui.mount({ ...BAND, props: { ...BAND.props, ...props }, surface })
  const lines = (await band.findAll({ type: 'Text' })).map(found => found.text.trim())
  await band.unmount()
  return lines
}

async function start($: Engine) {
  await $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true })
}

// The agent's test command ends: the engine tells the classic hook.
async function testRun($: Engine, command: string, overrides: { error?: string; response?: unknown; background?: boolean } = {}) {
  const base = { tool_name: 'Bash', tool_input: { command, ...(overrides.background ? { run_in_background: true } : {}) }, tool_use_id: 't1', duration_ms: 3000 }
  if (overrides.error !== undefined) await $.classic.PostToolUseFailure({ ...base, error: overrides.error })
  else await $.classic.PostToolUse({ ...base, tool_response: overrides.response ?? { stdout: '', stderr: '' } })
}

// The value painted right after a dim cell label, such as "lines" then "66.7%".
function cellAfter(lines: string[], label: string) {
  return lines[lines.indexOf(label) + 1]
}

const FRESH = NOW - 1000

test('a test run with reports shows tests, coverage, the changed lines, the slowest test and the next step', async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/coverage/lcov.info`]: { text: LCOV, mtimeMs: FRESH }, [`${ROOT}/reports/junit.xml`]: { text: JUNIT, mtimeMs: FRESH } } })
  await start($)
  await testRun($, 'npm test', { error: 'Exit code 1\nTests: 1 failed' })
  for (const surface of ['terminal', 'desktop'] as const) {
    const lines = await bandLines($, surface)
    for (const text of ['Coverage Inspector', 'npm test', 'Run', 'Tests', 'Coverage', 'Patch', 'Failing', 's > bad', 'Slow', 'Next']) expect(lines).toContain(text)
    expect(cellAfter(lines, 'total')).toBe('2')
    expect(cellAfter(lines, 'failed')).toBe('1')
    expect(cellAfter(lines, 'lines')).toBe('50%')
    expect(cellAfter(lines, 'uncovered')).toBe('2')
    expect(lines.some(line => /^● failed \d\d:\d\d$/.test(line))).toBe(true)
    expect(lines).toContain('fix 1 failing test, then cover 2 changed lines in src/a.ts')
  }
})

test('a passing run is green and says there is nothing to do', async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/lcov.info`]: { text: 'SF:a.ts\nDA:1,1\nend_of_record\n', mtimeMs: FRESH } }, diff: '' })
  await start($)
  await testRun($, 'pnpm test', { response: { stdout: 'Tests  2 passed (2)' } })
  const lines = await bandLines($)
  expect(lines.some(line => /^● passed \d\d:\d\d$/.test(line))).toBe(true)
  expect(lines).toContain('nothing to do, the tests are green')
  expect(cellAfter(lines, 'lines')).toBe('100%')
})

test('a command that is not a test run changes nothing', async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/lcov.info`]: { text: LCOV, mtimeMs: FRESH } } })
  await start($)
  await testRun($, 'git status')
  await testRun($, 'ls')
  expect(await bandLines($)).toContain('no test run yet, the band reads each run the agent makes')
})

test('reports older than the run are not read as its results', async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/lcov.info`]: { text: LCOV, mtimeMs: NOW - 3_600_000 } } })
  await start($)
  await testRun($, 'npm test', { response: { stdout: 'Tests  2 passed (2)' } })
  const lines = await bandLines($)
  expect(lines).toContain('no coverage report: run the tests with coverage on')
  expect(lines).toContain('no coverage or result report found')
  expect(cellAfter(lines, 'total')).toBe('2')
})

test('files changed after the run make the figures stale, and the timer finds them', async ($, on) => {
  const host: Host = { files: { [`${ROOT}/lcov.info`]: { text: LCOV, mtimeMs: FRESH }, [`${ROOT}/src/a.ts`]: { text: 'x', mtimeMs: FRESH } } }
  const { clock } = stubEngine(on, host)
  await start($)
  await testRun($, 'npm test')
  expect((await bandLines($)).includes('Stale')).toBe(false)
  host.files[`${ROOT}/src/a.ts`] = { text: 'y', mtimeMs: NOW + 5000 }
  host.status = ' M src/a.ts\n'
  await clock.advance(15_000)
  for (let tries = 0; tries < 20 && !(await bandLines($)).includes('Stale'); tries++) await clock.advance(0)
  const lines = await bandLines($)
  expect(lines).toContain('Stale')
  expect(lines).toContain('1 file changed since this run, the figures may be out of date')
})

test('a run started in the background is read when its reports appear', async ($, on) => {
  const host: Host = { files: {} }
  const { clock } = stubEngine(on, host)
  await start($)
  await testRun($, 'npm test', { background: true })
  expect(await bandLines($)).not.toContain('Tests')
  host.files[`${ROOT}/lcov.info`] = { text: LCOV, mtimeMs: NOW + 5000 }
  await clock.advance(15_000)
  let lines: string[] = []
  for (let tries = 0; tries < 20 && !lines.includes('Coverage'); tries++) {
    await clock.advance(0)
    lines = await bandLines($)
  }
  expect(lines).toContain('Coverage')
  expect(cellAfter(lines, 'lines')).toBe('50%')
})

test('the tool and /coverage answer with the same data', async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/lcov.info`]: { text: LCOV, mtimeMs: FRESH }, [`${ROOT}/junit.xml`]: { text: JUNIT, mtimeMs: FRESH } } })
  await start($)
  const answer = await $.command.run({ command: 'coverage', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } })
  expect(answer.text).toBe('Read the newest test reports and refreshed the Coverage band.')
  const data = JSON.parse(String((await $.tool.call({ tool: TOOL })).result))
  expect(data.last).toMatchObject({ runner: 'manual scan', tests: { total: 2, failed: 1 }, coverage: { lines: 50 }, reports: 2 })
})

test('before any run the band waits, and a user option adds a test command', async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/lcov.info`]: { text: LCOV, mtimeMs: FRESH } } })
  await start($)
  const lines = await bandLines($)
  expect(lines).toContain('Coverage Inspector')
  expect(lines).toContain('○ waiting')
})

test('a custom test command from the settings is read like a built-in one', { options: { testCommands: '^\\./ci\\.sh', coverageTarget: 80 } }, async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/lcov.info`]: { text: LCOV, mtimeMs: FRESH } }, diff: '' })
  await start($)
  await testRun($, './ci.sh --fast')
  const lines = await bandLines($)
  expect(lines).toContain('./ci.sh')
  expect(lines).toContain('target')
  expect(lines).toContain('raise coverage from 50% to 80%')
})

test('a band with the height for it draws one bordered table, one without keeps bare rows', async ($, on) => {
  stubEngine(on, { files: { [`${ROOT}/lcov.info`]: { text: LCOV, mtimeMs: FRESH } } })
  await start($)
  await testRun($, 'npm test')
  const table = await bandLines($, 'terminal', { maxRows: 30 })
  expect(table.some(line => /^╭─+┬/.test(line))).toBe(true)
  const bare = await bandLines($, 'terminal', { maxRows: 3 })
  expect(bare).not.toContain('Coverage Inspector')
  expect(bare).toContain('Run')
})

test('the Coverage row goes right above Git Inspector, in either order the two mods run', () => {
  const row = (plugin: string) => ({ plugin })
  const names = (rows: { plugin: string }[]) => rows.map(one => one.plugin)
  // This hook runs after Git Inspector moved itself above Session Inspector.
  expect(names(orderRows([row('bugs'), row('git-inspector'), row('session-inspector'), row(PLUGIN)]))).toEqual(['bugs', PLUGIN, 'git-inspector', 'session-inspector'])
  // This hook runs first: Git Inspector then moves itself above Session Inspector, leaving this row on top.
  const first = orderRows([row('session-inspector'), row('git-inspector'), row(PLUGIN)])
  expect(names(first)).toEqual([PLUGIN, 'session-inspector', 'git-inspector'])
  expect(names(orderRows([row('git-inspector'), row(PLUGIN)]))).toEqual([PLUGIN, 'git-inspector'])
  expect(names(orderRows([row('bugs'), row(PLUGIN)]))).toEqual(['bugs', PLUGIN])
})

test('what a shell tool printed is read from a string or from stdout and stderr', () => {
  expect(outputOf('plain')).toBe('plain')
  expect(outputOf({ stdout: 'a', stderr: 'b' })).toBe('a\nb')
  expect(outputOf(undefined)).toBe('')
})
