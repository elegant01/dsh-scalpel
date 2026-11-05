#!/usr/bin/env node
// dsh-scalpel CLI — the half that works without restarting the app.
import { accessSync, appendFileSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compareAnswers, diffTokens } from '../lib/compare-core.js'
import { findSessions, loadSession, resolveSession } from '../lib/session.js'

const DSH = join(homedir(), '.dsh')
const RULES = join(DSH, 'scalpel-drop.json')
const AUDIT = join(DSH, 'scalpel-audit.jsonl')
const PROBE = join(DSH, 'scalpel-probe.json')
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const args = process.argv.slice(2)
const RAW = args[0]
const cmd = RAW === '--help' || RAW === '-h' ? 'help' : RAW === '-v' || RAW === '--version' ? 'version' : RAW
const BOOL_FLAGS = new Set(['json', 'dry', 'all', 'print', 'help', 'version'])
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`)
  const next = args[i + 1]
  return i >= 0 && next && !next.startsWith('--') ? next : fallback
}
const has = (name) => args.includes(`--${name}`)
// Positionals skip flag tokens and the value that belongs to a value-flag.
const positional = (() => {
  const out = []
  for (let i = 1; i < args.length; i += 1) {
    const a = args[i]
    if (a.startsWith('--')) {
      const name = a.slice(2)
      const next = args[i + 1]
      if (!BOOL_FLAGS.has(name) && next && !next.startsWith('--')) i += 1
      continue
    }
    out.push(a)
  }
  return out
})()

function readRules() {
  if (!existsSync(RULES)) return { version: 1, sessions: {} }
  try {
    return JSON.parse(readFileSync(RULES, 'utf8'))
  } catch {
    return { version: 1, sessions: {} }
  }
}
function writeRules(rules) {
  writeFileSync(RULES, JSON.stringify(rules, null, 2) + '\n', 'utf8')
}
function audit(entry) {
  appendFileSync(AUDIT, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', 'utf8')
}

function fmtTime(ms) {
  if (!ms) return '--:--'
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

const commands = {
  sessions() {
    const limit = Number(flag('limit', 20))
    const list = findSessions(limit)
    for (const s of list) {
      console.log(`${s.id.slice(0, 8)}  ${fmtTime(s.mtime)}  ${String(s.size).padStart(9)}B  ${s.workspace}`)
    }
    if (!list.length) console.log('no sessions found under ~/.dsh/sessions')
  },

  turns() {
    const s = loadSession(positional[0] ?? 'latest')
    if (has('json')) {
      console.log(JSON.stringify(s.turns.map((t) => ({ index: t.index, chars: t.chars, prompt: t.prompt?.text ?? '', time: t.time })), null, 2))
      return
    }
    console.log(`session ${s.id}  (${s.turns.length} turns)`)
    for (const t of s.turns) {
      const p = (t.prompt?.text ?? '(no prompt)').replace(/\s+/g, ' ').slice(0, 46)
      console.log(`${String(t.index).padStart(2)}  ${fmtTime(t.time)}  ${String(t.chars).padStart(5)}字  ${p}`)
    }
  },

  compare() {
    const s = loadSession(positional[0] ?? 'latest')
    const a = Number(flag('a'))
    const b = Number(flag('b'))
    if (!a || !b) throw new Error('usage: scalpel compare <session|latest> --a 2 --b 5')
    const left = s.turns.find((t) => t.index === a)
    const right = s.turns.find((t) => t.index === b)
    if (!left || !right) throw new Error(`turn ${a} or ${b} not found (session has ${s.turns.length})`)
    const result = compareAnswers(left.text, right.text)
    if (has('json')) {
      console.log(JSON.stringify({ stats: result.stats, rows: result.rows }, null, 2))
      return
    }
    console.log(`# turn ${a} (${left.chars}字)  vs  turn ${b} (${right.chars}字)`)
    console.log(`# ${result.stats.total} blocks — ${result.stats.same} same, ${result.stats.changed} changed, ${result.stats.only} only`)
    for (const row of result.rows) {
      if (row.same) {
        console.log(`\n  = ${oneLine(row.left).slice(0, 100)}`)
      } else if (row.left && row.right) {
        const d = diffTokens(row.left, row.right)
        console.log('\n  ~ left : ' + mark(d.left).slice(0, 300))
        console.log('    right: ' + mark(d.right).slice(0, 300))
      } else if (row.left) {
        console.log('\n  - only left : ' + oneLine(row.left).slice(0, 300))
      } else {
        console.log('\n  + only right: ' + oneLine(row.right).slice(0, 300))
      }
    }
  },

  drop() {
    const s = resolveSession(positional[0] ?? 'latest')
    const from = Number(flag('from'))
    const to = Number(flag('to', from))
    if (!from) throw new Error('usage: scalpel drop <session|latest> --from 3 [--to 4] [--dry]')
    const rules = readRules()
    const key = s.id
    const entry = rules.sessions[key] ?? { dropTurns: [], dryRun: false }
    const range = [Math.min(from, to), Math.max(from, to)]
    entry.dropTurns.push(range)
    entry.dropTurns.sort((x, y) => x[0] - y[0])
    if (has('dry')) entry.dryRun = true
    rules.sessions[key] = entry
    if (has('print') || has('dry')) {
      console.log(JSON.stringify({ session: key, dropTurns: entry.dropTurns, dryRun: entry.dryRun }, null, 2))
      console.log(`(rules file: ${RULES})`)
    }
    if (has('dry')) {
      console.log('dry run — nothing written. drop --dry prints what would be stored.')
      return
    }
    writeRules(rules)
    audit({ event: 'drop.add', session: key, range })
    console.log(`dropped turns ${range[0]}-${range[1]} for ${key}`)
  },

  undrop() {
    const s = resolveSession(positional[0] ?? 'latest')
    const rules = readRules()
    if (has('all') || !rules.sessions[s.id]) {
      delete rules.sessions[s.id]
      console.log(`cleared all drop rules for ${s.id}`)
    } else {
      console.log(`rules for ${s.id}: ${JSON.stringify(rules.sessions[s.id])}`)
      console.log('pass --all to clear')
      return
    }
    writeRules(rules)
    audit({ event: 'drop.clear', session: s.id })
  },

  rules() {
    const rules = readRules()
    const entries = Object.entries(rules.sessions ?? {})
    if (!entries.length) console.log('no drop rules')
    for (const [sid, cfg] of entries) {
      const ranges = (cfg.dropTurns ?? []).map((r) => r.join('-')).join(', ') || '(none)'
      console.log(`${sid.slice(0, 8)}  drop=${ranges}  dryRun=${Boolean(cfg.dryRun)}`)
    }
    console.log(`file: ${RULES}`)
  },

  audit() {
    if (!existsSync(AUDIT)) return console.log('no audit log yet')
    const limit = Number(flag('limit', 20))
    const lines = readFileSync(AUDIT, 'utf8').trim().split('\n').slice(-limit)
    for (const l of lines) console.log(l)
  },

  async doctor() {
    const checks = []
    const add = (level, label, detail = '') => checks.push({ level, label, detail })
    const rel = (p) => p.replace(homedir(), '~').replace(/\\/g, '/')

    // 1. runtime
    if (!process.versions.zstd) add('fail', 'node zstd', `node ${process.version} has no zstd — need >= 22.5`)
    else add('ok', 'node zstd', `node ${process.version} · zstd ${process.versions.zstd}`)

    // 2. package contract
    let pkg = null
    try {
      pkg = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'))
      add('ok', 'package', `${pkg.name} ${pkg.version} · ${rel(PKG_ROOT)}`)
    } catch (err) {
      add('fail', 'package', `cannot read package.json: ${err.message}`)
    }
    const clientExport = pkg?.exports?.['./client']
    if (!clientExport) add('fail', 'client bundle', 'exports["./client"] missing — host reports "declares dsh.client but exports no ./client bundle"')
    else {
      const file = join(PKG_ROOT, typeof clientExport === 'string' ? clientExport : clientExport.default ?? '')
      if (existsSync(file)) add('ok', 'client bundle', `${rel(file)} · ${Math.round(statSync(file).size / 1024)} KB`)
      else add('fail', 'client bundle', `exports["./client"] points at a missing file: ${rel(file)}`)
    }
    const dc = pkg?.dsh?.client
    if (!dc) add('fail', 'dsh.client', 'missing — the host never loads the client half')
    else {
      const problems = []
      if (dc.platform !== 'web') problems.push(`platform=${dc.platform} (want "web")`)
      if (dc.immediately !== true) problems.push('immediately is not true (the module is never prefetched)')
      if (!Array.isArray(dc.inject) || !dc.inject.length) problems.push('inject is empty')
      if (problems.length) add('fail', 'dsh.client', problems.join('; '))
      else add('ok', 'dsh.client', `platform=web · immediately=true · inject=${dc.inject.join(',')}`)
    }
    const patch = pkg?.dsh?.bundle?.patch
    if (!patch) add('fail', 'cordis patch', 'dsh.bundle.patch missing')
    else if (!existsSync(join(PKG_ROOT, patch))) add('fail', 'cordis patch', `${patch} not found`)
    else add('ok', 'cordis patch', rel(join(PKG_ROOT, patch)))

    // 3. host half loads
    try {
      const mod = await import(new URL('../lib/index.js', import.meta.url))
      const name = mod.name ?? mod.default?.name
      if (typeof (mod.apply ?? mod.default?.apply) === 'function' && name) add('ok', 'host module', `apply + name="${name}"`)
      else add('fail', 'host module', 'module has no apply/name export')
    } catch (err) {
      add('fail', 'host module', `import failed: ${err.message}`)
    }

    // 4. profile wiring: dependency + bundle list + junction chain
    const profilesDir = join(DSH, 'profiles')
    const installed = []
    let profileDirs = []
    try {
      profileDirs = readdirSync(profilesDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)
    } catch {
      add('fail', 'profiles', `no ${rel(profilesDir)} — is DSH installed?`)
    }
    for (const name of profileDirs) {
      const dir = join(profilesDir, name)
      let p
      try {
        p = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
      } catch {
        continue
      }
      const dep = p.dependencies?.['dsh-scalpel'] ?? p.devDependencies?.['dsh-scalpel']
      if (!dep) continue
      installed.push(name)
      const inBundles = (p.dsh?.profile?.bundles ?? []).includes('dsh-scalpel')
      add(inBundles ? 'ok' : 'fail', `profile ${name} · bundles`, inBundles ? 'dsh-scalpel listed' : 'NOT in dsh.profile.bundles — host will not load it')
      const linkPath = join(dir, 'node_modules', 'dsh-scalpel')
      if (!existsSync(linkPath)) {
        add('fail', `profile ${name} · link`, `dependency "${dep}" is declared but node_modules/dsh-scalpel is missing (run pnpm install)`)
        continue
      }
      try {
        const real = realpathSync(linkPath)
        const target = realpathSync(PKG_ROOT)
        if (real === target) add('ok', `profile ${name} · link`, `${rel(real)}`)
        else add('warn', `profile ${name} · link`, `${rel(real)} !== this CLI (${rel(target)}) — running an older copy?`)
      } catch (err) {
        add('fail', `profile ${name} · link`, `realpath failed: ${err.message}`)
      }
    }
    if (!installed.length) add('warn', 'profiles', 'no profile depends on dsh-scalpel — not installed yet')

    // 5. state files
    if (!existsSync(RULES)) add('ok', 'rules file', 'none yet (no drops configured)')
    else {
      try {
        const rules = JSON.parse(readFileSync(RULES, 'utf8'))
        add('ok', 'rules file', `${rel(RULES)} · ${Object.keys(rules.sessions ?? {}).length} session(s)`)
      } catch (err) {
        add('fail', 'rules file', `${rel(RULES)} is not valid JSON: ${err.message}`)
      }
    }
    try {
      accessSync(DSH, constants.W_OK)
      add('ok', 'audit log', existsSync(AUDIT) ? `${rel(AUDIT)} · ${Math.round(statSync(AUDIT).size / 1024)} KB` : 'writable, empty')
    } catch {
      add('fail', 'audit log', `${rel(DSH)} is not writable`)
    }

    // 6. probe: written by the host half on the first pre-step it sees
    if (!existsSync(PROBE)) {
      add('warn', 'probe', 'never written — the host half has not run yet (restart DSH, then send one message)')
    } else {
      let probe = null
      try {
        probe = JSON.parse(readFileSync(PROBE, 'utf8'))
      } catch {
        /* fall through */
      }
      const ageMs = Date.now() - statSync(PROBE).mtimeMs
      const age = ageMs < 60000 ? `${Math.round(ageMs / 1000)}s` : ageMs < 3600000 ? `${Math.round(ageMs / 60000)}m` : `${(ageMs / 3600000).toFixed(1)}h`
      const detail = [`${age} ago`, probe?.session?.via && `sessionId via ${probe.session.via}`, probe?.messageCount != null && `${probe.messageCount} messages in flight`]
        .filter(Boolean)
        .join(' · ')
      add(ageMs > 24 * 3600000 ? 'warn' : 'ok', 'probe', detail)
    }

    // 7. what we can actually see
    try {
      const sessions = findSessions(1000)
      add(sessions.length ? 'ok' : 'warn', 'sessions', `${sessions.length} readable session log(s) under ${rel(join(DSH, 'sessions'))}`)
    } catch (err) {
      add('warn', 'sessions', `scan failed: ${err.message}`)
    }

    // report
    const mark = { ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' }
    console.log(`dsh-scalpel doctor · ${process.version}`)
    for (const c of checks) console.log(`${mark[c.level]} ${c.label}${c.detail ? ` — ${c.detail}` : ''}`)
    const n = (l) => checks.filter((c) => c.level === l).length
    console.log(`\n${n('ok')} ok · ${n('warn')} warn · ${n('fail')} fail`)
    if (n('fail')) process.exitCode = 1
  },

  version() {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
      console.log(`dsh-scalpel ${pkg.version}`)
    } catch {
      console.log('dsh-scalpel (version unknown)')
    }
  },

  help() {
    console.log(`dsh-scalpel

  scalpel sessions [--limit N]
  scalpel turns <session|latest> [--json]
  scalpel compare <session|latest> --a N --b M [--json]
  scalpel drop <session|latest> --from N [--to M] [--dry]
  scalpel undrop <session|latest> [--all]
  scalpel rules
  scalpel audit [--limit N]
  scalpel doctor          # why is (or isn't) the plugin loaded?

<session> may be a session id prefix, a file path, or "latest".`)
  },
}

const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
// Highlight token ops in terminal output: deletions in brackets, insertions in braces.
const mark = (ops) => ops.map((o) => (o.t === 'del' ? `[-${o.text}-]` : o.t === 'ins' ? `{+${o.text}+}` : o.text)).join('')

try {
  const run = commands[cmd ?? 'help']
  if (!run) {
    console.error(`unknown command: ${cmd}`)
    commands.help()
    process.exitCode = 1
  } else {
    const result = run()
    if (result && typeof result.then === 'function') await result
  }
} catch (err) {
  console.error(String(err?.message ?? err))
  process.exitCode = 1
}

// keep mkdirSync import used when the rules dir is missing
if (!existsSync(DSH)) mkdirSync(DSH, { recursive: true })