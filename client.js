// dsh-scalpel — client half (browser, no build step).
// A conversation view named "对比": pick any two answers of this session and
// read them in two columns, paragraph-aligned, word-highlighted.
window.__ModuleLoader__.load({
  id: 'dsh-scalpel',
  factory(require) {
    let React = null
    try {
      React = require('react')
    } catch {
      /* older loaders */
    }
    if (!React) {
      try {
        const prim = require('@deepseek-ai/dsh-client-ui-primitives')
        React = prim?.React ?? prim?.default ?? null
      } catch {
        /* no React reachable */
      }
    }
    const h = React ? React.createElement : null
    const VIEW_ID = 'scalpel-compare'

    // ---- compare core (inlined: the loader cannot resolve relative imports) ----
    const splitBlocks = (text) => {
      const lines = String(text ?? '').split('\n')
      const out = []
      let buf = []
      let fence = null
      const flush = () => {
        const b = buf.join('\n').trim()
        if (b) out.push(b)
        buf = []
      }
      for (const line of lines) {
        const m = line.match(/^\s*(`{3,}|~{3,})/)
        if (m) {
          if (fence === null) fence = m[1][0]
          else if (line.trim().startsWith(fence + fence) || line.trim() === fence) fence = null
          buf.push(line)
          continue
        }
        if (fence === null && line.trim() === '') flush()
        else buf.push(line)
      }
      flush()
      return out
    }
    const norm = (s) =>
      String(s ?? '')
        .replace(/```[\s\S]*?```/g, ' [code] ')
        .replace(/[*_`>#\-[\]()|]/g, '')
        .replace(/\s+/g, '')
        .toLowerCase()
    const sim = (a, b) => {
      if (a === b) return 1
      const A = [...a]
      const B = [...b]
      if (!A.length || !B.length) return 0
      if (A.length > 1500 || B.length > 1500) {
        const setB = new Set(B)
        let hit = 0
        for (const c of A) if (setB.has(c)) hit += 1
        return hit / Math.max(A.length, B.length)
      }
      let prev = new Array(B.length + 1).fill(0)
      let cur = new Array(B.length + 1).fill(0)
      for (let i = 1; i <= A.length; i += 1) {
        for (let j = 1; j <= B.length; j += 1) {
          cur[j] = A[i - 1] === B[j - 1] ? prev[j - 1] + 1 : Math.max(prev[j], cur[j - 1])
        }
        const t = prev
        prev = cur
        cur = t
        cur.fill(0)
      }
      return prev[B.length] / Math.max(A.length, B.length)
    }
    const SAME = 0.82

    const tokenize = (s) => String(s ?? '').match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]|\s+|[^\s]/g) ?? []
    const diffTokens = (a, b) => {
      const A = tokenize(a)
      const B = tokenize(b)
      if (A.length > 2500 || B.length > 2500) return { coarse: true, left: [{ t: 'same', text: a }], right: [{ t: 'same', text: b }] }
      const dp = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0))
      for (let i = A.length - 1; i >= 0; i -= 1) {
        for (let j = B.length - 1; j >= 0; j -= 1) {
          dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
      }
      let i = 0
      let j = 0
      const left = []
      const right = []
      const push = (arr, t, text) => {
        const last = arr[arr.length - 1]
        if (last && last.t === t) last.text += text
        else arr.push({ t, text })
      }
      while (i < A.length && j < B.length) {
        if (A[i] === B[j]) {
          push(left, 'same', A[i])
          push(right, 'same', B[j])
          i += 1
          j += 1
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          push(left, 'del', A[i])
          i += 1
        } else {
          push(right, 'ins', B[j])
          j += 1
        }
      }
      while (i < A.length) push(left, 'del', A[i++])
      while (j < B.length) push(right, 'ins', B[j++])
      return { coarse: false, left, right }
    }

    const align = (left, right) => {
      const L = left.map(norm)
      const R = right.map(norm)
      const n = L.length
      const m = R.length
      const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
      for (let i = n - 1; i >= 0; i -= 1) {
        for (let j = m - 1; j >= 0; j -= 1) {
          dp[i][j] = sim(L[i], R[j]) >= SAME ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
        }
      }
      const rows = []
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (sim(L[i], R[j]) >= SAME) {
          rows.push({ left: left[i], right: right[j], same: left[i] === right[j] })
          i += 1
          j += 1
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          rows.push({ left: left[i], right: null })
          i += 1
        } else {
          rows.push({ left: null, right: right[j] })
          j += 1
        }
      }
      while (i < n) rows.push({ left: left[i++], right: null })
      while (j < m) rows.push({ left: null, right: right[j++] })
      const out = []
      let k = 0
      while (k < rows.length) {
        if (rows[k].left && rows[k].right) {
          out.push(rows[k])
          k += 1
          continue
        }
        const Ls = []
        const Rs = []
        while (k < rows.length && !(rows[k].left && rows[k].right)) {
          const r = rows[k]
          k += 1
          if (r.left) Ls.push(r.left)
          else Rs.push(r.right)
        }
        const pairs = Math.min(Ls.length, Rs.length)
        for (let p = 0; p < pairs; p += 1) out.push({ left: Ls[p], right: Rs[p], changed: true })
        for (let p = pairs; p < Ls.length; p += 1) out.push({ left: Ls[p], right: null })
        for (let p = pairs; p < Rs.length; p += 1) out.push({ left: null, right: Rs[p] })
      }
      return out
    }

    const compare = (a, b) => {
      const rows = align(splitBlocks(a), splitBlocks(b))
      let same = 0
      let changed = 0
      let only = 0
      for (const r of rows) {
        if (r.same) same += 1
        else if (r.left && r.right) changed += 1
        else only += 1
      }
      return { rows, stats: { same, changed, only, total: rows.length } }
    }

    // ---- chat snapshot helpers ----
    const isTextBlock = (b) => b && (b.kind === 'text' || b.type === 'text') && typeof b.text === 'string'
    const textOf = (blocks) => (blocks ?? []).filter(isTextBlock).map((b) => b.text).join('\n\n')

    const questionOf = (node) => textOf(node?.data?.blocks ?? node?.data?.content).replace(/\s+/g, ' ').trim()

    // Walk the chat snapshot once: turns (user question) + the answers hanging off them.
    const turnsOf = (snapshot) => {
      const turns = []
      if (!snapshot) return turns
      let current = null
      for (const key of snapshot.order ?? []) {
        const node = snapshot.nodes?.get?.(key)
        if (!node || node.visibility === 'hidden') continue
        if (node.kind === 'user') {
          current = { turn: turns.length + 1, question: questionOf(node), chars: 0, time: null, answers: [] }
          turns.push(current)
          continue
        }
        if (!current) continue
        if (node.kind !== 'assistant-step' && node.kind !== 'body') continue
        const data = node.data ?? {}
        const text = textOf(data.blocks ?? data.content).trim()
        if (!text) continue
        const time = data.time ?? node.time ?? null
        current.answers.push({ key, messageId: data.finalNode?.messageId ?? data.messageId ?? key, text, chars: text.length, time })
        current.chars += text.length
        if (!current.time) current.time = time
      }
      return turns
    }

    const answersOf = (turns) => turns.flatMap((t) => t.answers.map((a) => ({ ...a, turn: t.turn, question: t.question })))

    // Same question asked more than once → the two answers are directly comparable.
    const autoPairs = (turns) => {
      const byQuestion = new Map()
      for (const t of turns) {
        const k = norm(t.question)
        if (!k || !t.answers.length) continue
        const list = byQuestion.get(k) ?? []
        list.push(t)
        byQuestion.set(k, list)
      }
      const out = []
      for (const group of byQuestion.values()) {
        if (group.length < 2) continue
        for (let i = 1; i < group.length; i += 1) {
          const later = group[i]
          const earlier = group[i - 1]
          out.push({
            id: `${later.turn}:${earlier.turn}`,
            question: later.question,
            from: earlier.turn,
            to: later.turn,
            left: later.answers[later.answers.length - 1],
            right: earlier.answers[earlier.answers.length - 1],
          })
        }
      }
      return out
    }

    const fallbackCopy = (text, done) => {
      try {
        const ta = document.createElement('textarea')
        ta.value = text
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        document.execCommand('copy')
        document.body.removeChild(ta)
        done()
      } catch (err) {
        console.warn('[dsh-scalpel] copy failed: ' + (err?.message ?? err))
      }
    }

    const markdownOf = (a, b, result) =>
      `# dsh-scalpel 对比\n\n- 左：#${a.turn}（${a.chars} 字）\n- 右：#${b.turn}（${b.chars} 字）\n- 结构：${result.stats.total} 段，相同 ${result.stats.same}，改动 ${result.stats.changed}，单侧 ${result.stats.only}\n\n## 左 · #${a.turn}\n\n${a.text}\n\n## 右 · #${b.turn}\n\n${b.text}\n`

    const markHits = (text, query) => {
      const q = query.trim()
      if (!q) return text
      const low = text.toLowerCase()
      const needle = q.toLowerCase()
      const out = []
      let at = 0
      let i = low.indexOf(needle)
      let n = 0
      while (i >= 0) {
        if (i > at) out.push(text.slice(at, i))
        out.push(h('span', { key: `hit${n}`, className: 'sc-hit' }, text.slice(i, i + q.length)))
        n += 1
        at = i + q.length
        i = low.indexOf(needle, at)
      }
      out.push(text.slice(at))
      return out
    }

    const cmdCopy = (text, label, copy) =>
      h(
        'div',
        { key: text, className: 'sc-cmd' },
        h('code', null, text),
        h('button', { className: 'sc-btn', onClick: () => copy(text, label) }, '复制')
      )

    const clock = (ms) => {
      if (!ms) return ''
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}`
    }

    // Cross-component hand-off: the action button preselects one side, then
    // switches to this view. Module scope = one instance per page.
    const request = { messageId: null }

    // ---- styles: only DSH theme tokens (no hardcoded colors) ----
    const CSS = [
      '.sc-page{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);background:transparent}',
      '.sc-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base);border-bottom:.5px solid var(--dsw-alias-border-l2)}',
      '.sc-sel{height:28px;max-width:320px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer}',
      '.sc-sel:hover{border-color:var(--dsw-alias-border-l3)}',
      '.sc-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;line-height:20px;cursor:pointer;transition:background-color .12s ease,color .12s ease}',
      '.sc-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.sc-btn:active{background:var(--dsw-alias-interactive-bg-active)}',
      '.sc-action{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.sc-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.sc-stat{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.sc-toggle{margin-left:auto;display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;cursor:pointer}',
      '.sc-toggle input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer}',
      '.sc-grid{flex:1;min-height:0;overflow:auto;display:grid;grid-template-columns:1fr 1fr;align-content:start;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.sc-cell{padding:8px 14px;white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.6}',
      '.sc-cell:nth-child(odd){border-right:.5px solid var(--dsw-alias-border-l1)}',
      '.sc-changed{background:color-mix(in srgb,var(--dsw-alias-state-warn-tertiary) 30%,transparent)}',
      '.sc-only-l{border-left:2px solid var(--dsw-alias-state-error-primary);background:var(--dsw-alias-code-diff-deleted)}',
      '.sc-only-r{border-left:2px solid var(--dsw-alias-state-success-primary);background:var(--dsw-alias-code-diff-added)}',
      '.sc-del{background:var(--dsw-alias-code-diff-deleted);box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary)}',
      '.sc-ins{background:var(--dsw-alias-code-diff-added);box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary)}',
      '.sc-note{padding:28px 20px;color:var(--dsw-alias-label-tertiary);line-height:1.8}',
      '.sc-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:max(24px,3vh) 24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
      '.sc-panel{width:100%;max-width:1440px;height:100%;max-height:calc(100vh - 48px);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-panel);box-shadow:var(--dsw-elevation-prominent)}',
      '.sc-panel .sc-head{background:transparent}',
      '.sc-panel ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2)}',
      '.sc-seg{display:inline-flex;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);overflow:hidden}',
      '.sc-seg button{height:26px;padding:0 10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.sc-seg button[data-on=true]{background:var(--dsw-alias-markdown-tag);color:var(--dsw-alias-label-primary)}',
      '.sc-seg button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc-input{height:28px;width:200px;padding:0 8px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;outline:none}',
      '.sc-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.sc-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.sc-hit{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 24%,transparent);border-radius:var(--dsw-radius-xs)}',
      '.sc-drop{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.sc-drop-head{display:flex;gap:12px;align-items:center;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1)}',
      '.sc-turns{flex:0 1 auto;max-height:46vh;min-height:0;overflow:auto;padding:4px 14px 8px}',
      '.sc-trow{display:grid;grid-template-columns:44px 52px 1fr 68px;gap:10px;align-items:baseline;padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);cursor:pointer;font-size:13px;line-height:20px}',
      '.sc-trow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc-trow[data-in=true]{background:var(--dsw-alias-markdown-tag);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.sc-dim{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.sc-cmd{display:flex;gap:8px;align-items:center;margin:6px 14px 10px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block)}',
      '.sc-cmd code{flex:1;min-width:0;overflow:auto;white-space:pre;background:none;border:0;padding:0;color:var(--dsw-alias-label-primary);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}',
      '.sc-flash{color:var(--dsw-alias-state-success-primary);font-size:12px}',
    ].join('\n')

    let styled = false
    const ensureStyles = () => {
      if (styled) return
      styled = true
      try {
        if (document.querySelector('style[data-dsh-scalpel]')) return
        const el = document.createElement('style')
        el.setAttribute('data-dsh-scalpel', '')
        el.textContent = CSS
        document.head.appendChild(el)
      } catch (err) {
        console.warn('[dsh-scalpel] style injection failed: ' + (err?.message ?? err))
      }
    }

    const spans = (ops, side) =>
      ops.map((o, i) => h('span', { key: i, className: o.t === 'same' ? undefined : side === 'left' ? 'sc-del' : 'sc-ins' }, o.text))

    function Selector({ value, onChange, answers, placeholder }) {
      return h(
        'select',
        { className: 'sc-sel', value: value ?? '', onChange: (e) => onChange(e.target.value || null) },
        h('option', { value: '' }, placeholder),
        answers.map((a) =>
          h('option', { key: a.key, value: a.key }, `#${a.turn}${a.time ? ' ' + clock(a.time) : ''} · ${a.chars}字 · ${a.text.slice(0, 22).replace(/\s+/g, ' ')}`)
        )
      )
    }

    function CompareView(props) {
      ensureStyles()
      const useChat = props.useChat
      const [leftKey, setLeftKey] = React.useState(null)
      const [rightKey, setRightKey] = React.useState(null)
      const [onlyDiff, setOnlyDiff] = React.useState(true)
      const [filter, setFilter] = React.useState('')
      const [mode, setMode] = React.useState('compare')
      const [note, setNote] = React.useState('')
      const [flash, setFlash] = React.useState('')
      const [from, setFrom] = React.useState(0)
      const [to, setTo] = React.useState(0)

      const snapshot = useChat ? useChat((s) => s) : null
      const turns = React.useMemo(() => turnsOf(snapshot), [snapshot])
      const answers = React.useMemo(() => answersOf(turns), [turns])
      const pairs = React.useMemo(() => autoPairs(turns), [turns])

      React.useEffect(() => {
        if (!flash) return undefined
        const timer = setTimeout(() => setFlash(''), 1600)
        return () => clearTimeout(timer)
      }, [flash])

      // honour a preselection handed over by the action-row button
      React.useEffect(() => {
        if (!request.messageId || !answers.length) return
        const hit = answers.find((a) => a.key === request.messageId || a.messageId === request.messageId)
        if (hit) setLeftKey(hit.key)
        request.messageId = null
      }, [answers.length])

      React.useEffect(() => {
        if (!useChat) setNote('这个插槽没有拿到会话快照（useChat 未注入），对比不可用。请把这条信息发给我。')
        else if (answers.length < 2) setNote('这个会话里还没有足够的回答可以对比。')
        else setNote('')
      }, [useChat, answers.length])

      // default: the newest repeated question if any, otherwise the newest two answers
      React.useEffect(() => {
        if (answers.length < 2) return
        const valid = (key) => key && answers.some((a) => a.key === key)
        if (valid(leftKey) && valid(rightKey) && leftKey !== rightKey) return
        const last = pairs[pairs.length - 1]
        if (last) {
          setLeftKey(last.left.key)
          setRightKey(last.right.key)
          return
        }
        setLeftKey(answers[answers.length - 1].key)
        setRightKey(answers[answers.length - 2].key)
      }, [answers.length, pairs.length])

      const a = answers.find((x) => x.key === leftKey)
      const b = answers.find((x) => x.key === rightKey)
      const result = a && b && a.key !== b.key ? compare(a.text, b.text) : null
      const query = filter.trim().toLowerCase()
      const rows = (result?.rows ?? [])
        .filter((r) => !onlyDiff || !r.same)
        .filter((r) => !query || (r.left ?? '').toLowerCase().includes(query) || (r.right ?? '').toLowerCase().includes(query))

      const copy = (text, label) => {
        const done = () => setFlash(label)
        try {
          if (navigator?.clipboard?.writeText) {
            navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done))
            return
          }
        } catch (err) {
          // fall through to the legacy path
        }
        fallbackCopy(text, done)
      }

      const cells = []
      rows.forEach((r, i) => {
        if (r.same) {
          cells.push(h('div', { key: `l${i}`, className: 'sc-cell' }, markHits(r.left, filter)))
          cells.push(h('div', { key: `r${i}`, className: 'sc-cell' }, markHits(r.right, filter)))
        } else if (r.left && r.right) {
          const d = diffTokens(r.left, r.right)
          cells.push(h('div', { key: `l${i}`, className: 'sc-cell sc-changed' }, spans(d.left, 'left')))
          cells.push(h('div', { key: `r${i}`, className: 'sc-cell sc-changed' }, spans(d.right, 'right')))
        } else if (r.left) {
          cells.push(h('div', { key: `l${i}`, className: 'sc-cell sc-only-l' }, markHits(r.left, filter)))
          cells.push(h('div', { key: `r${i}`, className: 'sc-cell' }))
        } else {
          cells.push(h('div', { key: `l${i}`, className: 'sc-cell' }))
          cells.push(h('div', { key: `r${i}`, className: 'sc-cell sc-only-r' }, markHits(r.right, filter)))
        }
      })

      // ---- drop mode: pick a turn range, copy a CLI command that records the rule ----
      const sid = String(props.sessionId ?? '').replace(/[^0-9a-zA-Z-]/g, '').slice(0, 8) || 'latest'
      const totalChars = turns.reduce((n, t) => n + t.chars, 0)
      const dropFrom = from || 0
      const dropTo = to || from || 0
      const inRange = (turn) => dropFrom > 0 && turn >= dropFrom && turn <= dropTo
      const droppedChars = turns.filter((t) => inRange(t.turn)).reduce((n, t) => n + t.chars, 0)
      const droppedTurns = dropFrom > 0 ? dropTo - dropFrom + 1 : 0
      const share = totalChars ? Math.round((droppedChars / totalChars) * 100) : 0

      const pick = (turn) => {
        if (!from || (from && to)) {
          setFrom(turn)
          setTo(0)
          return
        }
        if (turn < from) {
          setFrom(turn)
          setTo(0)
          return
        }
        if (turn === from) {
          setTo(0)
          return
        }
        setTo(turn)
      }

      const turnRows = turns.map((t) =>
        h(
          'div',
          {
            key: `t${t.turn}`,
            className: 'sc-trow',
            'data-in': inRange(t.turn) ? 'true' : 'false',
            onClick: () => pick(t.turn),
          },
          h('span', { className: 'sc-dim' }, `#${t.turn}`),
          h('span', { className: 'sc-dim' }, t.time ? clock(t.time) : ''),
          h('span', null, t.question || '（无提问文本）'),
          h('span', { className: 'sc-stat' }, `${t.chars} 字`)
        )
      )

      const cmds =
        dropFrom > 0
          ? [
              cmdCopy(`scalpel drop ${sid} --from ${dropFrom} --to ${dropTo} --dry`, '已复制：先试算', copy),
              cmdCopy(`scalpel drop ${sid} --from ${dropFrom} --to ${dropTo}`, '已复制：写入规则', copy),
              cmdCopy(`scalpel undrop ${sid} --all`, '已复制：撤销全部', copy),
            ]
          : null

      const dropPanel = h(
        'div',
        { className: 'sc-drop' },
        h(
          'div',
          { className: 'sc-drop-head' },
          h('span', { className: 'sc-stat' }, `${turns.length} 轮 · ${totalChars} 字`),
          h('span', { className: 'sc-dim' }, dropFrom > 0 ? `已选 #${dropFrom}–#${dropTo} · 屏蔽后少 ${droppedChars} 字（${share}%）` : '点两下行选一个区间'),
          dropFrom > 0 ? h('button', { className: 'sc-btn', onClick: () => { setFrom(0); setTo(0) } }, '清除') : null
        ),
        h('div', { className: 'sc-turns' }, turnRows),
        cmds,
        h('div', { className: 'sc-note', style: { padding: '0 14px 12px' } }, dropTurns > 0 ? `规则写进 ~/.dsh/scalpel-drop.json 后，下一轮起第 ${dropFrom}–${dropTo} 轮不再发给模型（原始会话记录不动，界面也不消失）。` : '选好区间后，复制下面的命令在任何终端执行；dry 只记账不改行为。')
      )

      return h(
        'div',
        { className: 'sc-page' },
        h(
          'div',
          { className: 'sc-head' },
          h(
            'div',
            { className: 'sc-seg' },
            h('button', { 'data-on': mode === 'compare' ? 'true' : 'false', onClick: () => setMode('compare') }, '对比'),
            h('button', { 'data-on': mode === 'drop' ? 'true' : 'false', onClick: () => setMode('drop') }, '删除范围')
          ),
          mode === 'compare'
            ? [
                h(Selector, { key: 'ls', value: leftKey, onChange: setLeftKey, answers, placeholder: '左边：选一条回答' }),
                h(Selector, { key: 'rs', value: rightKey, onChange: setRightKey, answers, placeholder: '右边：选一条回答' }),
                h(
                  'button',
                  { key: 'swap', className: 'sc-btn', onClick: () => { const t = leftKey; setLeftKey(rightKey); setRightKey(t) } },
                  '⇄ 交换'
                ),
                pairs.length > 0
                  ? h(
                      'select',
                      {
                        key: 'pair',
                        className: 'sc-sel',
                        title: '同一个问题问过多次，直接选那一对',
                        onChange: (e) => {
                          const pair = pairs[Number(e.target.value)]
                          if (!pair) return
                          setLeftKey(pair.left.key)
                          setRightKey(pair.right.key)
                        },
                      },
                      h('option', { value: '' }, `自动配对（${pairs.length} 对）`),
                      pairs.map((p, i) => h('option', { key: p.id, value: String(i) }, `#${p.from} × #${p.to} · ${p.question.slice(0, 26)}`))
                    )
                  : null,
                h('input', { key: 'filter', className: 'sc-input', placeholder: '搜索关键词', value: filter, onChange: (e) => setFilter(e.target.value) }),
                result
                  ? h('span', { key: 'stat', className: 'sc-stat' }, `${result.stats.total} 段 · 相同 ${result.stats.same} · 改动 ${result.stats.changed} · 单侧 ${result.stats.only}${query ? ` · 命中 ${rows.length} 段` : ''}`)
                  : null,
                h(
                  'label',
                  { key: 'only', className: 'sc-toggle' },
                  h('input', { type: 'checkbox', checked: onlyDiff, onChange: (e) => setOnlyDiff(e.target.checked) }),
                  ' 仅看差异'
                ),
                result
                  ? h('button', { key: 'md', className: 'sc-btn', onClick: () => copy(markdownOf(a, b, result), '已复制 Markdown') }, '复制 Markdown')
                  : null,
              ]
            : null,
          flash ? h('span', { className: 'sc-flash' }, flash) : null,
          props.onClose ? h('button', { className: 'sc-btn', onClick: props.onClose }, '关闭') : null
        ),
        note ? h('div', { className: 'sc-note' }, note) : mode === 'compare' ? h('div', { className: 'sc-grid' }, cells) : dropPanel
      )
    }

    // ---- action-row button: open the comparator right here (useChat is given by standardProps) ----
    function CompareAction(props) {
      ensureStyles()
      const [open, setOpen] = React.useState(false)
      const close = () => setOpen(false)
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            className: 'sc-action',
            title: '对比这个会话里的两次回答',
            onClick: () => {
              request.messageId = props.messageId ?? null
              setOpen(true)
            },
          },
          '⚖ 对比'
        ),
        open
          ? h(
              'div',
              { className: 'sc-mask', onClick: close },
              h('div', { className: 'sc-panel', onClick: (e) => e.stopPropagation() }, h(CompareView, { useChat: props.useChat, sessionId: props.sessionId, onClose: close }))
            )
          : null
      )
    }

    const mount = (ctx, slot, register) => {
      // 直接注册：立即生效，不依赖 inject 的时序
      try {
        register()
      } catch (err) {
        console.warn('[dsh-scalpel] direct register failed for ' + slot + ': ' + (err?.message ?? err))
      }
      // 再走一遍官方惯用的 inject（同一 id 会替换上面那条，不会重复）
      try {
        if (typeof ctx.slots.inject === 'function') {
          ctx.slots.inject(slot, () => {
            try {
              return register()
            } catch (err) {
              console.warn('[dsh-scalpel] inject register failed for ' + slot + ': ' + (err?.message ?? err))
            }
          })
        }
      } catch (err) {
        console.warn('[dsh-scalpel] inject unavailable for ' + slot + ': ' + (err?.message ?? err))
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        if (!h) {
          console.warn('[dsh-scalpel] React not reachable from the client loader; UI disabled.')
          return
        }
        ensureStyles()

        mount(ctx, 'conversation.view', () =>
          ctx.slots.register(
            {
              name: 'conversation.view',
              id: VIEW_ID,
              order: 10,
              label: () => '对比',
              locale: 'chat',
              inject: (sessionId) => ({ sessionId }),
            },
            CompareView
          )
        )

        mount(ctx, 'conversation.chat.assistant-actions', () =>
          ctx.slots.register(
            { name: 'conversation.chat.assistant-actions', id: 'dsh-scalpel-compare', order: 50 },
            CompareAction
          )
        )
      },
    }
  },
})