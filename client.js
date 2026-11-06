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

    // Match blocks of B against A; unmatched B blocks are kept with the number
    // of A blocks consumed before them so a third sequence can be merged in.
    const lcsMatch = (left, right) => {
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
      const match = new Map()
      const extra = new Map()
      let i = 0
      let j = 0
      while (i < n && j < m) {
        if (sim(L[i], R[j]) >= SAME) {
          match.set(i, j)
          i += 1
          j += 1
        } else if (dp[i + 1][j] >= dp[i][j + 1]) {
          i += 1
        } else {
          const list = extra.get(i) ?? []
          list.push(j)
          extra.set(i, list)
          j += 1
        }
      }
      while (j < m) {
        const list = extra.get(i) ?? []
        list.push(j)
        extra.set(i, list)
        j += 1
      }
      return { match, extra }
    }

    // Three-way alignment: A is the spine, B and C are matched onto its blocks.
    const compare3 = (textA, textB, textC) => {
      const A = splitBlocks(textA)
      const B = splitBlocks(textB)
      const C = splitBlocks(textC)
      const ab = lcsMatch(A, B)
      const ac = lcsMatch(A, C)
      const rows = []
      const emitGap = (gap) => {
        const bs = ab.extra.get(gap) ?? []
        const cs = ac.extra.get(gap) ?? []
        const len = Math.max(bs.length, cs.length)
        for (let k = 0; k < len; k += 1) {
          rows.push({ sides: [null, bs[k] === undefined ? null : B[bs[k]], cs[k] === undefined ? null : C[cs[k]]] })
        }
      }
      for (let i = 0; i < A.length; i += 1) {
        emitGap(i)
        rows.push({
          sides: [A[i], ab.match.has(i) ? B[ab.match.get(i)] : null, ac.match.has(i) ? C[ac.match.get(i)] : null],
        })
      }
      emitGap(A.length)
      let same = 0
      let changed = 0
      let only = 0
      const marked = rows.map((r) => {
        const present = r.sides.filter((t) => t != null)
        const isSame = present.length >= 2 && present.every((t) => t === present[0])
        if (isSame) same += 1
        else if (present.length === 3) changed += 1
        else only += 1
        return { ...r, same: isSame }
      })
      return { rows: marked, stats: { same, changed, only, total: marked.length } }
    }

    // Rough per-turn token weights for the budget planner. Measured prompt sizes
    // (turn-tail/step usage) win; turns without usage fall back to chars × 0.62.
    const planTokens = (turns, answers) => {
      const lastOfTurn = new Map()
      for (const ans of answers) {
        if (ans.usage && ans.usage.totalTokens != null) lastOfTurn.set(ans.turn, ans.usage)
      }
      const weights = []
      let prevPrompt = 0
      let lastPrompt = null
      let lastOut = 0
      for (const t of turns) {
        const u = lastOfTurn.get(t.turn)
        if (u) {
          const prompt = Math.max(0, (u.totalTokens ?? 0) - (u.outputTokens ?? 0))
          weights.push(Math.max(0, prompt - prevPrompt))
          prevPrompt = prompt
          lastPrompt = prompt
          lastOut = u.outputTokens ?? 0
        } else {
          weights.push(Math.round(((t.question?.length ?? 0) + t.chars) * 0.62))
        }
      }
      const current = lastPrompt != null ? lastPrompt + lastOut : weights.reduce((n, w) => n + w, 0)
      return { weights, current }
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
        if (!node) continue
        // completed-turn footer carries the turn's token accounting
        if (node.kind === 'turn-tail') {
          if (current && node.data?.tokenUsage) current.usage = node.data.tokenUsage
          continue
        }
        if (node.visibility === 'hidden') continue
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
        current.answers.push({
          key,
          messageId: data.finalNode?.messageId ?? data.messageId ?? key,
          text,
          chars: text.length,
          time,
          usage: data.usage ?? null,
        })
        current.chars += text.length
        if (!current.time) current.time = time
      }
      return turns
    }

    const answersOf = (turns) =>
      turns.flatMap((t) =>
        t.answers.map((a) => ({ ...a, turn: t.turn, question: t.question, usage: a.usage ?? t.usage ?? null }))
      )

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
            id: `${earlier.turn}:${later.turn}`,
            question: later.question,
            from: earlier.turn,
            to: later.turn,
            left: earlier.answers[earlier.answers.length - 1],
            right: later.answers[later.answers.length - 1],
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

    const markdownOf = (a, b, result, third) => {
      const sides = [a, b, ...(third ? [third] : [])]
      const names = sides.length === 3 ? ['左', '中', '右'] : ['左', '右']
      const head = sides.map((s, i) => `- ${names[i]}：#${s.turn}（${s.chars} 字）`).join('\n')
      const bodies = sides.map((s, i) => `## ${names[i]} · #${s.turn}\n\n${s.text}`).join('\n\n')
      return `# dsh-scalpel 对比\n\n${head}\n- 结构：${result.stats.total} 段，相同 ${result.stats.same}，改动 ${result.stats.changed}，单侧 ${result.stats.only}\n\n${bodies}\n`
    }

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

    // ---- per-turn token accounting (turn-tail node's tokenUsage) ----
    const num = (n) => (n == null ? '—' : n.toLocaleString('en-US'))
    const compactTok = (n) => {
      if (n == null) return '—'
      if (n >= 1e6) {
        const v = n / 1e6
        return (Number.isInteger(v) ? v : v.toFixed(2)) + 'M'
      }
      if (n >= 1e4) {
        const v = n / 1e3
        return (Number.isInteger(v) ? v : v.toFixed(1)) + 'k'
      }
      return n.toLocaleString('en-US')
    }
    const usageParts = (u) => {
      if (!u) return null
      const uncached = u.uncachedInputTokens ?? u.inputTokens ?? null
      const out = u.outputTokens ?? null
      const cr = u.cacheReadTokens ?? null
      const cw = u.cacheWriteTokens ?? null
      let total = u.totalTokens ?? null
      if (total == null && uncached != null && out != null) total = uncached + out + (cr ?? 0) + (cw ?? 0)
      const input = total != null && out != null ? total - out : uncached != null ? uncached + (cr ?? 0) + (cw ?? 0) : null
      const hit = cr != null && input != null && input > 0 ? Math.round((cr / input) * 1000) / 10 : null
      return { uncached, out, cr, cw, total, hit }
    }

    // Cross-component hand-off: the action button preselects one side, then
    // switches to this view. Module scope = one instance per page.
    const request = { messageId: null }

    // ---- styles: only DSH theme tokens (no hardcoded colors) ----
    const CSS = [
      '.sc-page{display:flex;flex-direction:column;height:100%;min-height:0;box-sizing:border-box;color:var(--dsw-alias-label-primary);font-size:var(--dsh-content-font-size-secondary,13px);background:transparent}',
      '.sc-head{display:flex;gap:10px;align-items:center;flex-wrap:nowrap;padding:10px 16px;min-height:48px;position:sticky;top:0;z-index:2;background:var(--dsw-alias-bg-base);border-bottom:.5px solid var(--dsw-alias-border-l2,rgba(0,0,0,.1))}',
      '.sc-tools{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 16px 10px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.sc-grow{flex:1;min-width:0}',
      // selects/buttons follow the model-picker idiom in ui-model-selection:
      // ghost trigger + hover fill, popup on the shared "specific-menu" surface
      '.sc-sel{display:inline-flex;align-items:center;gap:4px;height:28px;max-width:320px;padding:0 4px 0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;font-weight:400;line-height:20px;cursor:pointer}',
      '.sc-sel:hover,a.sc-sel:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.sc-sel:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.sc-sel[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.sc-sel-label{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-tools .sc-sel{width:100%;max-width:none}',
      '.sc-tools .sc-menu-wrap{flex:1 1 200px;min-width:0}',
      '.sc-tools .sc-input{flex:0 1 170px;min-width:120px;width:auto}',
      '.sc-sel-chev{flex:none;color:var(--dsw-alias-label-caption);font-size:10px;line-height:1;transform:translateY(-1px)}',
      '.sc-menu-wrap{position:relative;display:inline-flex;min-width:0}',
      '.sc-menu{position:absolute;top:calc(100% + 6px);left:0;z-index:1100;display:flex;flex-direction:column;min-width:min(320px,90vw);max-width:min(460px,92vw);max-height:min(360px,60vh);overflow:auto;padding:4px;border:0;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu,var(--dsw-alias-bg-layer-2));backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2)}',
      '.sc-mi{display:flex;align-items:center;gap:6px;width:100%;min-height:34px;padding:5px 8px;border:0;border-radius:var(--dsw-radius-md);background:0 0;color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;font-weight:400;line-height:18px;text-align:left;cursor:pointer}',
      '.sc-mi:hover,.sc-mi:focus-visible{background:var(--dsw-alias-interactive-bg-hover);outline:none}',
      '.sc-mi[data-on=true]{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc-mi-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-mi-check{flex:0 0 14px;color:var(--dsw-alias-label-primary);font-size:12px;text-align:center}',
      '.sc-mi-sub{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:30px;padding:0 13px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:4px;background:var(--dsw-alias-bg-layer-2,#fff);color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:13px;font-weight:400;line-height:20px;cursor:pointer;white-space:nowrap;transition:background-color .12s ease,color .12s ease,border-color .12s ease}',
      '.sc-btn:hover{background:var(--dsw-alias-interactive-bg-hover);border-color:var(--dsw-alias-brand-primary,#4b6bff);color:var(--dsw-alias-brand-primary,#4b6bff)}',
      '.sc-btn:active{background:var(--dsw-alias-interactive-bg-active)}',
      '.sc-btn:focus-visible{outline:none;box-shadow:0 0 0 2px color-mix(in srgb,var(--dsw-alias-brand-primary,#4b6bff) 30%,transparent)}',
      '.sc-btn-solid{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary)}',
      '.sc-btn-solid:hover{background:var(--dsw-alias-interactive-bg-active)}',
      '.sc-action{display:inline-flex;align-items:center;gap:4px;height:24px;padding:0 8px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer}',
      '.sc-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.sc-stat{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.sc-toggle{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary);font-size:12.5px;line-height:20px;cursor:pointer;white-space:nowrap}',
      '.sc-tools .sc-toggle:first-of-type{margin-left:auto}',
      '.sc-toggle input{width:16px;height:16px;margin:0;accent-color:var(--dsw-alias-brand-primary,#4b6bff);cursor:pointer}',
      '.sc-body{flex:1;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:16px;padding:14px 16px 24px;--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}',
      '.sc-cell{padding:0;white-space:normal;overflow-wrap:anywhere;line-height:1.72}',
      '.sc-bd>:last-child{margin-bottom:0}',
      '.sc-line{margin:0}',
      '.sc-gap{height:.7em}',
      '.sc-h{font-weight:600;margin:.2em 0}',
      '.sc-li{display:flex;gap:6px}',
      '.sc-li::before{content:"•";color:var(--dsw-alias-label-tertiary);flex:none}',
      '.sc-quote{border-left:2px solid var(--dsw-alias-border-l3);padding-left:10px;color:var(--dsw-alias-label-secondary)}',
      '.sc-code{display:block;margin:6px 0;padding:10px 12px;overflow:auto;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block);color:var(--dsw-alias-label-primary);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12.5px;line-height:1.6;white-space:pre}',
      '.sc-ic{padding:1px 5px;border-radius:var(--dsw-radius-xs);background:var(--dsw-alias-markdown-inline-code);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:.94em}',
      // ---- two-column compare, laid out like agent-acta's 两轮对比 dialog:
      // a VS header, a bordered metric table, then one bordered card pair per block.
      '.sc-vshead{display:flex;align-items:flex-start;gap:16px;margin:0 0 2px}',
      '.sc-vh{flex:1;min-width:0;padding:0}',
      '.sc-vh-l{border-right:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));padding-right:16px}',
      '.sc-vh-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);min-width:0;line-height:22px}',
      '.sc-vh-title span.t{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-vh-meta{margin-top:4px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-vh-usage{margin-top:3px;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.sc-vs{flex:none;align-self:center;padding:0 2px;font-size:12px;font-weight:800;letter-spacing:1px;color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary))}',
      '.sc-metrics{margin:12px 0 2px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:10px;background:var(--dsw-alias-bg-layer-1);overflow:hidden}',
      '.sc-mrow{display:flex;align-items:center;gap:12px;padding:9px 12px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));min-width:0}',
      '.sc-mrow:last-child{border-bottom:none}',
      '.sc-mlabel{flex:none;width:104px;display:flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-secondary)}',
      '.sc-mhot{font-size:11px;font-weight:700;color:var(--dsw-alias-brand-primary)}',
      '.sc-mval{flex:1;min-width:0;font-size:13px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-mval.big{color:var(--dsw-alias-label-primary);font-weight:600}',
      '.sc-mspan{flex:1;min-width:0;font-size:12.5px;color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-sec{display:flex;flex-direction:column;gap:8px}',
      '.sc-sec-h{display:flex;align-items:center;gap:8px;min-height:22px}',
      '.sc-sec-idx{font-size:13px;font-weight:700;color:var(--dsw-alias-label-primary)}',
      '.sc-tag{flex:none;font-size:11px;font-weight:600;line-height:17px;padding:0 7px;border-radius:20px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary)}',
      '.sc-tag-changed{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 16%,transparent);color:var(--dsw-alias-state-warn-primary)}',
      '.sc-tag-left{background:color-mix(in srgb,var(--dsw-alias-state-error-primary) 14%,transparent);color:var(--dsw-alias-state-error-primary)}',
      '.sc-tag-right{background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent);color:var(--dsw-alias-state-success-primary)}',
      '.sc-tag-mid{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 16%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.sc-viewseg{display:flex;align-items:center;flex:none;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:14px;overflow:hidden}',
      '.sc-viewseg button{height:26px;padding:0 10px;border:0;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12px;font-weight:500;cursor:pointer}',
      '.sc-viewseg button[data-on=true]{background:var(--dsw-alias-interactive-bg-hover-solid);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.sc-same{display:flex;align-items:center;gap:8px;width:100%;padding:6px 10px;border:1px dashed var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:8px;background:transparent;color:inherit;font-family:inherit;text-align:left;cursor:pointer}',
      '.sc-same:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc-same-text{flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.sc-same-open{flex:none;color:var(--dsw-alias-brand-text,#4b6bff);font-size:12px}',
      '.sc-same-toggle{border:0;background:transparent;color:var(--dsw-alias-brand-text,#4b6bff);font-family:inherit;font-size:12px;cursor:pointer;padding:0 4px}',
      '.sc-lines{display:flex;flex-direction:column;gap:6px}',
      '.sc-lrow{display:flex;gap:8px;align-items:flex-start}',
      '.sc-badge{flex:none;margin-top:2px;padding:0 6px;border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:17px;font-weight:600}',
      '.sc-badge-0{background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#dc2626) 14%,transparent);color:var(--dsw-alias-state-error-primary,#dc2626)}',
      '.sc-badge-1{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 16%,transparent);color:var(--dsw-alias-state-warn-primary,#d97706)}',
      '.sc-badge-2{background:color-mix(in srgb,var(--dsw-alias-state-success-primary,#16a34a) 14%,transparent);color:var(--dsw-alias-state-success-primary,#16a34a)}',
      '.sc-lbody{flex:1;min-width:0;padding:6px 10px;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:8px;background:var(--dsw-alias-bg-layer-1)}',
      '.sc-only-m{border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary,#d97706) 35%,var(--dsw-alias-border-l1,#e5e7eb))}',
      '.sc-sec-cols{display:flex;gap:14px;align-items:stretch}',
      '.sc-col{flex:1;min-width:0;border:1px solid var(--dsw-alias-border-l1,rgba(0,0,0,.08));border-radius:9px;background:var(--dsw-alias-bg-layer-1);padding:10px 12px}',
      '.sc-col-empty{color:var(--dsw-alias-label-dimmed,var(--dsw-alias-label-tertiary));font-size:12.5px}',
      '.sc-changed{box-shadow:inset 2px 0 0 color-mix(in srgb,var(--dsw-alias-state-warn-primary) 60%,transparent)}',
      '.sc-only-l{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary) 35%,var(--dsw-alias-border-l1));background:var(--dsw-alias-code-diff-deleted)}',
      '.sc-only-r{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 35%,var(--dsw-alias-border-l1));background:var(--dsw-alias-code-diff-added)}',
      '.sc-del{background:var(--dsw-alias-code-diff-deleted);box-shadow:inset 2px 0 0 var(--dsw-alias-state-error-primary);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary)}',
      '.sc-ins{background:var(--dsw-alias-code-diff-added);box-shadow:inset 2px 0 0 var(--dsw-alias-state-success-primary);border-radius:var(--dsw-radius-xs);color:var(--dsw-alias-label-primary)}',
      '.sc-note{padding:28px 20px;color:var(--dsw-alias-label-tertiary);line-height:1.8}',
      '.sc-mask{position:fixed;inset:0;z-index:9999;display:flex;align-items:center;justify-content:center;padding:max(24px,3vh) 24px;background:var(--dsw-alias-bg-mask-1);backdrop-filter:var(--dsw-mask-blur)}',
      '.sc-panel{width:100%;max-width:1440px;height:100%;max-height:calc(100vh - 48px);display:flex;flex-direction:column;overflow:hidden;background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-panel);box-shadow:var(--dsw-elevation-prominent)}',
      '.sc-panel .sc-head{background:transparent}',
      '.sc-panel ::-webkit-scrollbar-thumb{background:var(--dsw-alias-scrollbar-bg-l2)}',
      // mode switch = pill tabs (agent-acta's cmp-pick idiom), not the underline tab bar
      '.sc-seg{display:flex;align-items:center;gap:8px;flex:none}',
      '.sc-seg button{height:28px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.12));border-radius:14px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;font-weight:600;line-height:26px;cursor:pointer;transition:background-color .12s ease,color .12s ease,border-color .12s ease}',
      '.sc-seg button:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.sc-seg button[data-on=true]{background:var(--dsw-alias-brand-primary,#4b6bff);border-color:var(--dsw-alias-brand-primary,#4b6bff);color:#fff}',
      '.sc-seg button:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-alias-state-business-primary)}',
      '.sc-input{height:30px;padding:0 9px;border:1px solid var(--dsw-alias-border-l4,rgba(0,0,0,.18));border-radius:4px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-family:inherit;font-size:13px;line-height:20px;outline:none}',
      '.sc-input::placeholder{color:var(--dsw-alias-label-dimmed)}',
      '.sc-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      '.sc-hit{background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 24%,transparent);border-radius:var(--dsw-radius-xs)}',
      '.sc-drop{flex:1;min-height:0;display:flex;flex-direction:column}',
      '.sc-drop-head{display:flex;gap:12px;align-items:center;padding:10px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.sc-plan{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.sc-rules{display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:8px 14px;border-bottom:.5px solid var(--dsw-alias-border-l1,rgba(0,0,0,.06))}',
      '.sc-rule{display:inline-flex;align-items:center;gap:4px;padding:1px 4px 1px 8px;border-radius:12px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-size:12px;line-height:20px}',
      '.sc-rule-x{width:16px;height:16px;padding:0;border:0;border-radius:50%;background:transparent;color:var(--dsw-alias-label-tertiary);font-family:inherit;font-size:12px;line-height:1;cursor:pointer}',
      '.sc-rule-x:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-state-error-primary)}',
      '.sc-drop-actions{display:flex;gap:8px;flex:none;margin-left:auto}',
      '.sc-btn:disabled{opacity:.45;cursor:default}',
      '.sc-btn:disabled:hover{background:var(--dsw-alias-bg-layer-2,#fff);border-color:var(--dsw-alias-border-l2,rgba(0,0,0,.12));color:var(--dsw-alias-label-secondary)}',
      '.sc-turns{flex:0 1 auto;max-height:46vh;min-height:0;overflow:auto;padding:4px 14px 8px}',
      '.sc-trow{display:grid;grid-template-columns:44px 52px 1fr 178px;gap:10px;align-items:baseline;padding:7px 8px;border-bottom:.5px solid var(--dsw-alias-border-l1);cursor:pointer;font-size:13px;line-height:20px}',
      '.sc-tok{text-align:right;white-space:nowrap}',
      '.sc-trow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.sc-trow[data-in=true]{background:var(--dsw-alias-markdown-tag);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}',
      '.sc-dim{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}',
      '.sc-cmd{display:flex;gap:8px;align-items:center;margin:6px 14px 10px;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-markdown-code-block)}',
      '.sc-cmd code{flex:1;min-width:0;overflow:auto;white-space:pre;background:none;border:0;padding:0;color:var(--dsw-alias-label-primary);font-family:var(--dsh-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:18px}',
      '.sc-flash{color:var(--dsw-alias-state-success-primary);font-size:12px}',
    ].join('\n')

    // Keep the style tag in sync instead of injecting once: on hot reload the
    // plugin module is swapped but <head> survives, so an early return would
    // keep the previous version's CSS while the new markup is already rendered.
    const ensureStyles = () => {
      try {
        if (typeof document === 'undefined' || !document.head) return
        let el = document.querySelector('style[data-dsh-scalpel]')
        if (!el) {
          el = document.createElement('style')
          el.setAttribute('data-dsh-scalpel', '')
          el.textContent = CSS
          document.head.appendChild(el)
          return
        }
        if (el.textContent !== CSS) el.textContent = CSS
      } catch (err) {
        console.warn('[dsh-scalpel] style injection failed: ' + (err?.message ?? err))
      }
    }

    const spans = (ops, side) =>
      ops.map((o, i) => h('span', { key: i, className: o.t === 'same' ? undefined : side === 'left' ? 'sc-del' : 'sc-ins' }, o.text))

    // Answers are markdown; render the common subset instead of raw text so the
    // page reads like the chat itself. Inline code / bold are enough here.
    const inlineRich = (text, key) => {
      const out = []
      const re = /(`[^`]*`|\*\*[^*]+\*\*)/g
      let last = 0
      let i = 0
      let m
      while ((m = re.exec(text)) !== null) {
        if (m.index > last) out.push(text.slice(last, m.index))
        const raw = m[0]
        if (raw[0] === '`') out.push(h('code', { key: `${key}c${i}`, className: 'sc-ic' }, raw.slice(1, -1)))
        else out.push(h('strong', { key: `${key}b${i}` }, raw.slice(2, -2)))
        last = m.index + raw.length
        i += 1
      }
      if (last < text.length) out.push(text.slice(last))
      return out.length ? out : [text]
    }

    const renderRich = (text, key) => {
      const nodes = []
      String(text ?? '')
        .split(/(```[\s\S]*?(?:```|$))/g)
        .forEach((part, pi) => {
          if (!part) return
          if (part.startsWith('```')) {
            const body = part.replace(/^```[^\n]*\n?/, '').replace(/```\s*$/, '')
            nodes.push(h('pre', { key: `${key}p${pi}`, className: 'sc-code' }, body))
            return
          }
          const kids = []
          part.split('\n').forEach((line, li) => {
            const s = line.trimEnd()
            const k = `${key}l${pi}_${li}`
            if (!s.trim()) {
              kids.push(h('div', { key: k, className: 'sc-gap' }))
              return
            }
            const head = s.match(/^\s*(#{1,6})\s+(.*)$/)
            if (head) {
              kids.push(h('div', { key: k, className: 'sc-h' }, inlineRich(head[2], k)))
              return
            }
            const item = s.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*)$/)
            if (item) {
              kids.push(h('div', { key: k, className: 'sc-li' }, inlineRich(item[1], k)))
              return
            }
            if (/^\s*>/.test(s)) {
              kids.push(h('div', { key: k, className: 'sc-quote' }, inlineRich(s.replace(/^\s*>\s?/, ''), k)))
              return
            }
            kids.push(h('div', { key: k, className: 'sc-line' }, inlineRich(s, k)))
          })
          if (kids.length) nodes.push(h('div', { key: `${key}b${pi}`, className: 'sc-bd' }, kids))
        })
      return nodes.length ? nodes : [h('div', { key: `${key}empty`, className: 'sc-line' }, '（空）')]
    }

    // A native <select> cannot be styled (Chrome draws the option list itself),
    // so this mirrors the model picker in ui-model-selection: a ghost trigger
    // plus a popup rendered on the shared menu surface token.
    function Picker({ value, onChange, items, placeholder, title, label }) {
      const [open, setOpen] = React.useState(false)
      const ref = React.useRef(null)
      React.useEffect(() => {
        if (!open) return undefined
        const onDown = (e) => {
          if (ref.current && !ref.current.contains(e.target)) setOpen(false)
        }
        const onKey = (e) => {
          if (e.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onDown)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('mousedown', onDown)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])
      const current = items.find((it) => it.value === value)
      return h(
        'div',
        { className: 'sc-menu-wrap', ref },
        h(
          'button',
          {
            type: 'button',
            className: 'sc-sel',
            title: title ?? (current ? current.label : placeholder),
            'aria-expanded': open ? 'true' : 'false',
            'aria-haspopup': 'listbox',
            onClick: () => setOpen((v) => !v),
          },
          label ? h('span', { className: 'sc-sel-label', style: { flex: 'none' } }, label) : null,
          h('span', { className: 'sc-sel-label' }, current ? current.label : placeholder),
          h('span', { className: 'sc-sel-chev' }, '▾')
        ),
        open
          ? h(
              'div',
              { className: 'sc-menu', role: 'listbox' },
              items.map((it) =>
                h(
                  'button',
                  {
                    key: it.value,
                    type: 'button',
                    role: 'option',
                    className: 'sc-mi',
                    'data-on': it.value === value ? 'true' : 'false',
                    'aria-selected': it.value === value ? 'true' : 'false',
                    onClick: () => {
                      onChange(it.value || null)
                      setOpen(false)
                    },
                  },
                  h('span', { className: 'sc-mi-text' }, it.label),
                  it.sub ? h('span', { className: 'sc-mi-sub' }, it.sub) : null,
                  h('span', { className: 'sc-mi-check' }, it.value === value ? '✓' : '')
                )
              )
            )
          : null
      )
    }

    function CompareView(props) {
      ensureStyles()
      const useChat = props.useChat
      const [leftKey, setLeftKey] = React.useState(null)
      const [rightKey, setRightKey] = React.useState(null)
      const [onlyDiff, setOnlyDiff] = React.useState(true)
      const [wordDiff, setWordDiff] = React.useState(false)
      const [filter, setFilter] = React.useState('')
      const [mode, setMode] = React.useState('compare')
      const [note, setNote] = React.useState('')
      const [flash, setFlash] = React.useState('')
      const [from, setFrom] = React.useState(0)
      const [to, setTo] = React.useState(0)
      const turnsRef = React.useRef(null)
      const [thirdKey, setThirdKey] = React.useState('')
      const [viewMode, setViewMode] = React.useState('side')
      const [foldSame, setFoldSame] = React.useState(false)
      const [openSame, setOpenSame] = React.useState({})
      const [budget, setBudget] = React.useState(500000)
      const [keepLast, setKeepLast] = React.useState(1)
      const [planNote, setPlanNote] = React.useState('')
      const [rules, setRules] = React.useState(null)
      const [ruleNote, setRuleNote] = React.useState('')

      const snapshot = useChat ? useChat((s) => s) : null
      const turns = React.useMemo(() => turnsOf(snapshot), [snapshot])
      const answers = React.useMemo(() => answersOf(turns), [turns])
      const pairs = React.useMemo(() => autoPairs(turns), [turns])
      const answerItems = React.useMemo(
        () =>
          answers.map((a) => ({
            value: a.key,
            label: `#${a.turn}${a.time ? ' · ' + clock(a.time) : ''} · ${a.chars}字`,
            sub: (a.question || a.text || '').replace(/\s+/g, ' ').slice(0, 60),
          })),
        [answers]
      )
      const pairItems = React.useMemo(
        () => pairs.map((p, i) => ({ value: String(i), label: `#${p.from} × #${p.to} · ${p.question.slice(0, 26)}` })),
        [pairs]
      )
      const thirdItems = React.useMemo(
        () => [{ value: '', label: '不对比' }, ...answerItems.filter((it) => it.value !== leftKey && it.value !== rightKey)],
        [answerItems, leftKey, rightKey]
      )

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
        setLeftKey(answers[answers.length - 2].key)
        setRightKey(answers[answers.length - 1].key)
      }, [answers.length, pairs.length])

      const a = answers.find((x) => x.key === leftKey)
      const b = answers.find((x) => x.key === rightKey)
      const third = answers.find((x) => x.key === thirdKey && x.key !== leftKey && x.key !== rightKey) ?? null
      const result = a && b && a.key !== b.key ? (third ? compare3(a.text, b.text, third.text) : compare(a.text, b.text)) : null
      const colCount = third ? 3 : 2
      const labels = colCount === 3 ? ['左', '中', '右'] : ['左', '右']
      const query = filter.trim().toLowerCase()
      const rows = (result?.rows ?? [])
        .map((r) => (r.sides ? r : { sides: [r.left, r.right], same: r.same }))
        .filter((r) => !onlyDiff || !r.same || foldSame)
        .filter((r) => !query || r.sides.some((t) => (t ?? '').toLowerCase().includes(query)))

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

      // ---- host bridge: the plugin's own host half persists drop rules ----
      const apiBase = React.useMemo(() => {
        try {
          return new URL('dsh-scalpel/api/', document.baseURI).pathname
        } catch {
          return '/dsh-scalpel/api/'
        }
      }, [])
      const sessionArg = String(props.sessionId ?? '')
      const api = (path, options) => {
        if (typeof fetch !== 'function') return Promise.reject(new Error('fetch unavailable'))
        return fetch(apiBase + path, { cache: 'no-store', ...options }).then((res) => {
          if (!res.ok) throw new Error('HTTP ' + res.status)
          return res.json()
        })
      }
      React.useEffect(() => {
        if (mode !== 'drop' || !sessionArg) return undefined
        let alive = true
        api('rules?session=' + encodeURIComponent(sessionArg))
          .then((r) => {
            if (alive) {
              setRules(r)
              setRuleNote('')
            }
          })
          .catch(() => {
            if (alive) {
              setRules(null)
              setRuleNote('宿主规则接口不可用，可用下方命令')
            }
          })
        return () => {
          alive = false
        }
      }, [mode, sessionArg])
      const postRule = async (path, body) => {
        if (!sessionArg) return null
        try {
          const r = await api(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ session: sessionArg, ...body }),
          })
          setRules(r)
          setRuleNote('')
          return r
        } catch (err) {
          setRuleNote('规则接口失败：' + (err?.message ?? err))
          return null
        }
      }

      // ---- compare body: VS header + metric table + one card pair per block ----
      // A render bug must never leave the tab blank: catch it and show the reason.
      let dropPanel = null
      try {
      const cellBody = (text, key) => (wordDiff && colCount === 2 ? markHits(text, filter) : renderRich(text, key))

      const tagFor = (r) => {
        const present = r.sides.map((t, j) => (t != null ? j : -1)).filter((j) => j >= 0)
        if (r.same) return { txt: '', cls: '' }
        if (present.length === colCount) return { txt: '改动', cls: 'sc-tag-changed' }
        const cls =
          present.length === 1
            ? present[0] === 0
              ? 'sc-tag-left'
              : present[0] === colCount - 1
                ? 'sc-tag-right'
                : 'sc-tag-mid'
            : 'sc-tag-changed'
        return { txt: '仅' + present.map((j) => labels[j]).join(''), cls }
      }
      const onlyCls = (j) => (j === 0 ? 'sc-only-l' : j === colCount - 1 ? 'sc-only-r' : 'sc-only-m')

      const secs = rows.map((r, i) => {
        const present = r.sides.map((t, j) => (t != null ? j : -1)).filter((j) => j >= 0)
        const tag = tagFor(r)
        if (r.same && foldSame && !openSame[i]) {
          const preview = String(present.length ? r.sides[present[0]] : '').replace(/\s+/g, ' ').slice(0, 90)
          return h(
            'div',
            { key: `sec${i}`, className: 'sc-sec' },
            h(
              'button',
              { type: 'button', className: 'sc-same', onClick: () => setOpenSame((v) => ({ ...v, [i]: true })) },
              h('span', { className: 'sc-sec-idx' }, `段 ${i + 1}`),
              h('span', { className: 'sc-tag' }, '相同'),
              h('span', { className: 'sc-same-text' }, preview),
              h('span', { className: 'sc-same-open' }, '展开')
            )
          )
        }
        const cols = r.sides.map((text, j) => {
          if (text == null) {
            return h('div', { key: `C${i}${j}`, className: 'sc-col' }, h('span', { className: 'sc-col-empty' }, '（无）'))
          }
          const changed = !r.same && present.length > 1
          const cls = r.same ? '' : changed ? 'sc-changed' : onlyCls(j)
          let content
          if (viewMode === 'side' && wordDiff && colCount === 2 && present.length === 2) {
            const ops = diffTokens(r.sides[0], r.sides[1])
            content = spans(j === 0 ? ops.left : ops.right, j === 0 ? 'left' : 'right')
          } else {
            content = cellBody(text, `C${i}${j}`)
          }
          return h('div', { key: `C${i}${j}`, className: 'sc-col' + (cls ? ' ' + cls : '') }, content)
        })
        const content =
          viewMode === 'line'
            ? h(
                'div',
                { className: 'sc-lines' },
                r.sides.map((text, j) =>
                  text == null
                    ? null
                    : h(
                        'div',
                        { key: `L${i}${j}`, className: 'sc-lrow' },
                        h('span', { className: 'sc-badge' + (r.same ? '' : ' sc-badge-' + j) }, r.same ? '同' : labels[j]),
                        h('div', { className: 'sc-lbody' }, cellBody(text, `L${i}${j}`))
                      )
                )
              )
            : h('div', { className: 'sc-sec-cols' }, cols)
        return h(
          'div',
          { key: `sec${i}`, className: 'sc-sec' },
          h(
            'div',
            { className: 'sc-sec-h' },
            h('span', { className: 'sc-sec-idx' }, `段 ${i + 1}`),
            tag.txt ? h('span', { className: 'sc-tag ' + tag.cls }, tag.txt) : null,
            r.same && foldSame
              ? h('button', { type: 'button', className: 'sc-same-toggle', onClick: () => setOpenSame((v) => ({ ...v, [i]: false })) }, '收起')
              : null
          ),
          content
        )
      })

      const mrow = (label, values, hot, bigIndex) =>
        h(
          'div',
          { key: label, className: 'sc-mrow' },
          h('span', { className: 'sc-mlabel' }, label, hot ? h('b', { className: 'sc-mhot' }, hot) : null),
          ...values.map((v, i) => h('span', { key: i, className: 'sc-mval' + (bigIndex === i ? ' big' : '') }, v))
        )
      const cols = [a, b, third].filter(Boolean)
      const chars = cols.map((x) => x.chars)
      const delta = b ? b.chars - a.chars : 0
      const bigIdx = chars.length > 1 ? chars.indexOf(Math.max(...chars)) : 0
      const ua = usageParts(a && a.usage)
      const ub = usageParts(b && b.usage)
      const uc = usageParts(third && third.usage)
      const usages = [ua, ub, uc].slice(0, cols.length)
      const hasUsage = usages.some(Boolean)
      const metrics = result && a && b
        ? h(
            'div',
            { className: 'sc-metrics' },
            mrow('字数', chars.map(String), delta ? `差 ${Math.abs(delta)}` : '', bigIdx),
            h(
              'div',
              { key: 'struct', className: 'sc-mrow' },
              h('span', { className: 'sc-mlabel' }, '结构'),
              h(
                'span',
                { className: 'sc-mspan' },
                `${result.stats.total} 段 · 相同 ${result.stats.same} · 改动 ${result.stats.changed} · 仅单侧 ${result.stats.only}`
              )
            ),
            hasUsage ? mrow('用量', usages.map((u) => num(u?.total))) : null,
            hasUsage ? mrow('未缓存输入', usages.map((u) => num(u?.uncached))) : null,
            hasUsage ? mrow('缓存读取', usages.map((u) => num(u?.cr))) : null,
            hasUsage ? mrow('缓存写入', usages.map((u) => num(u?.cw))) : null,
            hasUsage ? mrow('输出', usages.map((u) => num(u?.out))) : null,
            hasUsage ? mrow('缓存命中', usages.map((u) => (u?.hit == null ? '—' : `${u.hit}%`))) : null
          )
        : null

      const vh = (i, ans, total) => {
        const u = usageParts(ans && ans.usage)
        return h(
          'div',
          { key: `vh${i}`, className: 'sc-vh' + (i < total - 1 ? ' sc-vh-l' : '') },
          h(
            'div',
            { className: 'sc-vh-title' },
            h('span', { className: 't' }, ans ? `#${ans.turn}${ans.time ? ' · ' + clock(ans.time) : ''} · ${ans.chars} 字` : '未选择'),
            h('span', { className: 'sc-tag' }, labels[i])
          ),
          h('div', { className: 'sc-vh-meta' }, ans ? ans.question || '（无提问文本）' : '从上面的下拉里选一条回答'),
          u ? h('div', { className: 'sc-vh-usage' }, `${compactTok(u.total)} tok${u.hit == null ? '' : ' · 缓存命中 ' + u.hit + '%'}`) : null
        )
      }
      const shown = [a, b, third].filter(Boolean)
      const headNodes = []
      shown.forEach((ans, i) => {
        if (i) headNodes.push(h('div', { key: `vs${i}`, className: 'sc-vs' }, 'VS'))
        headNodes.push(vh(i, ans, shown.length))
      })

      const body = h(
        'div',
        { className: 'sc-body' },
        h('div', { className: 'sc-vshead' }, headNodes),
        metrics,
        secs.length ? secs : h('div', { className: 'sc-note' }, query ? '没有段落命中这个关键词。' : '当前选择没有可对比的差异。')
      )

      // ---- drop mode: pick a turn range, copy a CLI command that records the rule ----
      const sid =
        String(props.sessionId ?? '')
          .replace(/^session-/, '')
          .replace(/[^0-9a-zA-Z-]/g, '')
          .slice(0, 8) || 'latest'
      const totalChars = turns.reduce((n, t) => n + t.chars, 0)
      const dropFrom = from || 0
      const dropTo = to || from || 0
      const inRange = (turn) => dropFrom > 0 && turn >= dropFrom && turn <= dropTo
      const droppedChars = turns.filter((t) => inRange(t.turn)).reduce((n, t) => n + t.chars, 0)
      const droppedTurns = dropFrom > 0 ? dropTo - dropFrom + 1 : 0
      const share = totalChars ? Math.round((droppedChars / totalChars) * 100) : 0
      const plan = React.useMemo(() => planTokens(turns, answers), [turns, answers])
      const droppedTokens = turns.reduce((n, t, i) => (inRange(t.turn) ? n + (plan.weights[i] ?? 0) : n), 0)

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

      const resetSelection = () => {
        setFrom(0)
        setTo(0)
        setFlash('')
        if (turnsRef.current) turnsRef.current.scrollTop = 0
      }

      const budgetItems = [
        { value: 200000, label: '200K' },
        { value: 500000, label: '500K' },
        { value: 1000000, label: '1M' },
      ]
      const keepItems = [1, 2, 3, 5].map((n) => ({ value: n, label: n + ' 轮' }))
      const planByBudget = () => {
        const { weights, current } = plan
        const keep = Math.max(1, Number(keepLast) || 1)
        const maxDrop = Math.max(0, turns.length - keep)
        if (current <= budget) {
          setFrom(0)
          setTo(0)
          setPlanNote(`当前约 ${compactTok(current)} tok，已在 ${compactTok(budget)} 预算内`)
          return
        }
        let k = 0
        let remaining = current
        while (k < maxDrop && remaining > budget) {
          remaining -= weights[k] ?? 0
          k += 1
        }
        if (k === 0) {
          setPlanNote('保留轮数已占满，没有可删的旧轮次')
          return
        }
        setFrom(1)
        setTo(k)
        setPlanNote(
          `删 #1–#${k} 后约 ${compactTok(Math.max(0, remaining))} tok（当前约 ${compactTok(current)}）${remaining > budget ? '，仍超预算' : ''}`
        )
      }

      const turnRows = turns.map((t, i) =>
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
          h(
            'span',
            { className: 'sc-stat sc-tok', title: '按每轮 prompt 增量的实测值估算；没有用量记录的轮按字数折算' },
            `${t.chars} 字 · 约 ${compactTok(plan.weights[i])} tok`
          )
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

      dropPanel = h(
        'div',
        { className: 'sc-drop' },
        h(
          'div',
          { className: 'sc-drop-head' },
          h('span', { className: 'sc-stat' }, `${turns.length} 轮 · ${totalChars} 字 · 当前约 ${compactTok(plan.current)} tok`),
          h('span', { className: 'sc-dim' }, dropFrom > 0 ? `已选 #${dropFrom}–#${dropTo} · 少 ${droppedChars} 字（${share}%）· 省约 ${compactTok(droppedTokens)} tok` : '点两下行选一个区间'),
          h(
            'span',
            { className: 'sc-drop-actions' },
            dropFrom > 0 ? h('button', { className: 'sc-btn', onClick: () => { setFrom(0); setTo(0) } }, '清除') : null,
            h('button', { className: 'sc-btn', onClick: resetSelection, disabled: dropFrom === 0, title: '取消全部已选轮次' }, '重置')
          )
        ),
        h(
          'div',
          { className: 'sc-plan' },
          h(Picker, { key: 'budget', value: budget, onChange: setBudget, items: budgetItems, placeholder: '预算', label: '目标' }),
          h(Picker, { key: 'keep', value: keepLast, onChange: setKeepLast, items: keepItems, placeholder: '保留', label: '保留最近' }),
          h('button', { key: 'plan', className: 'sc-btn', onClick: planByBudget }, '按预算选删'),
          planNote ? h('span', { key: 'pn', className: 'sc-dim' }, planNote) : null
        ),
        h(
          'div',
          { className: 'sc-rules' },
          h('span', { className: 'sc-stat' }, '已生效'),
          rules && Array.isArray(rules.dropTurns) && rules.dropTurns.length
            ? rules.dropTurns.map((range) =>
                h(
                  'span',
                  { key: range.join('-'), className: 'sc-rule' },
                  `#${range[0]}–#${range[1]}`,
                  h(
                    'button',
                    { className: 'sc-rule-x', title: '撤销这条', onClick: () => postRule('undrop', { from: range[0], to: range[1] }) },
                    '×'
                  )
                )
              )
            : h('span', { className: 'sc-dim' }, ruleNote || '无'),
          rules && Array.isArray(rules.dropTurns) && rules.dropTurns.length
            ? h('button', { key: 'clear-all', className: 'sc-btn', onClick: () => postRule('undrop', { all: true }) }, '全部撤销')
            : null,
          h('span', { className: 'sc-grow' }),
          dropFrom > 0
            ? h(
                'button',
                {
                  key: 'apply',
                  className: 'sc-btn',
                  onClick: async () => {
                    const r = await postRule('drop', { from: dropFrom, to: dropTo })
                    if (r) setFlash(`已生效 #${dropFrom}–#${dropTo}`)
                  },
                },
                '应用当前区间'
              )
            : null
        ),
        h('div', { className: 'sc-turns', ref: turnsRef }, turnRows),
        cmds,
        h('div', { className: 'sc-note', style: { padding: '0 14px 12px' } }, droppedTurns > 0 ? `规则写进 ~/.dsh/scalpel-drop.json 后，下一轮起第 ${dropFrom}–${dropTo} 轮不再发给模型（原始会话记录不动，界面也不消失）。` : '选好区间后，复制下面的命令在任何终端执行；dry 只打印规则、不落盘。')
      )

      return h(
        'div',
        { className: 'sc-page', style: props.onClose ? undefined : { paddingBottom: 140 } },
        h(
          'div',
          { className: 'sc-head' },
          h(
            'div',
            { className: 'sc-seg' },
            h('button', { 'data-on': mode === 'compare' ? 'true' : 'false', onClick: () => setMode('compare') }, '对比'),
            h('button', { 'data-on': mode === 'drop' ? 'true' : 'false', onClick: () => setMode('drop') }, '删除范围')
          ),
          h('span', { className: 'sc-grow' }),
          flash ? h('span', { className: 'sc-flash' }, flash) : null,
          result
            ? h('button', { key: 'md', className: 'sc-btn', onClick: () => copy(markdownOf(a, b, result, third), '已复制 Markdown') }, '复制 Markdown')
            : null,
          props.onClose ? h('button', { className: 'sc-btn', onClick: props.onClose }, '关闭') : null
        ),
        mode === 'compare'
          ? h(
              'div',
              { className: 'sc-tools' },
              h(Picker, { key: 'ls', value: leftKey, onChange: setLeftKey, items: answerItems, placeholder: '选一条回答', label: '左' }),
              h(Picker, { key: 'rs', value: rightKey, onChange: setRightKey, items: answerItems, placeholder: '选一条回答', label: '右' }),
              h(Picker, { key: 'ts', value: third ? thirdKey : '', onChange: setThirdKey, items: thirdItems, placeholder: '第三条（可选）' }),
              h(
                'button',
                { key: 'swap', className: 'sc-btn', title: '交换左右', onClick: () => { const t = leftKey; setLeftKey(rightKey); setRightKey(t) } },
                '⇄'
              ),
              h(
                'div',
                { key: 'view', className: 'sc-viewseg' },
                h('button', { type: 'button', 'data-on': viewMode === 'side' ? 'true' : 'false', onClick: () => setViewMode('side') }, '并排'),
                h('button', { type: 'button', 'data-on': viewMode === 'line' ? 'true' : 'false', onClick: () => setViewMode('line') }, '行级')
              ),
              pairs.length > 0
                ? h(Picker, {
                    key: 'pair',
                    value: null,
                    onChange: (v) => {
                      const pair = pairs[Number(v)]
                      if (!pair) return
                      setLeftKey(pair.left.key)
                      setRightKey(pair.right.key)
                    },
                    items: pairItems,
                    placeholder: `自动配对（${pairs.length} 对）`,
                    title: '同一个问题问过多次，直接选那一对',
                  })
                : null,
              h('input', { key: 'filter', className: 'sc-input', placeholder: '搜索关键词', value: filter, onChange: (e) => setFilter(e.target.value) }),
              h(
                'label',
                { key: 'only', className: 'sc-toggle' },
                h('input', { type: 'checkbox', checked: onlyDiff, onChange: (e) => setOnlyDiff(e.target.checked) }),
                ' 仅看差异'
              ),
              h(
                'label',
                { key: 'fold', className: 'sc-toggle', title: '相同段落收成一行，点开可看原文' },
                h('input', { type: 'checkbox', checked: foldSame, onChange: (e) => setFoldSame(e.target.checked) }),
                ' 折叠相同段'
              ),
              colCount === 2
                ? h(
                    'label',
                    { key: 'word', className: 'sc-toggle', title: '段落内逐词标出增删（会失去排版）' },
                    h('input', { type: 'checkbox', checked: wordDiff, onChange: (e) => setWordDiff(e.target.checked) }),
                    ' 词级差异'
                  )
                : null
            )
          : null,
        note ? h('div', { className: 'sc-note' }, note) : mode === 'compare' ? body : dropPanel
      )
      } catch (err) {
        console.warn('[dsh-scalpel] render failed: ' + (err?.message ?? err))
        return h(
          'div',
          { className: 'sc-page' },
          h('div', { className: 'sc-note' }, '面板渲染出错：' + (err?.message ?? err) + '（把这句话发给我就能定位）')
        )
      }
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