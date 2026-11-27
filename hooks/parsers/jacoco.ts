import type { FileCoverage, Totals } from '../../types'
import { elements, tags } from './xml'

// JaCoCo XML (`jacoco.xml`): Java, Kotlin and Scala through Maven or Gradle. Lines live under package > sourcefile.
export function parseJacoco(xml: string): FileCoverage[] {
  const files: FileCoverage[] = []
  for (const pack of elements(xml, 'package')) {
    const folder = pack.attrs.name ?? ''
    for (const source of elements(pack.inner, 'sourcefile')) {
      const name = source.attrs.name
      if (!name) continue
      const lines: Record<number, number> = {}
      for (const line of tags(source.inner, 'line')) {
        const at = Number(line.nr)
        if (Number.isInteger(at)) lines[at] = Number(line.ci) > 0 ? Number(line.ci) : 0
      }
      const counter = (type: string): Totals | undefined => {
        const found = tags(source.inner, 'counter').find(one => one.type === type)
        if (!found) return undefined
        const covered = Number(found.covered) || 0
        return { covered, total: covered + (Number(found.missed) || 0) }
      }
      const branches = counter('BRANCH')
      const functions = counter('METHOD')
      files.push({ file: folder ? `${folder}/${name}` : name, lines, branches: branches?.total ? branches : undefined, functions: functions?.total ? functions : undefined })
    }
  }
  return files
}
