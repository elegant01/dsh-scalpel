// dsh-scalpel — comparison core.
// Pure functions, no DOM, no Node APIs: the host CLI and the browser client
// both use this file. Ported from the verified compare.mjs.

export function splitBlocks(text) {
  const lines = String(text ?? '').split('\n')
  const blocks = []
  let buf = []
  let fence = null
  const flush = () => {
    const b = buf.join('\n').trim()
    if (b) blocks.push(b)
    buf = []
  }
  for (const line of lines) {
    const m = line.match(/^\s*(`{3,}|~{3,})/)
    if (m) {
      if (fence === null) fence = m[1][0]
      else if (line.trim() === fence || line.trim().startsWith(fence + fence)) fence = null
      buf.push(line)
      continue
    }
    if (fence === null && line.trim() === '') flush()
    else buf.push(line)
  }
  flush()
  return blocks
}

export const normalize = (s) =>
  String(s ?? '')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/[*_`>#\-[\]()|]/g, '')
    .replace(/\s+/g, '')
    .toLowerCase()

export function similarity(a, b) {
  if (a === b) return 1
  const A = [...a]
  const B = [...b]
  if (!A.length || !B.length) return 0
  if (A.length > 2000 || B.length > 2000) {
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
    const swap = prev
    prev = cur
    cur = swap
    cur.fill(0)
  }
  return prev[B.length] / Math.max(A.length, B.length)
}

const SAME_THRESHOLD = 0.82

// LCS over normalized block keys; unpaired neighbours are folded into paired
// "changed" rows so the output reads as edits, not as a staircase.
export function pairGaps(rows) {
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
    for (let p = 0; p < pairs; p += 1) out.push({ left: Ls[p], right: Rs[p], same: false, changed: true })
    for (let p = pairs; p < Ls.length; p += 1) out.push({ left: Ls[p], right: null, same: false, onlyLeft: true })
    for (let p = pairs; p < Rs.length; p += 1) out.push({ left: null, right: Rs[p], same: false, onlyRight: true })
  }
  return out
}

export function alignBlocks(left, right) {
  const L = left.map(normalize)
  const R = right.map(normalize)
  const n = L.length
  const m = R.length
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] =
        similarity(L[i], R[j]) >= SAME_THRESHOLD
          ? dp[i + 1][j + 1] + 1
          : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const rows = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (similarity(L[i], R[j]) >= SAME_THRESHOLD) {
      // "same" must compare the raw text, not the normalized key: a case-only
      // edit is a real difference the reader wants to see.
      rows.push({ left: left[i], right: right[j], same: left[i] === right[j] })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      rows.push({ left: left[i], right: null, same: false })
      i += 1
    } else {
      rows.push({ left: null, right: right[j], same: false })
      j += 1
    }
  }
  while (i < n) rows.push({ left: left[i], right: null, same: false }), (i += 1)
  while (j < m) rows.push({ left: null, right: right[j], same: false }), (j += 1)
  return pairGaps(rows)
}

export function tokenize(s) {
  return String(s ?? '').match(/[A-Za-z0-9_]+|[\u4e00-\u9fff]|\s+|[^\s]/g) ?? []
}

// Returns token ops so the caller can render <del>/<ins> however it likes.
export function diffTokens(a, b) {
  const A = tokenize(a)
  const B = tokenize(b)
  if (A.length > 3000 || B.length > 3000) {
    return { coarse: true, left: [{ t: 'same', text: String(a ?? '') }], right: [{ t: 'same', text: String(b ?? '') }] }
  }
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

export function compareAnswers(a, b) {
  const left = splitBlocks(a)
  const right = splitBlocks(b)
  const rows = alignBlocks(left, right)
  let same = 0
  let changed = 0
  let only = 0
  for (const row of rows) {
    if (row.same) same += 1
    else if (row.left && row.right) changed += 1
    else only += 1
  }
  return {
    rows,
    stats: { same, changed, only, total: rows.length },
    chars: { left: left.join('').length, right: right.join('').length },
  }
}