import type { RunScope } from '../types'

// Which shell commands are test runs. Built from well-known runners of many languages, plus the user's own patterns.
const RUNNERS: { name: string; pattern: RegExp }[] = [
  { name: 'vitest', pattern: /\bvitest\b/ },
  { name: 'jest', pattern: /\bjest\b/ },
  { name: 'mocha', pattern: /\bmocha\b/ },
  { name: 'playwright', pattern: /\bplaywright\s+test\b/ },
  { name: 'cypress', pattern: /\bcypress\s+run\b/ },
  { name: 'npm test', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t|tests|coverage|cov|test:[\w:-]+|coverage:[\w:-]+)\b/ },
  { name: 'bun test', pattern: /\bbun\s+test\b/ },
  { name: 'deno test', pattern: /\bdeno\s+test\b/ },
  { name: 'pytest', pattern: /\bpy\.?test\b|\bpython[\d.]*\s+-m\s+(?:pytest|unittest)\b|\bcoverage\s+run\b|\btox\b|\bnox\b/ },
  { name: 'go test', pattern: /\bgo\s+test\b/ },
  { name: 'dotnet test', pattern: /\bdotnet\s+test\b/ },
  { name: 'maven', pattern: /\bmvnw?(?:\.cmd)?\b[^|&;]*\b(?:test|verify|surefire:test|jacoco:report)\b/ },
  { name: 'gradle', pattern: /\bgradlew?(?:\.bat)?\b[^|&;]*\b(?:test|check|jacocoTestReport|koverXmlReport)\b/ },
  { name: 'cargo', pattern: /\bcargo\s+(?:test|nextest|llvm-cov|tarpaulin)\b/ },
  { name: 'rspec', pattern: /\brspec\b|\brake\s+(?:spec|test)\b|\brails\s+test\b/ },
  { name: 'phpunit', pattern: /\bphpunit\b|\bartisan\s+test\b|\bpest\b/ },
  { name: 'flutter test', pattern: /\bflutter\s+test\b|\bdart\s+test\b/ },
  { name: 'ctest', pattern: /\bctest\b/ },
  { name: 'swift test', pattern: /\bswift\s+test\b/ },
  { name: 'mix test', pattern: /\bmix\s+test\b/ },
  { name: 'sbt test', pattern: /\bsbt\b[^|&;]*\btest\b/ },
  { name: 'make test', pattern: /\bmake\s+(?:test|tests|check|coverage|cover)\b/ },
]

// Commands that only mention a runner without running it.
const NOT_A_RUN = /^(?:git|echo|printf|grep|egrep|rg|cat|ls|dir|which|where|man|less|head|tail|sed|awk|find|type|code|vim|nano|ssh|curl|wget|gh|ctx_\w+)\b/
const ONLY_INFO = /\s(?:--help|-h|--version|-v|--list-tests|--collect-only|--co)\b/

// Quoted text removed, so `git commit -m "fix npm test"` is not a test run.
function unquoted(command: string): string {
  return command.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, '""')
}

// The parts of a compound command that run something: `cd app && npm test | tee out` is `cd app`, `npm test`, `tee out`.
function parts(command: string): string[] {
  return unquoted(command)
    .split(/&&|\|\||;|\||\n/)
    .map(part => part.replace(/^\s*(?:\w+=\S*\s+)+/, '').trim())
    .filter(Boolean)
}

// The user's extra patterns: comma-separated regular expressions; one that is not valid is left out.
export function userPatterns(text: string): RegExp[] {
  return text
    .split(',')
    .map(piece => piece.trim())
    .filter(Boolean)
    .flatMap(piece => {
      try {
        return [new RegExp(piece)]
      } catch {
        return []
      }
    })
}

export type Detected = { runner: string; scope: RunScope }

// Flags and arguments that narrow a run to some tests: a name filter or a file or folder other than the whole project.
const FILTER_FLAG = /\s(?:-k|-m|-t|-run|--run|--grep|-g|--filter|--testNamePattern|--testPathPattern|--tests|--testNameFilter|-Dtest=\S*|--test-name-pattern|--only|--specs?|--changed(?:Since)?|--findRelatedTests|-o|--onlyChanged|-x|--exitfirst|--lf|--last-failed|--ff)\b/
const FILE_ARG = /\s(?!(?:\.\/\.\.\.|\.\.\.|\.\/?|--?\S*)(?:\s|$))(?:[\w./\\@-]*[/\\][\w./\\@-]*|[\w.-]+\.(?:test|spec)\.\w+|\w+_test\.\w+|test_\w+\.py|\w+Test\.\w+)(?=\s|$)/

// A guess at whether the run covers the whole project or a slice of it.
export function scopeOf(part: string): RunScope {
  const args = part.replace(/^\S+/, '')
  return FILTER_FLAG.test(args) || FILE_ARG.test(args) ? 'partial' : 'full'
}

// The runner a command starts, or undefined when it is not a test run.
export function detectRun(command: string, extra: readonly RegExp[] = []): Detected | undefined {
  if (!command.trim()) return undefined
  for (const part of parts(command)) {
    if (NOT_A_RUN.test(part) || ONLY_INFO.test(` ${part}`)) continue
    const known = RUNNERS.find(runner => runner.pattern.test(part))
    if (known) return { runner: known.name, scope: scopeOf(part) }
    const custom = extra.find(pattern => pattern.test(part))
    if (custom) return { runner: part.split(/\s+/)[0] ?? 'custom', scope: scopeOf(part) }
  }
  return undefined
}
