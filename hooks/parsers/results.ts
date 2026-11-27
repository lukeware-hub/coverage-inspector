import type { TestCase, TestCounts } from '../../types'
import { elements, attrs } from './xml'

// JUnit XML: written by pytest, jest-junit, vitest, Maven surefire, Gradle, go-junit-report, rspec, phpunit and more.
export function parseJunit(xml: string): TestCase[] {
  return elements(xml, 'testcase').map(({ attrs: info, inner }) => {
    const outcome = /<(failure|error)\b/.test(inner) ? 'failed' : /<skipped\b/.test(inner) ? 'skipped' : 'passed'
    const seconds = Number(info.time)
    const name = info.classname && !info.name?.startsWith(info.classname) ? `${info.classname} > ${info.name ?? ''}` : (info.name ?? '')
    const line = Number(info.line)
    return { name, outcome, ms: Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined, file: info.file || undefined, line: Number.isInteger(line) && line > 0 ? line : undefined } satisfies TestCase
  })
}

// Visual Studio TRX (`dotnet test --logger trx`): one UnitTestResult per test.
export function parseTrx(xml: string): TestCase[] {
  const cases: TestCase[] = []
  for (const match of xml.matchAll(/<UnitTestResult\b([^>]*?)\/?>/g)) {
    const info = attrs(match[1] ?? '')
    const outcome = info.outcome === 'Passed' ? 'passed' : info.outcome === 'Failed' ? 'failed' : 'skipped'
    const [hours = 0, minutes = 0, seconds = 0] = (info.duration ?? '').split(':').map(Number)
    const ms = Math.round(((hours * 60 + minutes) * 60 + seconds) * 1000)
    cases.push({ name: info.testName ?? '', outcome, ms: Number.isFinite(ms) ? ms : undefined })
  }
  return cases
}

export function countCases(cases: readonly TestCase[]): TestCounts {
  const failed = cases.filter(one => one.outcome === 'failed').length
  const skipped = cases.filter(one => one.outcome === 'skipped').length
  return { total: cases.length, passed: cases.length - failed - skipped, failed, skipped }
}

// The totals a runner prints at the end of its output, for runs that left no result report. Only well-known summary
// lines are read, and nothing is guessed: no match means no counts.
export function parseSummaryOutput(output: string): TestCounts | undefined {
  const text = output.replace(/\u001b\[[0-9;]*m/g, '')
  const n = (pattern: RegExp, source = text) => Number(pattern.exec(source)?.[1] ?? 0)

  // Jest and Vitest: "Tests:  1 failed, 4 passed, 5 total" / "Tests  1 failed | 4 passed | 1 skipped (6)".
  const js = /^\s*Tests:?\s+(.*)$/m.exec(text)?.[1]
  if (js && /(passed|failed)/.test(js)) {
    const failed = n(/(\d+) failed/, js)
    const skipped = n(/(\d+) (?:skipped|todo)/, js)
    const passed = n(/(\d+) passed/, js)
    const total = n(/(\d+) total/, js) || n(/\((\d+)\)/, js) || failed + skipped + passed
    return { total, passed, failed, skipped }
  }
  // pytest: "=== 2 failed, 3 passed, 1 skipped in 0.5s ===" or "3 passed in 0.1s".
  const py = /^=*\s*((?:\d+ (?:failed|passed|skipped|error|errors|xfailed|xpassed|deselected|warnings?)(?:, | and )?)+)\s+in [\d.]+s/m.exec(text)?.[1]
  if (py) {
    const failed = n(/(\d+) failed/, py) + n(/(\d+) errors?/, py)
    const skipped = n(/(\d+) skipped/, py)
    const passed = n(/(\d+) passed/, py)
    return { total: failed + skipped + passed, passed, failed, skipped }
  }
  // Rust: "test result: FAILED. 5 passed; 1 failed; 0 ignored" (one line per test binary, summed).
  const rust = [...text.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)]
  if (rust.length) {
    const sum = (index: number) => rust.reduce((total, match) => total + Number(match[index]), 0)
    return { total: sum(1) + sum(2) + sum(3), passed: sum(1), failed: sum(2), skipped: sum(3) }
  }
  // .NET: "Passed!  - Failed: 0, Passed: 5, Skipped: 0, Total: 5".
  const dotnet = /(?:Passed|Failed)!\s+-\s+Failed:\s*(\d+),\s*Passed:\s*(\d+),\s*Skipped:\s*(\d+),\s*Total:\s*(\d+)/.exec(text)
  if (dotnet) return { total: Number(dotnet[4]), passed: Number(dotnet[2]), failed: Number(dotnet[1]), skipped: Number(dotnet[3]) }
  // Bun: " 27 pass", " 1 skip", " 4 fail", " 1 error" on their own lines, then "Ran 32 tests across 6 files."
  const bun = /^Ran (\d+) tests? across/m.exec(text)
  if (bun) {
    const failed = n(/^\s*(\d+) fail\s*$/m) + n(/^\s*(\d+) errors?\s*$/m)
    return { total: Number(bun[1]), passed: n(/^\s*(\d+) pass\s*$/m), failed, skipped: n(/^\s*(\d+) skip\s*$/m) }
  }
  // Go: one "ok" or "FAIL" line per package; the counts are packages, which is all `go test` prints without -v.
  const goOk = [...text.matchAll(/^ok\s+\S+/gm)].length
  const goFail = [...text.matchAll(/^FAIL\s+\S+/gm)].length
  if (goOk + goFail > 0 && !/^---\s+(PASS|FAIL)/m.test(text)) return { total: goOk + goFail, passed: goOk, failed: goFail, skipped: 0 }
  // RSpec and Minitest: "5 examples, 1 failure, 0 pending".
  const rspec = /(\d+) examples?, (\d+) failures?(?:, (\d+) pending)?/.exec(text)
  if (rspec) {
    const [total, failed, skipped] = [Number(rspec[1]), Number(rspec[2]), Number(rspec[3] ?? 0)]
    return { total, passed: total - failed - skipped, failed, skipped }
  }
  // Maven surefire: "Tests run: 5, Failures: 1, Errors: 0, Skipped: 0" (the last line is the total).
  const maven = [...text.matchAll(/Tests run: (\d+), Failures: (\d+), Errors: (\d+), Skipped: (\d+)/g)].at(-1)
  if (maven) {
    const [total, failed, skipped] = [Number(maven[1]), Number(maven[2]) + Number(maven[3]), Number(maven[4])]
    return { total, passed: total - failed - skipped, failed, skipped }
  }
  return undefined
}
