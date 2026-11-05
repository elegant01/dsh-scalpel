// Session reading: decode DSH's multi-frame zstd event log and fold it into turns.
// Verified against node v22.23.4 (zlib.zstdDecompressSync available).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { zstdDecompressSync } from 'node:zlib'

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// Only these event types survive parsing. A session log repeats things we never
// read — the whole tool catalogue on every request/header, every streamed delta
// in assistant/attempt, every pwsh job tick. A 14.7 MB log inflates to hundreds
// of MB if kept whole, enough to OOM on a cold start; the field list below is
// what compare/turns/drop actually use.
const KEEP = new Set([
  'session',
  'session/title',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/message',
  'tool/call',
  'tool/result',
  'model/selection',
  'request/context',
])

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}\n…[+${s.length - n} chars]` : s)

const textBlocks = (content, maxText) => {
  const out = []
  for (const b of content ?? []) {
    if (b && (b.type === 'text' || b.kind === 'text') && typeof b.text === 'string') {
      out.push({ type: 'text', text: clip(b.text, maxText) })
    }
  }
  return out
}

// Turn the on-disk row into the small object the rest of the code expects.
// Returns null for rows we deliberately forget.
function slimRow(r, maxText, argLimit) {
  const d = r.data ?? {}
  switch (r.type) {
    case 'session':
      return { type: r.type, version: r.version, id: r.id, createdAt: r.createdAt, cwd: r.cwd, isSeeded: r.isSeeded, delegationDepth: r.delegationDepth, agentPreset: r.agentPreset }
    case 'session/title':
      return { type: r.type, data: { title: d.title, messageSeqs: d.messageSeqs, source: d.source } }
    case 'turn/start':
      return { type: r.type, time: r.time, seq: r.seq, data: { turn: d.turn } }
    case 'turn/end':
      return { type: r.type, time: r.time, seq: r.seq, data: { turn: d.turn, reason: d.reason } }
    case 'step/start':
    case 'step/end':
      return { type: r.type, time: r.time, seq: r.seq, data: { turn: d.turn, step: d.step } }
    case 'user/message':
      return { type: r.type, time: r.time, seq: r.seq, data: { turn: d.turn, content: textBlocks(d.content, maxText), source: { kind: d.source?.kind } } }
    case 'assistant/message':
      return {
        type: r.type,
        time: r.time,
        seq: r.seq,
        data: {
          turn: d.turn,
          step: d.step,
          usage: d.usage,
          message: {
            role: 'assistant',
            id: d.message?.id,
            source: { kind: d.message?.source?.kind, provider: d.message?.source?.provider, model: d.message?.source?.model },
            content: textBlocks(d.message?.content, maxText),
          },
        },
      }
    case 'tool/call':
      return { type: r.type, time: r.time, seq: r.seq, data: { turn: d.turn, step: d.step, callId: d.callId, name: d.name, arguments: clip(d.arguments, argLimit) } }
    case 'tool/result':
      return { type: r.type, time: r.time, seq: r.seq, data: { turn: d.turn, step: d.step, callId: d.toolCallId ?? d.callId } }
    case 'model/selection':
      return { type: r.type, data: { provider: d.provider, model: d.model } }
    case 'request/context':
      return { type: r.type, data: { provider: d.provider, model: d.model, contextWindow: d.contextWindow } }
    default:
      return KEEP.has(r.type) ? r : null
  }
}

/**
 * Decode the multi-frame zstd log. Parsing is per frame: the decompressed text
 * never accumulates in one big string, and rows are slimmed before they are
 * stored (see KEEP/slimRow).
 *
 * @param {string} file  session.v4.jsonl.zstd
 * @param {{ slim?: boolean, maxText?: number, argLimit?: number }} [opts]
 *        slim:false keeps every field (only for debugging small logs)
 */
export function decodeSessionFile(file, opts = {}) {
  const { slim = true, maxText = 200_000, argLimit = 400 } = opts
  const buf = readFileSync(file)
  const rows = []
  let carry = ''
  const take = (text) => {
    const parts = text.split('\n')
    carry = parts.pop() ?? ''
    for (const line of parts) {
      if (!line.trim()) continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue // a torn tail line is not worth an error
      }
      if (!slim) {
        rows.push(row)
        continue
      }
      const kept = slimRow(row, maxText, argLimit)
      if (kept) rows.push(kept)
    }
  }

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
    take(carry + out.toString('utf8'))
    i = end
  }
  if (carry.trim()) take(`${carry}\n`)
  return rows
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