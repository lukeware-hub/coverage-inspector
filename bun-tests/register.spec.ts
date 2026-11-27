import { beforeEach, describe, expect, test } from 'bun:test'

import type { CoverageView } from '../types'
import { PLUGIN, TOOL, orderRows, register } from '../hooks/register'
import { NOW, ROOT, collect, makeFake, textsOf, type Fake, type FakeFile } from './fake'
import { resetAtoms } from './shim'

const LCOV = 'SF:src/a.ts\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\n'
const JUNIT = '<testsuite><testcase classname="s" name="ok" time="0.1"/><testcase classname="s" name="bad" time="3"><failure>x</failure></testcase></testsuite>'
const DIFF = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,0 +2,2 @@\n+x\n+y\n'
const FRESH = NOW - 1000

const file = (text: string, mtimeMs = FRESH, extra: Partial<FakeFile> = {}): FakeFile => ({ text, mtimeMs, ...extra })
const reports = (): Record<string, FakeFile> => ({ [`${ROOT}/coverage/lcov.info`]: file(LCOV), [`${ROOT}/reports/junit.xml`]: file(JUNIT) })

const atoms = () => (globalThis as { __atoms: Map<string, unknown> }).__atoms
const viewOf = (): CoverageView => atoms().get('coverage-inspector:view') as CoverageView
const settle = () => new Promise(resolve => setTimeout(resolve, 5))

let ids = 0
function boot(files: Record<string, FakeFile> = {}, options: Record<string, string | number> = {}) {
  const fake = makeFake(files)
  const mod = collect()
  register(mod.on as never, options as never)
  return { fake, ...mod }
}
type Booted = ReturnType<typeof boot>

const row = (type: 'response' | 'tool-result', message: unknown) => ({ door: type, message, origin: { kind: 'model' }, uuid: `u${++ids}` })

// The agent's shell command ends: the conversation keeps the tool_use row, then the tool_result row.
async function shell(b: Booted, command: unknown, over: { error?: string; text?: unknown; background?: boolean; name?: string; input?: unknown } = {}) {
  const id = `toolu_${++ids}`
  const input = 'input' in over ? over.input : { command, ...(over.background ? { run_in_background: true } : {}) }
  await b.fire(b.fake, 'session.append', { door: 'response' }, row('response', { type: 'assistant', content: [{ type: 'tool_use', id, name: over.name ?? 'Bash', input }] }))
  const content = over.text ?? over.error ?? ''
  await b.fire(b.fake, 'session.append', { door: 'tool-result' }, row('tool-result', { type: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, is_error: over.error !== undefined }] }))
  return id
}

beforeEach(() => resetAtoms())

describe('session start', () => {
  test('registers the command and the tool, and starts the timer', async () => {
    const b = boot()
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    expect(b.fake.calls.command).toEqual(['coverage'])
    expect(b.fake.calls.tool).toEqual(['coverage_status'])
    expect(b.fake.timers).toHaveLength(1)
    expect(viewOf()).toBeUndefined()
    b.fake.timers[0]!()
    await settle()
  })

  test('loads what an earlier session kept for the project, and ignores a damaged entry', async () => {
    const b = boot()
    b.fake.stored.set(`project:${ROOT}`, { history: [{ at: 1, lines: 50, scope: 'full' }], outcomes: { t: 'fpf' } })
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    expect(viewOf()).toMatchObject({ flaky: ['t'], staleFiles: 0, isScanning: false, root: ROOT })
    resetAtoms()
    b.fake.stored.set(`project:${ROOT}`, { history: 'nope', outcomes: {} })
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    expect(viewOf()).toBeUndefined()
    resetAtoms()
    b.fake.stored.set(`project:${ROOT}`, null)
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    expect(viewOf()).toBeUndefined()
  })

  test('the project is the session folder when it is not a repository', async () => {
    const b = boot(reports())
    b.fake.repo = null
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    await shell(b, 'npm test')
    expect(viewOf().root).toBe(ROOT)
  })
})

describe('reading the conversation rows', () => {
  test('a run with reports shows tests, coverage, the changed lines and what it kept', async () => {
    const b = boot(reports())
    b.fake.git.diff = DIFF
    await shell(b, 'cd /work/app && npm test 2>&1 | tail -5; echo done', { error: 'Exit code 1\nTests: 1 failed' })
    const last = viewOf().last!
    expect(last).toMatchObject({ command: 'npm test 2>&1', runner: 'npm test', ok: false, exitCode: 1, testsFrom: 'report', tests: { total: 2, failed: 1 }, coverage: { lines: 33.3 }, reports: 2 })
    expect(last.patch).toEqual({ covered: 0, total: 2, uncovered: [{ file: 'src/a.ts', count: 2 }] })
    expect(viewOf().isScanning).toBe(false)
    expect((b.fake.stored.get(`project:${ROOT}`) as { history: unknown[] }).history).toHaveLength(1)
    expect(b.fake.calls.process).toContain('git diff')
  })

  test('an error with no exit code counts as 1, a success as 0, and list content is read as text', async () => {
    const b = boot(reports())
    await shell(b, 'pytest', { error: 'something broke' })
    expect(viewOf().last!.exitCode).toBe(1)
    await shell(b, 'pytest', { text: [{ type: 'text', text: 'Tests  3 passed (3)' }, { type: 'image' }] })
    expect(viewOf().last!.exitCode).toBe(0)
    await shell(b, 'pytest', { text: { not: 'text' } })
    expect(viewOf().last!.exitCode).toBe(0)
  })

  test('commands that are not test runs, and tools that are not a shell, change nothing', async () => {
    const b = boot(reports())
    await shell(b, 'ls -la')
    await shell(b, undefined, { input: undefined })
    await shell(b, 123 as never)
    await shell(b, 'npm test', { name: 'Read' })
    await b.fire(b.fake, 'session.append', { door: 'response' }, row('response', { type: 'assistant', content: 'plain text' }))
    await b.fire(b.fake, 'session.append', { door: 'response' }, row('response', { type: 'assistant', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', name: 'Bash' }] }))
    await b.fire(b.fake, 'session.append', { door: 'tool-result' }, row('tool-result', { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'unknown', content: 'x' }, { type: 'text', text: 'y' }, { type: 'tool_result', content: 'no id' }] }))
    expect(viewOf()).toBeUndefined()
  })

  test('the table of calls waiting for a result stays bounded', async () => {
    const b = boot(reports())
    const many = Array.from({ length: 205 }, (_, index) => ({ type: 'tool_use', id: `bulk${index}`, name: 'Bash', input: { command: 'npm test' } }))
    await b.fire(b.fake, 'session.append', { door: 'response' }, row('response', { type: 'assistant', content: many }))
    // The oldest was dropped, the newest is still known.
    await b.fire(b.fake, 'session.append', { door: 'tool-result' }, row('tool-result', { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'bulk0', content: '' }] }))
    expect(viewOf()).toBeUndefined()
    await b.fire(b.fake, 'session.append', { door: 'tool-result' }, row('tool-result', { type: 'user', content: [{ type: 'tool_result', tool_use_id: 'bulk204', content: '' }] }))
    expect(viewOf().last!.runner).toBe('npm test')
  })

  test('a run with no reports at all says so', async () => {
    const b = boot()
    await shell(b, 'npm test', { text: 'Tests: 2 passed, 2 total' })
    expect(viewOf().last).toMatchObject({ testsFrom: 'output', reports: 0, tests: { total: 2 } })
    expect(viewOf().last!.note).toContain('no coverage or result report found')
    expect(b.fake.calls.process).not.toContain('git diff')
  })

  test('when git has no diff to give, there is no patch', async () => {
    const b = boot(reports())
    b.fake.git.failing = true
    await shell(b, 'npm test')
    expect(viewOf().last!.patch).toBeUndefined()
  })

  test('reading failures show on the band instead of vanishing', async () => {
    const b = boot(reports())
    b.fake.failures.store = true
    await shell(b, 'npm test')
    expect(viewOf().error).toBe('could not read the test reports: store is full')
    expect(viewOf().isScanning).toBe(false)

    const c = boot(reports())
    const id = `toolu_${++ids}`
    await c.fire(c.fake, 'session.append', { door: 'response' }, row('response', { type: 'assistant', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] }))
    c.fake.failures.clock = true
    await c.fire(c.fake, 'session.append', { door: 'tool-result' }, row('tool-result', { type: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: '' }] }))
    expect(viewOf().error).toBe('could not read the test run: clock is gone')

    const d = boot(reports())
    const down = `toolu_${++ids}`
    await d.fire(d.fake, 'session.append', { door: 'response' }, row('response', { type: 'assistant', content: [{ type: 'tool_use', id: down, name: 'Bash', input: { command: 'npm test' } }] }))
    d.fake.failures.clock = true
    ;(d.fake.$ as unknown as { clock: { now: () => Promise<number> } }).clock.now = async () => {
      throw 'plain text failure'
    }
    await d.fire(d.fake, 'session.append', { door: 'tool-result' }, row('tool-result', { type: 'user', content: [{ type: 'tool_result', tool_use_id: down, content: '' }] }))
    expect(viewOf().error).toBe('could not read the test run: plain text failure')
  })
})

describe('background runs', () => {
  test('are looked for until the reports show up', async () => {
    const b = boot()
    await shell(b, 'npm test', { background: true })
    expect(viewOf().isScanning).toBe(true)
    expect(viewOf().last).toBeUndefined()
    b.fake.timers.length = 0
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    await b.fake.timers[0]!()
    await settle()
    expect(viewOf().last).toBeUndefined()
    b.fake.files[`${ROOT}/coverage/lcov.info`] = file(LCOV, NOW + 5000)
    b.fake.time.now = NOW + 15_000
    await b.fake.timers[0]!()
    await settle()
    expect(viewOf().last).toMatchObject({ runner: 'npm test', coverage: { lines: 33.3 } })
    expect(viewOf().isScanning).toBe(false)
  })

  test('are given up on after ten minutes, with what was found', async () => {
    const b = boot()
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    await shell(b, 'npm test', { background: true })
    b.fake.time.now = NOW + 11 * 60_000
    await b.fake.timers[0]!()
    await settle()
    expect(viewOf().last!.note).toContain('ran in the background, results may be incomplete')
    expect(viewOf().isScanning).toBe(false)
  })

  test('a turn of the main agent checks them too, a subagent turn does not', async () => {
    const b = boot()
    await shell(b, 'npm test', { background: true })
    b.fake.files[`${ROOT}/lcov.info`] = file(LCOV, NOW + 5000)
    b.fake.time.now = NOW + 15_000
    await b.fire(b.fake, 'turn.complete', undefined, { agentId: 'sub', answer: '' })
    await settle()
    expect(viewOf().last).toBeUndefined()
    await b.fire(b.fake, 'turn.complete', undefined, { answer: '' })
    await settle()
    expect(viewOf().last).toBeDefined()
  })
})

describe('stale figures', () => {
  async function withRun(files: Record<string, FakeFile>) {
    const b = boot({ ...reports(), ...files })
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    await shell(b, 'npm test')
    return b
  }
  const tick = async (b: Booted) => {
    await b.fake.timers[0]!()
    await settle()
  }

  test('files changed after the run are counted', async () => {
    const b = await withRun({
      [`${ROOT}/src/a.ts`]: file('x', NOW + 5000),
      [`${ROOT}/src/old.ts`]: file('x', FRESH),
      [`${ROOT}/renamed.ts`]: file('x', NOW + 5000),
      [`${ROOT}/quoted name.ts`]: file('x', NOW + 5000),
      [`${ROOT}/folder/inner.ts`]: file('x', NOW + 5000),
    })
    b.fake.git.status = ' M src/a.ts\n M src/old.ts\nR  gone.ts -> renamed.ts\n?? "quoted name.ts"\n?? folder/\n?? missing.ts\nxx\n'
    b.fake.files[`${ROOT}/folder`] = file('', NOW + 5000, { kind: 'dir' })
    await tick(b)
    expect(viewOf().staleFiles).toBe(3)
    // Nothing changed since the last look: no redraw is needed.
    await tick(b)
    expect(viewOf().staleFiles).toBe(3)
  })

  test('nothing is read before a run, while a run is read, or when git cannot answer', async () => {
    const idle = boot()
    await idle.fire(idle.fake, 'session.start', undefined, { cwd: ROOT })
    await idle.fake.timers[0]!()
    await settle()
    expect(idle.fake.calls.process).toEqual([])

    const b = await withRun({})
    b.fake.git.status = ' M src/a.ts\n'
    b.fake.files[`${ROOT}/src/a.ts`] = file('x', NOW + 5000)
    atoms().set('coverage-inspector:view', { ...viewOf(), isScanning: true })
    await tick(b)
    expect(viewOf().staleFiles).toBe(0)
    atoms().set('coverage-inspector:view', { ...viewOf(), isScanning: false })
    b.fake.git.failing = true
    await tick(b)
    expect(viewOf().staleFiles).toBe(0)
    b.fake.git.failing = false
    b.fake.git.throwing = true
    await tick(b)
    expect(viewOf().staleFiles).toBe(0)
    b.fake.git.throwing = false
    b.fake.failures.stat = true
    await tick(b)
    expect(viewOf().staleFiles).toBe(0)
  })

  test('a long list of changes is cut at 200 files', async () => {
    const files = Object.fromEntries(Array.from({ length: 210 }, (_, index) => [`${ROOT}/f${index}.ts`, file('x', NOW + 5000)]))
    const b = await withRun(files)
    b.fake.git.status = Array.from({ length: 210 }, (_, index) => ` M f${index}.ts`).join('\n')
    await tick(b)
    expect(viewOf().staleFiles).toBe(200)
  })
})

describe('the command, the tool and the band', () => {
  test('/coverage reads the newest reports now', async () => {
    const b = boot(reports())
    const answer = (await b.fire(b.fake, 'command.run', { command: 'coverage' }, {})) as { text: string }
    expect(answer.text).toBe('Read the newest test reports and refreshed the Coverage band.')
    expect(viewOf().last).toMatchObject({ runner: 'manual scan', reports: 2, tests: { total: 2 } })
    expect(viewOf().last!.note).toContain('read by /coverage')
  })

  test('the tool answers with the view, after a run that is still being read', async () => {
    const b = boot(reports())
    await shell(b, 'npm test')
    const answer = (await b.fire(b.fake, 'tool.run', { tool: TOOL }, {})) as { result: string }
    expect(JSON.parse(answer.result).last.runner).toBe('npm test')
  })

  test('the tool denies when the project cannot be read', async () => {
    const b = boot(reports())
    await shell(b, 'npm test')
    ;(b.fake.$ as unknown as { session: { repo: () => Promise<never> } }).session.repo = async () => {
      throw new Error('no session')
    }
    expect(await b.fire(b.fake, 'tool.run', { tool: TOOL }, {})).toEqual({ deny: 'Coverage status failed: no session' })
  })

  test('the band is drawn, except above a survey', async () => {
    const b = boot(reports())
    await shell(b, 'npm test')
    const props = { hasSurvey: false, bodyColumns: 120, maxRows: 40 }
    const tree = await b.fire(b.fake, 'ui.render', { component: 'AbovePrompt' }, { props, surface: 'terminal' })
    expect(textsOf(tree)).toContain('Coverage Inspector')
    const surveyed = { props: { ...props, hasSurvey: true }, surface: 'terminal' }
    expect(await b.fire(b.fake, 'ui.render', { component: 'AbovePrompt' }, surveyed)).toBe(surveyed)
  })

  test('the row goes above Git Inspector', async () => {
    const b = boot()
    const rows = [{ plugin: 'bugs' }, { plugin: 'git-inspector' }, { plugin: PLUGIN }]
    const out = (await b.fire(b.fake, 'ui.render', { component: 'AbovePromptList' }, { props: { rows } })) as { props: { rows: { plugin: string }[] } }
    expect(out.props.rows.map(one => one.plugin)).toEqual(['bugs', PLUGIN, 'git-inspector'])
  })

  test('row order in every arrangement of the neighbours', () => {
    const names = (rows: string[]) => orderRows(rows.map(plugin => ({ plugin }))).map(one => one.plugin)
    expect(names(['bugs', 'git-inspector', 'session-inspector', PLUGIN])).toEqual(['bugs', PLUGIN, 'git-inspector', 'session-inspector'])
    expect(names(['session-inspector', 'git-inspector', PLUGIN])).toEqual([PLUGIN, 'session-inspector', 'git-inspector'])
    expect(names(['git-inspector', PLUGIN])).toEqual([PLUGIN, 'git-inspector'])
    expect(names(['bugs', 'session-inspector', PLUGIN])).toEqual(['bugs', PLUGIN, 'session-inspector'])
    expect(names(['bugs', PLUGIN])).toEqual(['bugs', PLUGIN])
    expect(names(['bugs', 'git-inspector'])).toEqual(['bugs', 'git-inspector'])
  })
})

describe('a project that cannot be read', () => {
  const breakRepo = (b: Booted) => {
    ;(b.fake.$ as unknown as { session: { repo: () => Promise<never> } }).session.repo = async () => {
      throw new Error('no session')
    }
  }

  test('a test run is reported as an error, and the next run still works', async () => {
    const b = boot(reports())
    const repo = b.fake.$.session.repo
    breakRepo(b)
    await shell(b, 'npm test')
    expect(viewOf().error).toBe('could not read the test run: no session')
    ;(b.fake.$ as unknown as { session: { repo: unknown } }).session.repo = repo
    await shell(b, 'npm test')
    expect(viewOf().last).toBeDefined()
    expect(viewOf().error).toBeUndefined()
  })

  test('the timer and the end of a turn swallow what they cannot read', async () => {
    const b = boot(reports())
    await b.fire(b.fake, 'session.start', undefined, { cwd: ROOT })
    await shell(b, 'npm test')
    breakRepo(b)
    await b.fake.timers[0]!()
    await b.fire(b.fake, 'turn.complete', undefined, { answer: '' })
    await settle()
    expect(viewOf().last).toBeDefined()

    const c = boot()
    await c.fire(c.fake, 'session.start', undefined, { cwd: ROOT })
    await shell(c, 'npm test', { background: true })
    c.fake.failures.clock = true
    await c.fake.timers[0]!()
    await c.fire(c.fake, 'turn.complete', undefined, { answer: '' })
    await settle()
    expect(viewOf().isScanning).toBe(true)
  })
})

describe('options and fallbacks', () => {
  test('a custom command and a coverage target from the settings', async () => {
    const b = boot(reports(), { testCommands: '^\\./ci\\.sh', coverageTarget: 90 })
    await shell(b, './ci.sh --fast')
    expect(viewOf().last!.runner).toBe('./ci.sh')
    const tree = await b.fire(b.fake, 'ui.render', { component: 'AbovePrompt' }, { props: { hasSurvey: false, bodyColumns: 120, maxRows: 40 }, surface: 'terminal' })
    expect(textsOf(tree).some(text => text.includes('raise coverage from 33.3% to 90%'))).toBe(true)
    const wrong = boot(reports(), { coverageTarget: -5 })
    await shell(wrong, 'npm test')
    expect(viewOf().last).toBeDefined()
    const none = boot(reports(), {})
    await shell(none, 'npm test')
    expect(viewOf().last).toBeDefined()
  })

  test('every hook has a handler that lets the event through when the hook fails', async () => {
    const b = boot()
    const event = { any: 'thing' }
    for (const hook of b.hooks.filter(one => one.catcher)) expect(await hook.catcher!(b.fake.$, event, async (x: unknown) => x)).toBe(event)
    expect(b.hooks.filter(one => one.catcher).map(one => one.event)).toEqual(['session.start', 'session.append', 'session.append', 'turn.complete'])
  })

  test('background runs and turns that finish before any module state exists', async () => {
    const b = boot()
    await b.fire(b.fake, 'turn.complete', undefined, { answer: '' })
    await settle()
    expect(viewOf()).toBeUndefined()
  })
})
