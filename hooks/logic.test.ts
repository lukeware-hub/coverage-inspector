import { expect, test } from 'claude-code/testing'

import type { RunRecord, Stored } from '../types'
import { mergeCoverage, parseChangedLines, patchCoverage, samePath, summarize } from './coverage'
import { detectRun, userPatterns } from './detect'
import { addRun, buildRun, isFlaky } from './run'
import { kindOf } from './scan'
import { sparkline } from './band'

test('test commands of many languages are detected, other commands are not', () => {
  for (const command of ['npm test', 'pnpm run test:unit', 'npx vitest run --coverage', 'pytest -q', 'python -m pytest', 'go test ./...', 'dotnet test', 'mvn -q verify', './gradlew test', 'cargo nextest run', 'bundle exec rspec', 'flutter test', 'cd app && npm test | tee out.txt', 'FOO=1 yarn test', 'make test']) {
    expect(detectRun(command)?.runner, command).toBeDefined()
  }
  for (const command of ['ls', 'git commit -m "fix npm test"', 'echo pytest', 'grep -r jest src', 'pytest --help', 'npm install', 'cat package.json', '']) {
    expect(detectRun(command), command).toBeUndefined()
  }
})

test('only the part of a compound command that ran the tests is kept, as typed, and quotes do not split it', () => {
  expect(detectRun('mkdir -p /c/demo && cd /c/demo && npm test 2>&1 | tail -8; echo; head -8 lcov.info')?.command).toBe('npm test 2>&1')
  expect(detectRun('cd app; FOO=1 pytest -k "a; b"')?.command).toBe('FOO=1 pytest -k "a; b"')
  expect(detectRun('echo "npm test" && ls')).toBeUndefined()
})

test('a run of the whole project is full, a slice of it is partial', () => {
  expect(detectRun('bun test --coverage')?.runner).toBe('bun test')
  expect(detectRun('bun run test')?.runner).toBe('npm test')
  expect(detectRun('npm test')?.scope).toBe('full')
  expect(detectRun('go test ./...')?.scope).toBe('full')
  expect(detectRun('pytest')?.scope).toBe('full')
  expect(detectRun('npx vitest run --coverage --reporter=junit --outputFile=reports/junit.xml')?.scope).toBe('full')
  expect(detectRun('pytest tests/test_a.py')?.scope).toBe('partial')
  expect(detectRun('pytest -k login')?.scope).toBe('partial')
  expect(detectRun('go test ./pkg/auth')?.scope).toBe('partial')
  expect(detectRun('npx jest src/a.test.ts')?.scope).toBe('partial')
})

test('the user adds commands with comma-separated patterns, a bad pattern is left out', () => {
  const extra = userPatterns('^\\./ci\\.sh, make verify, (')
  expect(extra).toHaveLength(2)
  expect(detectRun('./ci.sh --fast', extra)?.runner).toBe('./ci.sh')
  expect(detectRun('make verify', extra)).toBeDefined()
  expect(detectRun('./other.sh', extra)).toBeUndefined()
})

test('report files are told apart by name', () => {
  expect(kindOf('lcov.info')).toBe('lcov')
  expect(kindOf('coverage-final.json')).toBe('json')
  expect(kindOf('cover.out')).toBe('go')
  expect(kindOf('coverage.xml')).toBe('xml')
  expect(kindOf('jacoco.xml')).toBe('xml')
  expect(kindOf('TEST-com.acme.AppTest.xml')).toBe('junit')
  expect(kindOf('junit.xml')).toBe('junit')
  expect(kindOf('results.trx')).toBe('trx')
  expect(kindOf('package.json')).toBeUndefined()
})

test('paths from different roots name one file when one ends the other on a folder boundary', () => {
  expect(samePath('src/a.ts', 'C:\\work\\app\\src\\a.ts')).toBe(true)
  expect(samePath('a.ts', 'src/xa.ts')).toBe(false)
  expect(samePath('example.com/m/pkg/a.go', 'pkg/a.go')).toBe(true)
})

test('overlapping reports of one file are merged, not added', () => {
  const merged = mergeCoverage([
    { file: 'src/a.ts', lines: { 1: 1, 2: 0 }, branches: { covered: 1, total: 2 } },
    { file: '/abs/src/a.ts', lines: { 2: 4, 3: 0 }, branches: { covered: 2, total: 4 } },
  ])
  expect(merged).toHaveLength(1)
  expect(merged[0]!.lines).toEqual({ 1: 1, 2: 4, 3: 0 })
  expect(summarize(merged)).toEqual({ lines: 66.7, branches: 50, functions: undefined })
})

test('summaries use line totals when a report has no line numbers', () => {
  expect(summarize([{ file: 'a', linesTotal: { covered: 5, total: 10 } }, { file: 'b', lines: { 1: 1, 2: 1 } }]).lines).toBe(58.3)
  expect(summarize([])).toEqual({ lines: undefined, branches: undefined, functions: undefined })
})

const DIFF = ['diff --git a/src/a.ts b/src/a.ts', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1,0 +2,2 @@', '+x', '+y', '@@ -9 +11 @@', '-z', '+w', 'diff --git a/old.ts b/old.ts', '--- a/old.ts', '+++ /dev/null', '@@ -1,3 +0,0 @@'].join('\n')

test('the changed lines come from the diff hunks, a deleted file adds none', () => {
  const changed = parseChangedLines(DIFF)
  expect([...changed.get('src/a.ts')!]).toEqual([2, 3, 11])
  expect(changed.has('old.ts')).toBe(false)
})

test('patch coverage counts only lines a report knows, and names the worst file', () => {
  const patch = patchCoverage(parseChangedLines(DIFF), [{ file: '/abs/src/a.ts', lines: { 2: 1, 3: 0, 11: 0, 50: 0 } }])
  expect(patch).toEqual({ covered: 1, total: 3, uncovered: [{ file: 'src/a.ts', count: 2 }] })
  expect(patchCoverage(parseChangedLines(DIFF), [{ file: 'other.ts', lines: { 1: 1 } }])).toBeUndefined()
})

const finished = { command: 'npm test', runner: 'npm test', scope: 'full' as const, startedAt: 1000, endedAt: 4000 }
const noReports = { coverage: [], cases: [], count: 0, skipped: 0 }

test('a run with no report says so and keeps the numbers it has', () => {
  const record = buildRun({ ...finished, exitCode: 1, output: 'Tests: 1 failed, 4 passed, 5 total' }, noReports, undefined, undefined)
  expect(record).toMatchObject({ ok: false, testsFrom: 'output', tests: { total: 5, passed: 4, failed: 1, skipped: 0 }, durationMs: 3000, reports: 0 })
  expect(record.coverage).toBeUndefined()
  expect(record.note).toContain('no coverage or result report found')
})

test('a failing command with no failed test still fails the run', () => {
  const record = buildRun({ ...finished, exitCode: 2 }, noReports, undefined, undefined)
  expect(record.ok).toBe(false)
  expect(record.note).toContain('exited with code 2')
})

test('the change in coverage is measured against the last full run, a partial run has none', () => {
  const reports = { coverage: [{ file: 'a', lines: { 1: 1, 2: 1, 3: 1, 4: 0 } }], cases: [], count: 1, skipped: 0 }
  const stored: Stored = { history: [{ at: 1, lines: 70, scope: 'full' }, { at: 2, lines: 10, scope: 'partial' }], outcomes: {} }
  expect(buildRun(finished, reports, undefined, stored).previousLines).toBe(70)
  expect(buildRun({ ...finished, scope: 'partial' }, reports, undefined, stored).previousLines).toBeUndefined()
})

test('a test that fails, passes and fails again is flaky, one that was fixed is not', () => {
  expect(isFlaky('fpf')).toBe(true)
  expect(isFlaky('pfp')).toBe(true)
  expect(isFlaky('ffp')).toBe(false)
  expect(isFlaky('f')).toBe(false)
})

test('the history keeps twenty runs and the outcomes of the tests that failed', () => {
  const record = buildRun(finished, noReports, undefined, undefined) as RunRecord
  let stored: Stored | undefined
  for (let run = 0; run < 25; run++) stored = addRun(stored, record, [{ name: 'flip', outcome: run % 2 ? 'passed' : 'failed' }, { name: 'steady', outcome: 'passed' }])
  expect(stored!.history).toHaveLength(20)
  expect(stored!.outcomes.flip).toHaveLength(10)
  expect(stored!.outcomes.steady).toBeUndefined()
})

test('the sparkline is as high as each value stands between the lowest and the highest', () => {
  expect(sparkline([1, 2, 3])).toBe('▁▅█')
  expect(sparkline([5, 5])).toBe('██')
  expect(sparkline([])).toBe('')
})
