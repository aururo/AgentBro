// Minimal YAML reader for the `perf-spec` fence (spec C1).
//
// Deliberately not a YAML implementation: the spec forbids adding a parser
// dependency (`lib/testSpec.js` set that precedent), and the fence only ever
// contains what this file supports — nested maps, block sequences, inline
// `[a, b]` / `{k: v}`, quoted and bare scalars, and `#` comments.
//
// Anything outside that subset is returned as a plain string rather than
// rejected: validation is `spec.js`'s job, and a "helpful" parser that guesses
// turns a typo into a silently wrong config.

/** Split on a separator that is not inside brackets or quotes. */
function splitTopLevel(text, sep = ',') {
  const out = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
    else if (ch === '[' || ch === '{') depth += 1
    else if (ch === ']' || ch === '}') depth -= 1
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i))
      start = i + 1
    }
  }
  out.push(text.slice(start))
  return out
}

/** Drop a trailing `# comment` that is not inside a quoted string. */
export function stripComment(line) {
  const text = String(line)
  let quote = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote !== '') {
      if (ch === '\\') i += 1
      else if (ch === quote) quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === '#' && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i)
  }
  return text
}

function unquote(text) {
  const t = text.trim()
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) {
    return t.slice(1, -1).replace(/\\(["'\\])/g, '$1')
  }
  return t
}

/**
 * Parse one inline value: array, object, quoted string, number, boolean, null or
 * a bare string.
 * @param {string} text
 */
export function parseInline(text) {
  const t = String(text ?? '').trim()
  if (t === '') return null
  if (t.startsWith('[') && t.endsWith(']')) {
    const inner = t.slice(1, -1).trim()
    if (inner === '') return []
    return splitTopLevel(inner).map((part) => parseInline(part))
  }
  if (t.startsWith('{') && t.endsWith('}')) {
    const inner = t.slice(1, -1).trim()
    /** @type {Record<string, unknown>} */
    const out = {}
    if (inner === '') return out
    for (const part of splitTopLevel(inner)) {
      const idx = part.indexOf(':')
      if (idx === -1) continue
      out[unquote(part.slice(0, idx))] = parseInline(part.slice(idx + 1))
    }
    return out
  }
  if (t === 'null' || t === '~') return null
  if (t === 'true') return true
  if (t === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t)
  return unquote(t)
}

/** `key: value` at the start of a line, or null. */
function splitKey(text) {
  const idx = text.indexOf(':')
  if (idx <= 0) return null
  const key = text.slice(0, idx).trim()
  if (key === '' || /[\s[{]/.test(key)) return null
  return { key: unquote(key), value: text.slice(idx + 1).trim() }
}

/**
 * Parse the supported YAML subset into plain JS.
 * @param {string} text
 * @returns {unknown}
 */
export function parseYamlSubset(text) {
  /** @type {{ indent: number, text: string }[]} */
  const rows = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = stripComment(raw)
    if (line.trim() === '') continue
    rows.push({ indent: line.length - line.trimStart().length, text: line.trim() })
  }

  let i = 0

  function parseNode(indent) {
    const row = rows[i]
    if (row === undefined) return null
    return row.text === '-' || row.text.startsWith('- ') ? parseSeq(indent) : parseMap(indent)
  }

  function parseSeq(indent) {
    const out = []
    while (i < rows.length && rows[i].indent === indent && (rows[i].text === '-' || rows[i].text.startsWith('- '))) {
      const row = rows[i]
      const rest = row.text === '-' ? '' : row.text.slice(2).trim()
      i += 1
      if (rest === '') {
        out.push(i < rows.length && rows[i].indent > indent ? parseNode(rows[i].indent) : null)
        continue
      }
      if (rest.startsWith('{') || rest.startsWith('[')) {
        out.push(parseInline(rest))
        continue
      }
      const head = splitKey(rest)
      if (head === null) {
        out.push(parseInline(rest))
        continue
      }
      /** @type {Record<string, unknown>} */
      const item = {}
      item[head.key] = head.value === ''
        ? (i < rows.length && rows[i].indent > indent ? parseNode(rows[i].indent) : null)
        : parseInline(head.value)
      // Sibling keys of the same sequence item sit deeper than the dash.
      while (i < rows.length && rows[i].indent > indent && !rows[i].text.startsWith('- ')) {
        const next = rows[i]
        const kv = splitKey(next.text)
        if (kv === null) break
        i += 1
        item[kv.key] = kv.value === ''
          ? (i < rows.length && rows[i].indent > next.indent ? parseNode(rows[i].indent) : null)
          : parseInline(kv.value)
      }
      out.push(item)
    }
    return out
  }

  function parseMap(indent) {
    /** @type {Record<string, unknown>} */
    const out = {}
    while (i < rows.length && rows[i].indent === indent && !rows[i].text.startsWith('- ')) {
      const row = rows[i]
      const kv = splitKey(row.text)
      if (kv === null) {
        // A bare scalar inside a map is meaningless here; skip instead of guessing.
        i += 1
        continue
      }
      i += 1
      out[kv.key] = kv.value === ''
        ? (i < rows.length && rows[i].indent > indent ? parseNode(rows[i].indent) : null)
        : parseInline(kv.value)
    }
    return out
  }

  const first = rows[0]
  if (first === undefined) return {}
  return parseNode(first.indent)
}
