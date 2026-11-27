// Preloaded by `bun test` (see bunfig.toml). `claude plugin test` runs the mod inside Claude Code but cannot report which
// lines the tests ran, so the coverage figure comes from here: the same sources run under Bun, with the engine's few
// runtime exports (`atom`, `read`, `update`, and the test kit) replaced by small stand-ins, and the global `h` the engine
// compiles JSX against replaced by a function that builds plain objects.
import * as bun from 'bun:test'

type Ref = { plugin: string; key: string }
type Atom = { ref: Ref; initial: unknown }

const store = ((globalThis as { __atoms?: Map<string, unknown> }).__atoms ??= new Map<string, unknown>())
const at = (atom: Atom) => `${atom.ref.plugin}:${atom.ref.key}`

export const resetAtoms = () => store.clear()

bun.mock.module('claude-code', () => ({
  atom: (ref: Ref, initial: unknown) => ({ ref, initial }),
  read: async (_: unknown, atom: Atom) => (store.has(at(atom)) ? store.get(at(atom)) : atom.initial),
  update: async (_: unknown, atom: Atom, change: (current: unknown) => unknown) => {
    store.set(at(atom), change(store.has(at(atom)) ? store.get(at(atom)) : atom.initial))
  },
}))

bun.mock.module('claude-code/testing', () => ({ test: bun.test, expect: bun.expect }))
;(globalThis as { h?: unknown }).h = (type: unknown, props: unknown, ...children: unknown[]) => ({ type, props: props ?? {}, children: children.flat(Infinity) })
