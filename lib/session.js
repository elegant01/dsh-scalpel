// Session reading: decode DSH's multi-frame zstd event log and fold it into turns.
// Verified against node v22.23.4 (zlib.zstdDecompressSync available).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

export function decodeSessionFile(file) {
  const buf = readFileSync(file)
  const frames = []
  let i = 0
  let lastErr = null
  while (i < buf.length) {
    const at = buf.indexOf(MAGIC, i)
    if (at < 0) break
    const next = buf.indexOf(MAGIC, at + 4)
    const end = next < 0 ? buf.length : next
    let out = null
    for (let cut = end; cut > at; cut -= 1) {
      try {
        out = zstdDecompressSync(buf.subarray(at, cut))
        break
      } catch (err) {
        lastErr = err
        if (end - cut > 64) break
      }
    }
    if (out === null) throw new Error(`frame @${at} failed: ${lastErr?.message}`)
    frames.push(out.toString('utf8'))
    i = end
  }
  return frames
    .join('')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return { __raw: l }
      }
    })
}

const textOf = (blocks) =>
  (blocks ?? [])
    .filter((b) => b && b.type === 'text')
    .map((b) => b.text)
    .join('\n')

// One turn = one real user message plus the assistant steps that follow it.
// turn/start lands in the log *before* user/message, so the prompt is attached
// to the turn that has not answered yet.
export function extractTurns(rows) {
  const turns = []
  let current = null
  let pending = null
  for (const r of rows) {
    if (r.type === 'user/message') {
      const kind = r.data?.source?.kind
      if (kind && kind !== 'user') continue
      const msg = { text: textOf(r.data?.content), time: r.time, seq: r.seq }
      if (current && current.steps.length === 0) {
        current.prompt = current.prompt
          ? { ...current.prompt, text: current.prompt.text + '\n' + msg.text }
          : msg
      } else {
        pending = msg
      }
    } else if (r.type === 'turn/start') {
      current = { index: turns.length + 1, prompt: pending, steps: [], time: r.time }
      turns.push(current)
      pending = null
    } else if (r.type === 'assistant/message' && current) {
      current.steps.push(r)
    }
  }
  for (const t of turns) {
    const contents = t.steps.map((s) => s.data?.message?.content).filter(Boolean)
    const withText = contents.filter((c) => textOf(c).trim() !== '')
    const content = withText.length ? withText[withText.length - 1] : (contents[contents.length - 1] ?? [])
    t.text = textOf(content).trim()
    t.chars = t.text.length
    t.time = t.time ?? t.steps[0]?.time
  }
  return turns
}

export function sessionsRoot() {
  return join(homedir(), '.dsh', 'sessions')
}

// Every session lives at .../session-<uuid>/session.v4.jsonl.zstd
export function findSessions(limit = 40) {
  const out = []
  let workspaces = []
  try {
    workspaces = readdirSync(sessionsRoot(), { withFileTypes: true }).filter((d) => d.isDirectory())
  } catch {
    return out
  }
  for (const ws of workspaces) {
    const wsDir = join(sessionsRoot(), ws.name)
    let dirs = []
    try {
      dirs = readdirSync(wsDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('session-'))
    } catch {
      continue
    }
    for (const d of dirs) {
      const file = join(wsDir, d.name, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(file)
        out.push({ file, id: d.name.replace(/^session-/, ''), workspace: ws.name, mtime: st.mtimeMs, size: st.size })
      } catch {
        /* missing data file */
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime).slice(0, limit)
}

export function resolveSession(arg) {
  if (!arg || arg === 'latest') {
    const first = findSessions(1)[0]
    if (!first) throw new Error('no sessions found')
    return first
  }
  if (arg.includes('/') || arg.includes('\\') || arg.endsWith('.zstd')) {
    return { file: arg, id: basename(dirname(arg)).replace(/^session-/, ''), workspace: basename(dirname(dirname(arg))), mtime: 0, size: 0 }
  }
  const hit = findSessions(500).find((s) => s.id.startsWith(arg))
  if (!hit) throw new Error(`no session matching "${arg}"`)
  return hit
}

export function loadSession(arg) {
  const ref = resolveSession(arg)
  const rows = decodeSessionFile(ref.file)
  return { ...ref, rows, turns: extractTurns(rows) }
}