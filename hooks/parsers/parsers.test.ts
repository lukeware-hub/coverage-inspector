import { expect, test } from 'claude-code/testing'

import { parseCobertura } from './cobertura'
import { parseGoCover } from './gocover'
import { parseJacoco } from './jacoco'
import { parseCoveragePy, parseIstanbulFinal, parseIstanbulSummary, parseJsonCoverage } from './json-reports'
import { parseLcov } from './lcov'
import { countCases, parseJunit, parseSummaryOutput, parseTrx } from './results'

test('lcov: lines, branches and functions per file, CRLF too', () => {
  const text = ['TN:', 'SF:src/a.ts', 'FNF:2', 'FNH:1', 'DA:1,3', 'DA:2,0', 'BRDA:1,0,0,2', 'BRDA:1,0,1,-', 'end_of_record', 'SF:src/b.ts', 'DA:5,1', 'end_of_record', ''].join('\r\n')
  const files = parseLcov(text)
  expect(files.map(file => file.file)).toEqual(['src/a.ts', 'src/b.ts'])
  expect(files[0]).toMatchObject({ lines: { 1: 3, 2: 0 }, branches: { covered: 1, total: 2 }, functions: { covered: 1, total: 2 } })
  expect(files[1]!.branches).toBeUndefined()
})

test('cobertura: line hits, branch conditions and methods, classes of one file merged by the caller', () => {
  const xml = `<coverage><packages><package><classes>
    <class name="A" filename="pkg/a.py"><methods><method name="f"><lines><line number="1" hits="2"/></lines></method><method name="g"><lines><line number="5" hits="0"/></lines></method></methods>
      <lines><line number="1" hits="2" branch="true" condition-coverage="50% (1/2)"/><line number="5" hits="0"/></lines></class>
  </classes></package></packages></coverage>`
  const [file] = parseCobertura(xml)
  expect(file).toMatchObject({ file: 'pkg/a.py', lines: { 1: 2, 5: 0 }, branches: { covered: 1, total: 2 }, functions: { covered: 1, total: 2 } })
})

test('jacoco: package path joined to the source file, covered instructions make a hit', () => {
  const xml = `<report name="x"><package name="com/acme"><sourcefile name="A.java">
    <line nr="3" mi="0" ci="4" mb="0" cb="0"/><line nr="4" mi="2" ci="0" mb="1" cb="1"/>
    <counter type="BRANCH" missed="1" covered="1"/><counter type="METHOD" missed="0" covered="2"/></sourcefile></package></report>`
  expect(parseJacoco(xml)).toEqual([{ file: 'com/acme/A.java', lines: { 3: 4, 4: 0 }, branches: { covered: 1, total: 2 }, functions: { covered: 2, total: 2 } }])
})

test('istanbul final: a line is hit when a statement that starts on it ran', () => {
  const json = {
    '/p/a.ts': {
      path: '/p/a.ts',
      statementMap: { 0: { start: { line: 1 } }, 1: { start: { line: 2 } } },
      s: { 0: 3, 1: 0 },
      f: { 0: 1, 1: 0 },
      b: { 0: [1, 0] },
    },
  }
  expect(parseIstanbulFinal(json)).toEqual([{ file: '/p/a.ts', lines: { 1: 3, 2: 0 }, functions: { covered: 1, total: 2 }, branches: { covered: 1, total: 2 } }])
  expect(parseJsonCoverage(json)).toHaveLength(1)
})

test('istanbul summary: totals per file, the whole-run total is skipped', () => {
  const json = { total: { lines: { total: 10, covered: 5 } }, '/p/a.ts': { lines: { total: 10, covered: 5 }, branches: { total: 0, covered: 0 }, functions: { total: 2, covered: 1 } } }
  expect(parseIstanbulSummary(json)).toEqual([{ file: '/p/a.ts', linesTotal: { covered: 5, total: 10 }, branches: undefined, functions: { covered: 1, total: 2 } }])
  expect(parseJsonCoverage(json)).toHaveLength(1)
})

test('coverage.py json: executed and missing lines', () => {
  const json = { meta: {}, files: { 'a.py': { executed_lines: [1, 2], missing_lines: [3], summary: { num_branches: 4, covered_branches: 1 } } } }
  expect(parseCoveragePy(json)).toEqual([{ file: 'a.py', lines: { 1: 1, 2: 1, 3: 0 }, branches: { covered: 1, total: 4 } }])
  expect(parseJsonCoverage({ unrelated: true })).toBeUndefined()
})

test('go cover profile: every line of a block gets its count', () => {
  const text = 'mode: set\nexample.com/m/a.go:3.10,5.2 2 1\nexample.com/m/a.go:7.1,7.9 1 0\n'
  expect(parseGoCover(text)).toEqual([{ file: 'example.com/m/a.go', lines: { 3: 1, 4: 1, 5: 1, 7: 0 } }])
  expect(parseGoCover('not a profile')).toEqual([])
})

test('junit: outcomes, times, file and line, class name joined to the test name', () => {
  const xml = `<testsuite><testcase classname="tests.test_a" name="ok" time="0.5" file="tests/test_a.py" line="3"/>
    <testcase classname="tests.test_a" name="bad" time="2.25"><failure message="x &amp; y">trace</failure></testcase>
    <testcase name="later"><skipped/></testcase></testsuite>`
  const cases = parseJunit(xml)
  expect(cases).toEqual([
    { name: 'tests.test_a > ok', outcome: 'passed', ms: 500, file: 'tests/test_a.py', line: 3 },
    { name: 'tests.test_a > bad', outcome: 'failed', ms: 2250, file: undefined, line: undefined },
    { name: 'later', outcome: 'skipped', ms: undefined, file: undefined, line: undefined },
  ])
  expect(countCases(cases)).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 })
})

test('trx: outcome and duration', () => {
  const xml = '<TestRun><UnitTestResult testName="A" outcome="Passed" duration="00:00:01.5"/><UnitTestResult testName="B" outcome="Failed" duration="00:00:00.2"/></TestRun>'
  expect(parseTrx(xml)).toEqual([
    { name: 'A', outcome: 'passed', ms: 1500 },
    { name: 'B', outcome: 'failed', ms: 200 },
  ])
})

test('summary lines of the common runners', () => {
  expect(parseSummaryOutput('Tests:       1 failed, 4 passed, 5 total')).toEqual({ total: 5, passed: 4, failed: 1, skipped: 0 })
  expect(parseSummaryOutput(' Tests  1 failed | 4 passed | 1 skipped (6)')).toEqual({ total: 6, passed: 4, failed: 1, skipped: 1 })
  expect(parseSummaryOutput('=== 2 failed, 3 passed, 1 skipped in 0.52s ===')).toEqual({ total: 6, passed: 3, failed: 2, skipped: 1 })
  expect(parseSummaryOutput('test result: ok. 5 passed; 0 failed; 1 ignored\ntest result: FAILED. 2 passed; 1 failed; 0 ignored')).toEqual({ total: 9, passed: 7, failed: 1, skipped: 1 })
  expect(parseSummaryOutput('Passed!  - Failed:     0, Passed:     5, Skipped:     1, Total:     6, Duration: 1 s')).toEqual({ total: 6, passed: 5, failed: 0, skipped: 1 })
  expect(parseSummaryOutput('ok  \texample.com/m/a\t0.1s\nFAIL\texample.com/m/b\t0.2s')).toEqual({ total: 2, passed: 1, failed: 1, skipped: 0 })
  expect(parseSummaryOutput('5 examples, 1 failure, 1 pending')).toEqual({ total: 5, passed: 3, failed: 1, skipped: 1 })
  expect(parseSummaryOutput('Tests run: 5, Failures: 1, Errors: 1, Skipped: 1')).toEqual({ total: 5, passed: 2, failed: 2, skipped: 1 })
  expect(parseSummaryOutput('nothing useful here')).toBeUndefined()
})
