// A small reader for the XML reports test runners write. Reports are machine made and regular, so regular expressions
// are enough; no full XML parser is needed, and none is available inside a mod.

const ENTITIES: Record<string, string> = { '&lt;': '<', '&gt;': '>', '&amp;': '&', '&quot;': '"', '&apos;': "'" }

export function decode(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos);|&#(\d+);/g, (whole, name, code) => (code ? String.fromCharCode(Number(code)) : (ENTITIES[`&${name};`] ?? whole)))
}

// The attributes of one tag's text: ` name="x" time='1'`.
export function attrs(text: string): Record<string, string> {
  const found: Record<string, string> = {}
  for (const match of text.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) found[match[1]!] = decode(match[2] ?? match[3] ?? '')
  return found
}

// Every element named `tag`, as its attribute text and its inner text (empty for a self-closing one).
export function elements(xml: string, tag: string): { attrs: Record<string, string>; inner: string }[] {
  const pattern = new RegExp(`<${tag}\\b([^>]*?)(?:/>|>([\\s\\S]*?)</${tag}>)`, 'g')
  return [...xml.matchAll(pattern)].map(match => ({ attrs: attrs(match[1] ?? ''), inner: match[2] ?? '' }))
}

// Every self-closing or opening tag named `tag`, attributes only (for `<line .../>` and the like).
export function tags(xml: string, tag: string): Record<string, string>[] {
  return [...xml.matchAll(new RegExp(`<${tag}\\b([^>]*?)/?>`, 'g'))].map(match => attrs(match[1] ?? ''))
}
