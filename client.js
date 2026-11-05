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

    const answersOf = (snapshot) => {
      if (!snapshot) return []
      const out = []
      let turn = 0
      for (const key of snapshot.order ?? []) {
        const node = snapshot.nodes?.get?.(key)
        if (!node) continue
        if (node.visibility === 'hidden') continue
        if (node.kind === 'user') turn += 1
        if (node.kind !== 'assistant-step' && node.kind !== 'body') continue
        const data = node.data ?? {}
        const text = textOf(data.blocks ?? data.content).trim()
        if (!text) continue
        out.push({
          key,
          turn,
          messageId: data.finalNode?.messageId ?? data.messageId ?? key,
          text,
          chars: text.length,
          time: data.time ?? node.time ?? null,
        })
      }
      return out
    }

    const clock = (ms) => {
      if (!ms) return ''
      const d = new Date(ms)
      const p = (n) => String(n).padStart(2, '0')
      return `${p(d.getHours())}:${p(d.getMinutes())}`
    }

    // Cross-component hand-off: the action button preselects one side, then
    // switches to this view. Module scope = one instance per page.
    const request = { messageId: null }

    // ---- styles ----
    const S = {
      page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, color: 'var(--dsh-text-primary, #dfe4ec)', fontSize: 13 },
      head: { display: 'flex', gap: 8, alignItems: 'center', padding: '10px 16px', borderBottom: '1px solid rgba(128,140,160,.18)', flexWrap: 'wrap', position: 'sticky', top: 0, zIndex: 2, background: 'var(--dsh-bg-primary, #101318)' },
      sel: { maxWidth: 300, padding: '4px 6px', borderRadius: 6, border: '1px solid rgba(128,140,160,.28)', background: 'transparent', color: 'inherit', fontSize: 12 },
      stat: { opacity: 0.65, fontSize: 12 },
      btn: { padding: '4px 9px', borderRadius: 6, border: '1px solid rgba(128,140,160,.28)', background: 'transparent', color: 'inherit', cursor: 'pointer', fontSize: 12 },
      grid: { display: 'grid', gridTemplateColumns: '1fr 1fr', flex: 1, minHeight: 0, overflow: 'auto' },
      cell: { padding: '8px 16px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.6, borderRight: '1px solid rgba(128,140,160,.10)' },
      empty: { padding: '28px 20px', opacity: 0.7, lineHeight: 1.8 },
      del: { background: 'rgba(255,96,96,.16)', color: '#ff9d9d', textDecoration: 'line-through' },
      ins: { background: 'rgba(96,220,150,.16)', color: '#8ee0ad' },
      changedBg: { background: 'rgba(255,180,70,.05)' },
      onlyL: { background: 'rgba(255,96,96,.09)' },
      onlyR: { background: 'rgba(96,220,150,.09)' },
      overlay: { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,.62)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '3vh 3vw' },
      box: { width: '100%', maxWidth: 1440, height: '100%', maxHeight: '94vh', display: 'flex', flexDirection: 'column', borderRadius: 14, overflow: 'hidden' },
    }

    const spans = (ops, side) =>
      ops.map((o, i) => h('span', { key: i, style: o.t === 'same' ? undefined : side === 'left' ? S.del : S.ins }, o.text))

    function Selector({ value, onChange, answers, placeholder }) {
      return h(
        'select',
        { style: S.sel, value: value ?? '', onChange: (e) => onChange(e.target.value || null) },
        h('option', { value: '' }, placeholder),
        answers.map((a) =>
          h('option', { key: a.key, value: a.key }, `#${a.turn}${a.time ? ' ' + clock(a.time) : ''} · ${a.chars}字 · ${a.text.slice(0, 22).replace(/\s+/g, ' ')}`)
        )
      )
    }

    function CompareView(props) {
      const useChat = props.useChat
      const [leftKey, setLeftKey] = React.useState(null)
      const [rightKey, setRightKey] = React.useState(null)
      const [onlyDiff, setOnlyDiff] = React.useState(true)
      const [note, setNote] = React.useState('')

      const answers = useChat ? answersOf(useChat((s) => s)) : []

      // honour a preselection handed over by the action-row button
      React.useEffect(() => {
        if (!request.messageId || !answers.length) return
        const hit = answers.find((a) => a.key === request.messageId || a.messageId === request.messageId)
        if (hit) setLeftKey(hit.key)
        request.messageId = null
      }, [answers.length])

      React.useEffect(() => {
        if (!useChat) setNote('这个插槽没有拿到会话快照（useChat 未注入），对比不可用。请把这条信息发给我。')
        else if (!answers.length) setNote('这个会话里还没有可对比的回答。')
        else setNote('')
      }, [useChat, answers.length])

      // default: newest answer on the left, the one before it on the right
      React.useEffect(() => {
        if (answers.length < 2) return
        if (!leftKey || !answers.some((a) => a.key === leftKey)) setLeftKey(answers[answers.length - 1].key)
        if (!rightKey || !answers.some((a) => a.key === rightKey)) setRightKey(answers[answers.length - 2].key)
      }, [answers.length])

      const a = answers.find((x) => x.key === leftKey)
      const b = answers.find((x) => x.key === rightKey)
      const result = a && b && a.key !== b.key ? compare(a.text, b.text) : null
      const rows = (result?.rows ?? []).filter((r) => !onlyDiff || !r.same)

      const cells = []
      rows.forEach((r, i) => {
        if (r.same) {
          cells.push(h('div', { key: `l${i}`, style: S.cell }, r.left))
          cells.push(h('div', { key: `r${i}`, style: S.cell }, r.right))
        } else if (r.left && r.right) {
          const d = diffTokens(r.left, r.right)
          cells.push(h('div', { key: `l${i}`, style: { ...S.cell, ...S.changedBg } }, spans(d.left, 'left')))
          cells.push(h('div', { key: `r${i}`, style: { ...S.cell, ...S.changedBg } }, spans(d.right, 'right')))
        } else if (r.left) {
          cells.push(h('div', { key: `l${i}`, style: { ...S.cell, ...S.onlyL } }, r.left))
          cells.push(h('div', { key: `r${i}`, style: S.cell }))
        } else {
          cells.push(h('div', { key: `l${i}`, style: S.cell }))
          cells.push(h('div', { key: `r${i}`, style: { ...S.cell, ...S.onlyR } }, r.right))
        }
      })

      return h(
        'div',
        { style: S.page, ...(props.onClose ? { borderRadius: 14, border: '1px solid rgba(128,140,160,.28)', background: '#101318', overflow: 'hidden' } : null) },
        h(
          'div',
          { style: S.head },
          h(Selector, { value: leftKey, onChange: setLeftKey, answers, placeholder: '左边：选一条回答' }),
          h(Selector, { value: rightKey, onChange: setRightKey, answers, placeholder: '右边：选一条回答' }),
          h(
            'button',
            { style: S.btn, onClick: () => { const t = leftKey; setLeftKey(rightKey); setRightKey(t) } },
            '⇄ 交换'
          ),
          result
            ? h('span', { style: S.stat }, `${result.stats.total} 段 · 相同 ${result.stats.same} · 改动 ${result.stats.changed} · 单侧 ${result.stats.only}`)
            : null,
          h(
            'label',
            { style: { marginLeft: 'auto', cursor: 'pointer', fontSize: 12, opacity: 0.8 } },
            h('input', { type: 'checkbox', checked: onlyDiff, onChange: (e) => setOnlyDiff(e.target.checked) }),
            ' 仅看差异'
          ),
          props.onClose ? h('button', { style: S.btn, onClick: props.onClose }, '关闭') : null
        ),
        note ? h('div', { style: S.empty }, note) : h('div', { style: S.grid }, cells)
      )
    }

    // ---- action-row button: open the comparator right here (useChat is given by standardProps) ----
    function CompareAction(props) {
      const [open, setOpen] = React.useState(false)
      const close = () => setOpen(false)
      return h(
        React.Fragment,
        null,
        h(
          'button',
          {
            style: S.btn,
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
              { style: S.overlay, onClick: close },
              h(
                'div',
                { style: S.box, onClick: (e) => e.stopPropagation() },
                h(CompareView, { useChat: props.useChat, onClose: close })
              )
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