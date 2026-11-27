import type { EngineInterface } from 'claude-code'

import type { FileCoverage, TestCase } from '../types'
import { parseCobertura } from './parsers/cobertura'
import { parseGoCover } from './parsers/gocover'
import { parseJacoco } from './parsers/jacoco'
import { parseJsonCoverage } from './parsers/json-reports'
import { parseLcov } from './parsers/lcov'
import { parseJunit, parseTrx } from './parsers/results'

// Folders that never hold a report and can hold a huge number of files.
const SKIP = new Set(['node_modules', '.git', 'vendor', '.venv', 'venv', '__pycache__', '.next', '.nuxt', '.gradle', '.cargo', '.tox', '.mypy_cache', 'site-packages', 'deps', 'incremental', '.fingerprint', '.idea', '.vs'])
const MAX_DEPTH = 7
const MAX_ENTRIES = 20_000
const MAX_REPORTS = 40
// Reports and the clock of the machine can differ a little.
const CLOCK_SLACK_MS = 2_000

type Kind = 'lcov' | 'xml' | 'json' | 'go' | 'junit' | 'trx'

// A report is chosen by its file name first and its content second, so a `coverage.xml` can be Cobertura or JaCoCo.
export function kindOf(name: string): Kind | undefined {
  const lower = name.toLowerCase()
  if (lower === 'lcov.info' || lower.endsWith('.lcov')) return 'lcov'
  if (/^(?:cover(?:age)?|c|profile)\.(?:out|txt)$/.test(lower)) return 'go'
  if (lower === 'coverage-final.json' || lower === 'coverage-summary.json' || lower === 'coverage.json') return 'json'
  if (lower.endsWith('.trx')) return 'trx'
  if (/^(?:cobertura.*|coverage.*|jacoco.*|clover)\.xml$/.test(lower) || lower.endsWith('.coverage.xml')) return 'xml'
  if (/^(?:test-.*|junit.*|.*junit.*|results?|test-?results?.*|.*-report|report)\.xml$/.test(lower)) return 'junit'
  return undefined
}

export type Found = { path: string; kind: Kind }

// Every report file under `root` written at or after `since`, newest first.
export async function findReports($: EngineInterface, root: string, since: number): Promise<Found[]> {
  const found: (Found & { mtimeMs: number })[] = []
  let seen = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return
    const entries = await $.fs.list(dir).catch(() => [])
    for (const entry of entries) {
      seen++
      const path = `${dir.replace(/[\\/]$/, '')}/${entry.name}`
      if (entry.kind === 'dir' && !entry.isLink) {
        if (!SKIP.has(entry.name)) await walk(path, depth + 1)
        continue
      }
      const kind = entry.kind === 'file' ? kindOf(entry.name) : undefined
      if (kind && entry.mtimeMs >= since - CLOCK_SLACK_MS) found.push({ path, kind, mtimeMs: entry.mtimeMs })
    }
  }
  await walk(root, 0)
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_REPORTS).map(({ path, kind }) => ({ path, kind }))
}

export type Reports = { coverage: FileCoverage[]; cases: TestCase[]; count: number; skipped: number }

// Reads and parses what findReports found. A report that cannot be read or understood is counted as skipped, never guessed.
export async function readReports($: EngineInterface, found: readonly Found[]): Promise<Reports> {
  const reports: Reports = { coverage: [], cases: [], count: 0, skipped: 0 }
  for (const { path, kind } of found) {
    try {
      const text = await $.fs.read(path)
      if (typeof text !== 'string') throw new Error('not text')
      let coverage: FileCoverage[] | undefined
      let cases: TestCase[] | undefined
      if (kind === 'lcov') coverage = parseLcov(text)
      else if (kind === 'go') coverage = parseGoCover(text)
      else if (kind === 'json') coverage = parseJsonCoverage(JSON.parse(text))
      else if (kind === 'trx') cases = parseTrx(text)
      else if (kind === 'junit') cases = /<testcase\b/.test(text) || /<testsuites?\b/.test(text) ? parseJunit(text) : undefined
      else if (/<report\b[^>]*name=/.test(text) && /<counter\b/.test(text)) coverage = parseJacoco(text)
      else if (/<coverage\b/.test(text)) coverage = parseCobertura(text)
      if (coverage?.length) reports.coverage.push(...coverage)
      else if (cases) reports.cases.push(...cases)
      else {
        reports.skipped++
        continue
      }
      reports.count++
    } catch {
      reports.skipped++
    }
  }
  return reports
}
