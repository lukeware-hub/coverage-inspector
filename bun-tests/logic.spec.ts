import { describe, expect, test } from 'bun:test'

import type { RunRecord, Stored } from '../types'
import { mergeCoverage, normalize, parseChangedLines, patchCoverage, samePath, summarize } from '../hooks/coverage'
import { detectRun, parts, scopeOf, userPatterns } from '../hooks/detect'
import { attrs, decode, elements, tags } from '../hooks/parsers/xml'
import { addRun, buildRun, flakyTests, isFlaky } from '../hooks/run'
import { findReports, kindOf, readReports } from '../hooks/scan'
import { NOW, makeFake } from './fake'

describe('xml reader', () => {
  test('entities, attributes, elements and tags', () => {
    expect(decode('a &lt; b &amp; &#65; &unknown;')).toBe('a < b & A &unknown;')
    expect(attrs(`a="1" b='two' c:d="x&amp;y"`)).toEqual({ a: '1', b: 'two', 'c:d': 'x&y' })
    expect(elements('<a x="1"/><a y="2">in</a>', 'a')).toEqual([{ attrs: { x: '1' }, inner: '' }, { attrs: { y: '2' }, inner: 'in' }])
    expect(tags('<l n="1"/><l n="2">', 'l')).toEqual([{ n: '1' }, { n: '2' }])
  })
})

describe('command detection', () => {
  test('quotes, backslashes and separators', () => {
    expect(parts('a && b || c; d | e\nf').map(part => part.typed)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(parts('echo "a \\" ; b" ; ls').map(part => part.typed)).toEqual(['echo "a \\" ; b"', 'ls'])
    expect(parts("echo 'a ; b' | cat").map(part => part.plain)).toEqual(['echo ""', 'cat'])
    expect(parts('say "unterminated ; here').map(part => part.typed)).toEqual(['say "unterminated ; here'])
    expect(parts("echo 'it\\'s' ; ls").length).toBeGreaterThan(0)
    expect(parts('   ')).toEqual([])
    expect(parts('FOO=1 BAR=2 pytest')[0]!.plain).toBe('pytest')
  })

  test('what counts as a test run', () => {
    expect(detectRun('')).toBeUndefined()
    expect(detectRun('   ')).toBeUndefined()
    expect(detectRun('pytest --help')).toBeUndefined()
    expect(detectRun('git commit -m "npm test"')).toBeUndefined()
    expect(detectRun('npm test')).toEqual({ runner: 'npm test', scope: 'full', command: 'npm test' })
    expect(detectRun('./ci.sh', userPatterns('ci\\.sh'))).toEqual({ runner: './ci.sh', scope: 'full', command: './ci.sh' })
    expect(detectRun('   ', [/x/])).toBeUndefined()
    expect(detectRun('ls', [/zzz/])).toBeUndefined()
    expect(userPatterns('')).toEqual([])
    expect(userPatterns('a, (, b')).toHaveLength(2)
  })

  test('full and partial scopes', () => {
    expect(scopeOf('pytest')).toBe('full')
    expect(scopeOf('pytest -k login')).toBe('partial')
    expect(scopeOf('pytest tests/a.py')).toBe('partial')
    expect(scopeOf('jest a.test.ts')).toBe('partial')
    expect(scopeOf('go test ./...')).toBe('full')
    expect(scopeOf('vitest --coverage')).toBe('full')
  })
})

describe('coverage maths', () => {
  test('paths', () => {
    expect(normalize('.\\src\\a.ts')).toBe('src/a.ts')
    expect(samePath('A.ts', 'a.ts')).toBe(true)
    expect(samePath('x/a.ts', 'y/a.ts')).toBe(false)
    expect(samePath('a.ts', 'src/a.ts')).toBe(true)
    expect(samePath('src/a.ts', 'a.ts')).toBe(true)
  })

  test('merging reports of one file takes the best of each', () => {
    const merged = mergeCoverage([
      { file: 'a.ts', linesTotal: { covered: 1, total: 2 }, branches: { covered: 1, total: 2 }, functions: { covered: 1, total: 1 } },
      { file: 'src/a.ts', lines: { 1: 1 }, branches: { covered: 3, total: 4 }, functions: { covered: 0, total: 0 } },
      { file: 'src/a.ts', lines: { 1: 0, 2: 2 }, linesTotal: { covered: 9, total: 9 }, branches: undefined, functions: undefined },
      { file: 'b.ts' },
      { file: 'b.ts', lines: { 5: 1 } },
      { file: 'c.ts', lines: { 1: 1 }, branches: { covered: 1, total: 2 } },
      { file: 'c.ts', branches: { covered: 0, total: 1 } },
    ])
    expect(merged.map(file => file.file)).toEqual(['a.ts', 'b.ts', 'c.ts'])
    expect(merged[0]).toMatchObject({ lines: { 1: 1, 2: 2 }, linesTotal: { covered: 1, total: 2 }, branches: { covered: 3, total: 4 }, functions: { covered: 1, total: 1 } })
    expect(merged[1]!.lines).toEqual({ 5: 1 })
    expect(merged[2]!.branches).toEqual({ covered: 1, total: 2 })
  })

  test('summaries', () => {
    expect(summarize([])).toEqual({ lines: undefined, branches: undefined, functions: undefined })
    expect(summarize([{ file: 'a', linesTotal: { covered: 1, total: 2 }, branches: { covered: 1, total: 4 }, functions: { covered: 1, total: 1 } }, { file: 'b', lines: { 1: 1, 2: 0 } }])).toEqual({ lines: 50, branches: 25, functions: 100 })
    expect(summarize([{ file: 'a' }]).lines).toBeUndefined()
  })

  test('changed lines come from the hunks, paths with spaces too', () => {
    const diff = ['+++ b/a b.ts', '@@ -1 +1 @@', '+++ "b/q r.ts"', '@@ -0,0 +4,2 @@', '@@ garbage @@', '+++ /dev/null', '@@ -1 +0,0 @@', '@@ -1 +9 @@'].join('\n')
    const changed = parseChangedLines(diff)
    expect([...changed.get('a b.ts')!]).toEqual([1])
    expect([...changed.get('q r.ts')!]).toEqual([4, 5])
    expect(changed.size).toBe(2)
    const huge = parseChangedLines('+++ b/h.ts\n@@ -0,0 +1,99999 @@')
    expect(huge.get('h.ts')!.size).toBe(20000)
  })

  test('patch coverage', () => {
    const changed = new Map([['src/a.ts', new Set([1, 2, 3])], ['no-lines.ts', new Set([1])], ['other.ts', new Set([1])], ['b.ts', new Set([1, 2])]])
    const patch = patchCoverage(changed, [{ file: 'a.ts', lines: { 1: 1, 2: 0 } }, { file: 'no-lines.ts', linesTotal: { covered: 1, total: 2 } }, { file: 'b.ts', lines: { 1: 0, 2: 0 } }])
    expect(patch).toEqual({ covered: 1, total: 4, uncovered: [{ file: 'b.ts', count: 2 }, { file: 'src/a.ts', count: 1 }] })
    expect(patchCoverage(new Map(), [])).toBeUndefined()
    const many = new Map(Array.from({ length: 8 }, (_, index) => [`f${index}.ts`, new Set([1])] as const))
    expect(patchCoverage(many, many.size ? [...many.keys()].map(file => ({ file, lines: { 1: 0 } })) : [])!.uncovered).toHaveLength(5)
  })
})

describe('runs and history', () => {
  const none = { coverage: [], cases: [], count: 0, skipped: 0 }
  const base = { command: 'c', runner: 'r', scope: 'full' as const, startedAt: 0, endedAt: 1000 }

  test('buildRun', () => {
    const lcov = { coverage: [{ file: 'a', lines: { 1: 1, 2: 0 } }], cases: [{ name: 'n', outcome: 'passed' as const, ms: 5 }, { name: 'm', outcome: 'failed' as const }], count: 2, skipped: 1 }
    const record = buildRun(base, lcov, undefined, undefined)
    expect(record).toMatchObject({ ok: false, testsFrom: 'report', tests: { total: 2, failed: 1 }, slowest: { name: 'n', ms: 5 }, coverage: { lines: 50 }, reports: 2, note: '1 report could not be read' })
    expect(buildRun(base, { ...none, skipped: 2 }, undefined, undefined).note).toBe('no coverage or result report found; 2 reports could not be read')
    expect(buildRun(base, { coverage: [], cases: [{ name: 'n', outcome: 'passed' }], count: 1, skipped: 0 }, undefined, undefined).note).toBe('no coverage report found')
    expect(buildRun({ ...base, exitCode: 3 }, { ...none, count: 1 }, undefined, undefined).note).toBe('no coverage report found; the command exited with code 3')
    const quiet = buildRun({ ...base, exitCode: 0, output: 'nothing' }, { ...none, count: 1 }, undefined, undefined)
    expect(quiet.ok).toBe(true)
    expect(quiet.tests).toBeUndefined()
    expect(quiet.testsFrom).toBeUndefined()
    expect(buildRun({ ...base, exitCode: 1, output: 'Tests: 1 failed, 1 total' }, { ...none, count: 1 }, undefined, undefined).note).toBe('no coverage report found')
    expect(buildRun(base, { ...none, cases: [{ name: 'z', outcome: 'passed', ms: 0 }], count: 1 }, undefined, undefined).slowest).toBeUndefined()
    const timed = [{ name: 'a', outcome: 'passed' as const, ms: 5 }, { name: 'b', outcome: 'passed' as const, ms: 9 }, { name: 'c', outcome: 'passed' as const }]
    expect(buildRun(base, { ...none, cases: timed, count: 1 }, undefined, undefined).slowest).toEqual({ name: 'b', ms: 9 })
  })

  test('flaky tests', () => {
    expect(isFlaky('fpf')).toBe(true)
    expect(isFlaky('ffpp')).toBe(false)
    expect(flakyTests({ history: [], outcomes: { a: 'fpf', b: 'ffp' } })).toEqual(['a'])
  })

  test('addRun keeps twenty runs, watches failing tests, prunes steady ones and caps the table', () => {
    const record = buildRun(base, { ...none, cases: [{ name: 'x', outcome: 'passed' }], count: 1 }, undefined, undefined) as RunRecord
    let stored: Stored | undefined
    for (let index = 0; index < 25; index++) stored = addRun(stored, record, [{ name: 'flip', outcome: index % 2 ? 'passed' : 'failed' }, { name: 'skip', outcome: 'skipped' }, { name: 'steady', outcome: 'passed' }])
    expect(stored!.history).toHaveLength(20)
    expect(stored!.outcomes.flip).toHaveLength(10)
    expect(stored!.outcomes.steady).toBeUndefined()
    expect(stored!.outcomes.skip).toBeUndefined()
    expect(stored!.history[0]!.passRate).toBe(100)

    const failing = Array.from({ length: 301 }, (_, index) => ({ name: `t${index}`, outcome: 'failed' as const }))
    const capped = addRun(undefined, record, failing)
    expect(Object.keys(capped.outcomes)).toHaveLength(300)
    const again = addRun(capped, record, [{ name: 't0', outcome: 'passed' }])
    expect(again.outcomes.t0).toBe('fp')
    const quiet = addRun({ history: [], outcomes: { solid: 'p'.repeat(10) } }, record, [{ name: 'solid', outcome: 'passed' }])
    expect(quiet.outcomes.solid).toBeUndefined()
    const rated = addRun(undefined, { ...record, tests: { total: 4, passed: 3, failed: 1, skipped: 0 } }, [])
    expect(rated.history[0]!.passRate).toBe(75)
  })

  test('the change since the last full run', () => {
    const reports = { coverage: [{ file: 'a', lines: { 1: 1 } }], cases: [], count: 1, skipped: 0 }
    const stored: Stored = { history: [{ at: 1, lines: 40, scope: 'full' }, { at: 2, scope: 'full' }], outcomes: {} }
    expect(buildRun(base, reports, undefined, stored).previousLines).toBe(40)
    expect(buildRun(base, reports, undefined, undefined).previousLines).toBeUndefined()
    expect(buildRun({ ...base, scope: 'partial' }, reports, undefined, stored).previousLines).toBeUndefined()
  })
})

describe('finding and reading reports', () => {
  const fresh = NOW - 1000
  const file = (text: string, mtimeMs = fresh, extra = {}) => ({ text, mtimeMs, ...extra })

  test('kinds of file', () => {
    for (const [name, kind] of [['lcov.info', 'lcov'], ['x.lcov', 'lcov'], ['cover.out', 'go'], ['coverage.txt', 'go'], ['coverage-summary.json', 'json'], ['coverage.json', 'json'], ['a.trx', 'trx'], ['jacoco-merged.xml', 'xml'], ['cobertura.xml', 'xml'], ['x.coverage.xml', 'xml'], ['TEST-a.xml', 'junit'], ['junit.xml', 'junit'], ['results.xml', 'junit'], ['readme.md', undefined]] as const) {
      expect(kindOf(name)).toBe(kind)
    }
  })

  test('the walk skips build junk, links, old files and deep folders, and caps what it keeps', async () => {
    const fake = makeFake({
      '/r/lcov.info': file(''),
      '/r/node_modules/p/lcov.info': file(''),
      '/r/pkg/coverage/lcov.info': file(''),
      '/r/old/lcov.info': file('', NOW - 3_600_000),
      '/r/link/lcov.info': file('', fresh),
      '/r/a/b/c/d/e/f/g/h/lcov.info': file(''),
      '/r/notes.md': file(''),
      '/r/odd': file('', fresh, { kind: 'other' }),
    })
    const found = await findReports(fake.$, '/r', NOW - 5000)
    expect(found.map(one => one.path).sort()).toEqual(['/r/lcov.info', '/r/link/lcov.info', '/r/pkg/coverage/lcov.info'])
    fake.files['/r/linked/lcov.info'] = file('')
    // A directory that is a link is not entered: list it as a link by giving the folder entry a link flag.
    const linked = makeFake({ '/r/a.txt': file('', fresh, { isLink: true, kind: 'dir' }), '/r/lcov.info': file('') })
    expect((await findReports(linked.$, '/r', 0)).map(one => one.path)).toEqual(['/r/lcov.info'])

    const many = makeFake(Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`/r/lcov${index}.lcov`, file('', fresh + index)])))
    expect(await findReports(many.$, '/r', 0)).toHaveLength(40)

    const heavy = makeFake({ ...Object.fromEntries(Array.from({ length: 20_005 }, (_, index) => [`/r/f${index}.md`, file('')])), '/r/sub/lcov.info': file('') })
    expect(await findReports(heavy.$, '/r', 0)).toEqual([])

    const broken = makeFake({ '/r/lcov.info': file('') })
    broken.failures.listing = true
    expect(await findReports(broken.$, '/r', 0)).toEqual([])
  })

  test('every kind is parsed, and what cannot be read is counted, never guessed', async () => {
    const fake = makeFake({
      '/r/lcov.info': file('SF:a.ts\nDA:1,1\nend_of_record\n'),
      '/r/empty.lcov': file(''),
      '/r/cover.out': file('mode: set\nx/a.go:1.1,2.2 1 1\n'),
      '/r/coverage-final.json': file(JSON.stringify({ '/p/a.ts': { path: '/p/a.ts', statementMap: { 0: { start: { line: 1 } } }, s: { 0: 1 } } })),
      '/r/coverage.json': file('{"unknown": true}'),
      '/r/bad/coverage-summary.json': file('not json'),
      '/r/jacoco.xml': file('<report name="x"><counter type="LINE" missed="0" covered="1"/><package name="p"><sourcefile name="A.java"><line nr="1" mi="0" ci="1" mb="0" cb="0"/></sourcefile></package></report>'),
      '/r/cobertura.xml': file('<coverage><packages><package><classes><class filename="a.py"><lines><line number="1" hits="1"/></lines></class></classes></package></packages></coverage>'),
      '/r/coverage-other.xml': file('<something/>'),
      '/r/junit.xml': file('<testsuite><testcase name="t"/></testsuite>'),
      '/r/results.xml': file('<testsuites></testsuites>'),
      '/r/TEST-none.xml': file('<html/>'),
      '/r/r.trx': file('<TestRun><UnitTestResult testName="T" outcome="NotExecuted" duration="00:00:00"/></TestRun>'),
    })
    const found = await findReports(fake.$, '/r', 0)
    const reports = await readReports(fake.$, [...found, { path: '/r/missing.lcov', kind: 'lcov' }])
    expect(reports.coverage.map(one => one.file).sort()).toEqual(['/p/a.ts', 'A.java'.replace('A.java', 'p/A.java'), 'a.py', 'a.ts', 'x/a.go'].sort())
    expect(reports.cases.map(one => one.name).sort()).toEqual(['T', 't'])
    expect(reports.count).toBe(8)
    expect(reports.skipped).toBe(6)

    const bytes = makeFake({ '/r/lcov.info': file('x') })
    bytes.$.fs.read = (async () => ({ base64: 'eA==' })) as never
    expect(await readReports(bytes.$, [{ path: '/r/lcov.info', kind: 'lcov' }])).toMatchObject({ count: 0, skipped: 1 })
  })
})
