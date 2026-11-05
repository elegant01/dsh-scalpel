// Host-half tests. The module pins its paths from os.homedir() at import time,
// so we point USERPROFILE at a temp dir *before* importing it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'scalpel-test-'))
process.env.USERPROFILE = home
process.env.HOME = home

const LIB = pathToFileURL(path.resolve(import.meta.dirname, '..', 'lib', 'index.js')).href
const { apply } = await import(LIB)

const RULES = path.join(home, '.dsh', 'scalpel-drop.json')
const AUDIT = path.join(home, '.dsh', 'scalpel-audit.jsonl')

const handlers = new Map()
apply({
  logger: { info() {} },
  effect(fn) {
    fn()
  },
  on(event, handler) {
    handlers.set(event, handler)
  },
  get() {
    return undefined
  },
})
const preStep = handlers.get('agent/pre-step')

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] })
const assistant = (text, extra = []) => ({ role: 'assistant', content: [{ type: 'text', text }, ...extra] })

const conversation = (turns) => {
  const messages = []
  for (let i = 1; i <= turns; i += 1) {
    messages.push(user(`question ${i}`))
    messages.push(assistant(`answer ${i}`, i === 2 ? [{ type: 'tool_use', id: `call_${i}`, name: 'read' }] : []))
    if (i === 2) messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${i}`, content: 'ok' }] })
  }
  return messages
}

const writeRules = (sessions) => {
  fs.mkdirSync(path.join(home, '.dsh'), { recursive: true })
  fs.writeFileSync(RULES, JSON.stringify({ version: 1, sessions }, null, 2))
}

const run = async (sessionId, messages) => preStep({ agent: { session: { id: sessionId } } }, async () => ({ kind: 'enter', messages }))

const auditRows = () => {
  if (!fs.existsSync(AUDIT)) return []
  return fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
}

test('a rule stored under the bare uuid matches the prefixed host id', async () => {
  writeRules({ 'abc-123': { dropTurns: [[1, 1]] } })
  const messages = conversation(4)
  const decision = await run('session-abc-123', messages)
  assert.equal(decision.messages.length, messages.length - 2, 'turn 1 is two messages')
  assert.equal(decision.messages[0].content[0].text, 'question 2')
  const last = auditRows().at(-1)
  assert.equal(last.session, 'abc-123')
  assert.deepEqual(last.turns, [1])
  assert.equal(last.removedMessages, 2)
  assert.equal(last.dryRun, false)
})

test('a rule stored with the prefix still matches (old files keep working)', async () => {
  writeRules({ 'session-def-456': { dropTurns: [[2, 2]] } })
  const messages = conversation(4)
  const decision = await run('session-def-456', messages)
  assert.equal(decision.messages.length, messages.length - 3, 'turn 2 has answer + tool result')
  assert.ok(!decision.messages.some((m) => m.content?.[0]?.text === 'answer 2'))
  assert.ok(!decision.messages.some((m) => m.content?.[0]?.tool_use_id === 'call_2'))
})

test('the turn being answered is never dropped', async () => {
  writeRules({ 'ghi-789': { dropTurns: [[4, 4]] } })
  const messages = conversation(4)
  const decision = await run('session-ghi-789', messages)
  assert.equal(decision.messages.length, messages.length)
})

test('dryRun logs the plan but returns the messages untouched', async () => {
  writeRules({ 'dry-001': { dropTurns: [[1, 2]], dryRun: true } })
  const messages = conversation(3)
  const before = auditRows().length
  const decision = await run('session-dry-001', messages)
  assert.equal(decision.messages.length, messages.length)
  const rows = auditRows()
  assert.equal(rows.length, before + 1)
  assert.equal(rows.at(-1).dryRun, true)
  assert.deepEqual(rows.at(-1).turns, [1, 2])
  assert.ok(rows.at(-1).charsAfter < rows.at(-1).charsBefore)
})

test('no rule, or an unknown session, leaves messages alone and writes no audit', async () => {
  writeRules({})
  const messages = conversation(3)
  const before = auditRows().length
  const decision = await run('session-nobody', messages)
  assert.equal(decision.messages.length, messages.length)
  assert.equal(auditRows().length, before)
})