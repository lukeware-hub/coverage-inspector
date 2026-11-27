import type { EngineInterface } from 'claude-code'

// A small stand-in for the engine's `$`: a project folder held in memory, git's answers, the clock and the store.

export const ROOT = '/work/app'
export const NOW = Date.UTC(2026, 10, 27, 14, 2, 11)

export type FakeFile = { text: string; mtimeMs: number; kind?: 'file' | 'dir' | 'other'; isLink?: boolean }

export type Fake = {
  $: EngineInterface
  files: Record<string, FakeFile>
  stored: Map<string, unknown>
  time: { now: number }
  timers: (() => unknown)[]
  intervals: number[]
  git: { diff?: string; status?: string; failing?: boolean; throwing?: boolean }
  repo: { root: string } | null
  calls: { command: string[]; tool: string[]; process: string[] }
  failures: { listing?: boolean; stat?: boolean; store?: boolean; clock?: boolean }
}

// The Box and Text this stand-in hands back are their own names; `h` (see shim.ts) turns them into plain objects.
export const ui = { Box: 'Box', Text: 'Text' }

export function makeFake(files: Record<string, FakeFile> = {}): Fake {
  const fake: Fake = {
    $: undefined as unknown as EngineInterface,
    files,
    stored: new Map(),
    time: { now: NOW },
    timers: [],
    intervals: [],
    git: {},
    repo: { root: ROOT },
    calls: { command: [], tool: [], process: [] },
    failures: {},
  }
  const entries = (dir: string) => {
    const prefix = `${dir.replace(/[\\/]$/, '')}/`
    const seen = new Set<string>()
    const found: { name: string; kind: 'file' | 'dir' | 'other'; size: number; mtimeMs: number; isLink: boolean }[] = []
    for (const [path, file] of Object.entries(fake.files)) {
      if (!path.startsWith(prefix)) continue
      const [first, ...more] = path.slice(prefix.length).split('/')
      if (seen.has(first!)) continue
      seen.add(first!)
      found.push({ name: first!, kind: more.length ? 'dir' : (file.kind ?? 'file'), size: file.text.length, mtimeMs: more.length ? 0 : file.mtimeMs, isLink: more.length ? false : (file.isLink ?? false) })
    }
    return found
  }
  const engine = {
    session: { cwd: async () => ROOT, repo: async () => fake.repo },
    store: {
      get: async (key: string) => fake.stored.get(key),
      set: async (key: string, value: unknown) => {
        if (fake.failures.store) throw new Error('store is full')
        fake.stored.set(key, JSON.parse(JSON.stringify(value)))
      },
    },
    clock: {
      now: async () => {
        if (fake.failures.clock) throw new Error('clock is gone')
        return fake.time.now
      },
      every: (ms: number, tick: () => unknown) => {
        fake.intervals.push(ms)
        fake.timers.push(tick)
      },
    },
    fs: {
      list: async (path: string) => {
        if (fake.failures.listing) throw new Error('cannot list')
        return entries(path)
      },
      read: async (path: string) => {
        const file = fake.files[path]
        if (!file) throw new Error(`ENOENT ${path}`)
        return file.text
      },
      stat: async (path: string) => {
        if (fake.failures.stat) throw new Error('cannot stat')
        const file = fake.files[path]
        if (!file) throw new Error(`stat failed: ENOENT ${path}`)
        return { kind: file.kind ?? 'file', size: file.text.length, mtimeMs: file.mtimeMs, isLink: false }
      },
    },
    process: {
      run: async (argv: string[]) => {
        const command = argv.slice(0, 2).join(' ')
        fake.calls.process.push(command)
        if (fake.git.throwing) throw new Error('git is missing')
        const out = command === 'git diff' ? fake.git.diff : command === 'git status' ? fake.git.status : ''
        return { exitCode: fake.git.failing ? 128 : 0, stdout: out ?? '', stderr: '' }
      },
    },
    command: { register: async (spec: { name: string }) => void fake.calls.command.push(spec.name) },
    tool: { register: async (spec: { name: string }) => void fake.calls.tool.push(spec.name) },
    ui: { resolve: () => ui },
  }
  fake.$ = engine as unknown as EngineInterface
  return fake
}

type Entry = { event: string; matcher?: Record<string, unknown>; fn: (...args: unknown[]) => unknown; catcher?: (...args: unknown[]) => unknown }

// Collects the hooks a module registers, like the engine's `on`.
export function collect() {
  const hooks: Entry[] = []
  const on = (event: string, a: unknown, b?: unknown) => {
    const entry: Entry = { event, matcher: b === undefined ? undefined : (a as Record<string, unknown>), fn: (b ?? a) as Entry['fn'] }
    hooks.push(entry)
    return {
      catch(handler: Entry['catcher']) {
        entry.catcher = handler
        return this
      },
    }
  }
  const find = (event: string, matcher?: Record<string, unknown>) => {
    const entry = hooks.find(one => one.event === event && JSON.stringify(one.matcher) === JSON.stringify(matcher))
    if (!entry) throw new Error(`no hook for ${event} ${JSON.stringify(matcher)}`)
    return entry
  }
  // Runs one hook as the engine does: `next` hands the event back.
  const fire = async (fake: Fake, event: string, matcher: Record<string, unknown> | undefined, e: unknown) => find(event, matcher).fn(fake.$, e, async (x: unknown) => x)
  return { hooks, on, find, fire }
}

// Every text a drawn tree holds, in order.
export function textsOf(tree: unknown): string[] {
  if (typeof tree === 'string') return [tree]
  if (Array.isArray(tree)) return tree.flatMap(textsOf)
  if (typeof tree === 'object' && tree !== null && 'children' in tree) return textsOf((tree as { children: unknown }).children)
  return []
}

// The trees found anywhere in a drawn tree that are of one type.
export function findAll(tree: unknown, type: string): { type: string; props: Record<string, unknown>; children: unknown[] }[] {
  if (Array.isArray(tree)) return tree.flatMap(one => findAll(one, type))
  if (typeof tree !== 'object' || tree === null) return []
  const node = tree as { type: string; props: Record<string, unknown>; children: unknown[] }
  return [...(node.type === type ? [node] : []), ...findAll(node.children, type)]
}
