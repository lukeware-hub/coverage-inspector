import type { RunScope } from '../types'

// Which shell commands are test runs. Built from well-known runners of many languages, plus the user's own patterns.
const RUNNERS: { name: string; pattern: RegExp }[] = [
  { name: 'vitest', pattern: /\bvitest\b/ },
  { name: 'jest', pattern: /\bjest\b/ },
  { name: 'mocha', pattern: /\bmocha\b/ },
  { name: 'playwright', pattern: /\bplaywright\s+test\b/ },
  { name: 'cypress', pattern: /\bcypress\s+run\b/ },
  // Bun's own runner comes first: `bun test` would otherwise match the package-script pattern below.
  { name: 'bun test', pattern: /\bbun\s+test\b/ },
  { name: 'npm test', pattern: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|t|tests|coverage|cov|test:[\w:-]+|coverage:[\w:-]+)\b/ },
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

// A here-document's body is text handed to a command, not commands: `git commit -F - <<'EOF'` followed by a message
// that mentions `npm test; echo done` runs no test. Each body is removed, up to the line that holds its delimiter alone
// (or to the end when that line never comes).
export function withoutHeredocs(command: string): string {
  const lines = command.split('\n')
  const kept: string[] = []
  const open: string[] = []
  for (const line of lines) {
    if (open.length) {
      if (line.replace(/^\t+/, '').trim() === open[0]) open.shift()
      continue
    }
    kept.push(line)
    for (const match of unquotedOutsideHeredoc(line).matchAll(/<<-?\s*(['"]?)([\w.-]+)\1/g)) open.push(match[2]!)
  }
  return kept.join('\n')
}

// A line with its quoted text blanked, so `echo "<<EOF"` opens no here-document. Here-string `<<<` is not one either.
function unquotedOutsideHeredoc(line: string): string {
  return line.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, match => (/^(['"])[\w.-]+\1$/.test(match) ? match : '""')).replace(/<<</g, '')
}

// The parts of a compound command that run something: `cd app && npm test | tee out` is `cd app`, `npm test`, `tee out`.
// Separators inside quotes do not split. Each part keeps its text as typed, and a plain form with the quoted text
// removed and leading `NAME=value` assignments dropped, which is what the runner patterns read.
export function parts(line: string): { typed: string; plain: string }[] {
  const command = withoutHeredocs(line)
  const pieces: string[] = []
  let current = ''
  let quote: string | undefined
  for (let at = 0; at < command.length; at++) {
    const char = command[at]!
    if (quote) {
      if (char === '\\' && quote === '"') {
        current += char + (command[at + 1] ?? '')
        at++
        continue
      }
      if (char === quote) quote = undefined
      current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }
    const two = command.slice(at, at + 2)
    if (two === '&&' || two === '||') {
      pieces.push(current)
      current = ''
      at++
      continue
    }
    if (char === ';' || char === '|' || char === '\n') {
      pieces.push(current)
      current = ''
      continue
    }
    current += char
  }
  pieces.push(current)
  return pieces
    .map(piece => piece.trim())
    .filter(Boolean)
    .map(typed => ({ typed, plain: unquoted(typed).replace(/^\s*(?:\w+=\S*\s+)+/, '').trim() }))
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

// The runner, the scope guess, and `command`: only the part of the shell line that ran the tests, as typed.
export type Detected = { runner: string; scope: RunScope; command: string }

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
  for (const { typed, plain } of parts(command)) {
    if (NOT_A_RUN.test(plain) || ONLY_INFO.test(` ${plain}`)) continue
    const known = RUNNERS.find(runner => runner.pattern.test(plain))
    if (known) return { runner: known.name, scope: scopeOf(plain), command: typed }
    const custom = extra.find(pattern => pattern.test(plain))
    if (custom) return { runner: plain.split(/\s+/)[0] ?? 'custom', scope: scopeOf(plain), command: typed }
  }
  return undefined
}
