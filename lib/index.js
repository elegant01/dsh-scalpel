// dsh-scalpel — host half.
// Two jobs live on the client side (compare, pick turns). This half only does
// the one thing a client plugin cannot: rewrite the messages that go to the
// model, per session, every turn. Nothing here touches the session file.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const name = 'dsh-scalpel'

const HOME = os.homedir()
const RULES_PATH = path.join(HOME, '.dsh', 'scalpel-drop.json')
const PROBE_PATH = path.join(HOME, '.dsh', 'scalpel-probe.json')
const AUDIT_PATH = path.join(HOME, '.dsh', 'scalpel-audit.jsonl')

let probeWritten = false

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function writeJson(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8')
    return true
  } catch {
    return false
  }
}

function appendJsonl(file, value) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, JSON.stringify(value) + '\n', 'utf8')
  } catch {
    /* audit is best-effort */
  }
}

// --- rules -----------------------------------------------------------------

function readRules() {
  const raw = readJson(RULES_PATH, {})
  const sessions = raw?.sessions
  return sessions && typeof sessions === 'object' ? sessions : {}
}

function writeRules(sessions) {
  return writeJson(RULES_PATH, { version: 1, sessions })
}

// --- session identity ------------------------------------------------------
// The exact field is not documented; the probe records which candidate hit so
// we can pin it down on the first turn after install.

function sessionKeyOf(agent) {
  if (!agent || typeof agent !== 'object') return { key: undefined, via: 'no-agent' }
  const candidates = [
    ['agent.sessionId', agent.sessionId],
    ['agent.session.id', agent.session?.id],
    ['agent.id', agent.id],
    ['agent.session.sessionId', agent.session?.sessionId],
  ]
  for (const [via, value] of candidates) {
    if (typeof value === 'string' && value.length > 0) return { key: value, via }
  }
  return { key: undefined, via: 'none' }
}

// --- turn segmentation -----------------------------------------------------
// A turn starts at each user message. Instructions and system blocks before the
// first user message belong to no turn and are never dropped.

const USER_ROLES = new Set(['user'])

function isUser(message) {
  return message && typeof message === 'object' && USER_ROLES.has(message.role)
}

function turnOf(message, turn) {
  return isUser(message) ? turn + 1 : turn
}

function planDrop(messages, ranges) {
  if (!Array.isArray(messages) || messages.length === 0) return null
  if (!Array.isArray(ranges) || ranges.length === 0) return null

  const perMessage = []
  let turn = 0
  for (const message of messages) {
    turn = turnOf(message, turn)
    perMessage.push(turn)
  }
  const totalTurns = turn
  if (totalTurns === 0) return null

  // Never drop the turn being answered right now.
  const liveTurn = totalTurns
  const drop = new Set()
  for (const range of ranges) {
    const [from, to] = Array.isArray(range) ? range : [range, range]
    const lo = Math.max(1, Math.min(Number(from) || 0, liveTurn - 1))
    const hi = Math.max(1, Math.min(Number(to) || 0, liveTurn - 1))
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue
    for (let t = Math.min(lo, hi); t <= Math.max(lo, hi); t += 1) drop.add(t)
  }
  if (drop.size === 0) return null

  const kept = []
  const removed = []
  for (let i = 0; i < messages.length; i += 1) {
    if (drop.has(perMessage[i])) removed.push(i)
    else kept.push(messages[i])
  }
  if (removed.length === 0) return null
  return { messages: kept, removed, drop: [...drop].sort((a, b) => a - b), totalTurns }
}

function charCount(messages) {
  let n = 0
  for (const message of messages) {
    const content = message?.content
    if (typeof content === 'string') n += content.length
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (typeof block?.text === 'string') n += block.text.length
        else if (typeof block?.content === 'string') n += block.content.length
      }
    }
  }
  return n
}

// --- probe -----------------------------------------------------------------

function writeProbe(payload, decision, sessionInfo) {
  if (probeWritten) return
  probeWritten = true
  const messages = Array.isArray(decision?.messages) ? decision.messages : []
  const roles = {}
  for (const message of messages) {
    const role = String(message?.role ?? '??')
    roles[role] = (roles[role] ?? 0) + 1
  }
  const firstUser = messages.find(isUser)
  writeJson(PROBE_PATH, {
    time: new Date().toISOString(),
    payloadKeys: Object.keys(payload ?? {}),
    agentKeys: payload?.agent && typeof payload.agent === 'object' ? Object.keys(payload.agent) : null,
    agentSessionKeys: payload?.agent?.session && typeof payload.agent.session === 'object' ? Object.keys(payload.agent.session) : null,
    decisionKeys: Object.keys(decision ?? {}),
    decisionKind: decision?.kind ?? null,
    session: sessionInfo,
    messageCount: messages.length,
    roles,
    firstUserShape: firstUser
      ? {
          keys: Object.keys(firstUser),
          contentType: typeof firstUser.content === 'string' ? 'string' : Array.isArray(firstUser.content) ? 'array' : typeof firstUser.content,
          blockTypes: Array.isArray(firstUser.content)
            ? [...new Set(firstUser.content.map((b) => String(b?.type ?? '??')))]
            : null,
        }
      : null,
    sampleBlockTypes: Array.isArray(messages.at(-1)?.content)
      ? [...new Set(messages.at(-1).content.map((b) => String(b?.type ?? '??')))]
      : null,
  })
}

// --- plugin ----------------------------------------------------------------

export function apply(ctx) {
  const log = (message) => {
    try {
      ctx.logger?.info?.(`[scalpel] ${message}`)
    } catch {
      /* ignore */
    }
  }

  ctx.effect(() => {
    try {
      writeRules(readRules())
      log(`rules at ${RULES_PATH}`)
    } catch {
      /* never let setup take the host down */
    }
  }, 'scalpel:init')

  // Tool so the model (or the user, via /scalpel drop) can manage rules without
  // the client UI. Registered lazily below when the host exposes a tool seam.
  const registerTool = () => {
    try {
      const tools = ctx.get?.('tools')
      if (!tools?.register) return
    } catch {
      /* no seam on this build */
    }
  }
  registerTool()

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next()
    if (decision?.kind !== 'enter') return decision
    const messages = Array.isArray(decision.messages) ? decision.messages : null

    const sessionInfo = sessionKeyOf(payload?.agent)
    writeProbe(payload, decision, sessionInfo)

    if (!messages || messages.length === 0) return decision
    const rules = readRules()
    const entry = sessionInfo.key ? rules[sessionInfo.key] : undefined
    const plan = planDrop(messages, entry?.dropTurns)
    if (!plan) return decision

    const before = charCount(messages)
    const after = charCount(plan.messages)
    appendJsonl(AUDIT_PATH, {
      time: new Date().toISOString(),
      session: sessionInfo.key,
      via: sessionInfo.via,
      turns: plan.drop,
      totalTurns: plan.totalTurns,
      removedMessages: plan.removed.length,
      keptMessages: plan.messages.length,
      charsBefore: before,
      charsAfter: after,
      dryRun: entry?.dryRun === true,
    })
    log(`dropped turns ${plan.drop.join(',')} of ${plan.totalTurns} (${plan.removed.length} msgs, ${before} → ${after} chars)${entry?.dryRun === true ? ' [dry-run]' : ''}`)

    if (entry?.dryRun === true) return decision
    return { ...decision, messages: plan.messages }
  })

  ctx.on('llm/stream', (options, next) => {
    // sessionId is documented here by the honey-guard probe; keep it for audit
    // correlation when pre-step's agent does not expose one.
    if (options?.sessionId !== undefined) {
      try {
        const rules = readRules()
        const entry = rules[String(options.sessionId)]
        if (entry && Array.isArray(entry.dropTurns) && entry.dropTurns.length > 0) {
          appendJsonl(AUDIT_PATH, {
            time: new Date().toISOString(),
            event: 'dispatch',
            session: String(options.sessionId),
            purpose: options?.purpose ?? 'chat',
            messages: Array.isArray(options?.messages) ? options.messages.length : null,
          })
        }
      } catch {
        /* ignore */
      }
    }
    return next()
  })
}