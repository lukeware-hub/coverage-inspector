import type { FileCoverage } from '../../types'
import { elements, tags } from './xml'

// Cobertura XML (`cobertura.xml`, `coverage.xml`): coverage.py, pytest-cov, coverlet (.NET), gocover-cobertura, JS tools.
// A class holds methods and lines; one file may hold several classes, so the caller merges files of the same name.
export function parseCobertura(xml: string): FileCoverage[] {
  const files = new Map<string, FileCoverage>()
  for (const klass of elements(xml, 'class')) {
    const file = klass.attrs.filename
    if (!file) continue
    const entry = files.get(file) ?? { file, lines: {}, branches: { covered: 0, total: 0 }, functions: { covered: 0, total: 0 } }
    for (const line of tags(klass.inner.replace(/<methods[\s\S]*?<\/methods>/g, ''), 'line')) {
      const at = Number(line.number)
      if (!Number.isInteger(at)) continue
      entry.lines![at] = Math.max(entry.lines![at] ?? 0, Number(line.hits) || 0)
      const condition = /\((\d+)\/(\d+)\)/.exec(line['condition-coverage'] ?? '')
      if (condition) {
        entry.branches!.covered += Number(condition[1])
        entry.branches!.total += Number(condition[2])
      }
    }
    for (const method of elements(klass.inner, 'method')) {
      entry.functions!.total++
      if (tags(method.inner, 'line').some(line => Number(line.hits) > 0)) entry.functions!.covered++
    }
    files.set(file, entry)
  }
  return [...files.values()].map(entry => ({ ...entry, branches: entry.branches!.total ? entry.branches : undefined, functions: entry.functions!.total ? entry.functions : undefined }))
}
