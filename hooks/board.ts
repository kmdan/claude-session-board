// Pure board logic: no `$`, so the tests drive it directly.
import type { Answered, Drafts, Mark, Marks, QPage, Sess } from '../types'

export type State = 'need' | 'waiting' | 'working' | 'today' | 'week' | 'earlier' | 'good' | 'done' | 'parked'

const DAY = 86_400_000
export const WEEK = 7 * DAY
export const MONTH = 30 * DAY

/**
 * A project is the folder a session runs in. Its colour comes from its name,
 * so it is stable without any setup; an optional `projects.json` beside the
 * plugin renames or recolours some: {"long-folder-name": {"label": "short", "color": "#hex"}}.
 */
export type ProjectNames = Record<string, { label?: string; color?: string }>

let names: ProjectNames = {}
export function setProjectNames(next: ProjectNames): void {
  names = next
}

const PALETTE = ['#7a5cf0', '#e0763a', '#1f9e8a', '#c9469b', '#3a7bd5', '#b8a03a', '#5fae6e', '#d0605e', '#4fa3b8', '#9b7bd0']

function hash(s: string): number {
  let x = 0
  for (const c of s) x = (x * 31 + c.charCodeAt(0)) >>> 0
  return x
}

export const projectLabel = (p: string): string => names[p]?.label ?? p
export const projectColor = (p: string): string => names[p]?.color ?? PALETTE[hash(p) % PALETTE.length]

/** Local midnight of the day `now` falls on. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** How recently a transcript must have been written for its session to count as working. */
export const ACTIVE_MS = 60_000

/**
 * Working right now: the app says it runs, or its transcript was written in
 * the last minute (a turn in progress writes every few seconds; a session
 * waiting for you writes nothing). The second needs no help from the app.
 */
export function isWorking(s: Sess, now: number): boolean {
  return s.running || now - (s.written ?? 0) < ACTIVE_MS
}

/** The app says the session stopped to wait for the person. */
export function isAsking(s: Sess): boolean {
  return s.appStatus === 'blocked' || s.appStatus === 'review_ready'
}

/**
 * A hand-set mark wins. Otherwise: running is working. "Needs you" is what
 * you touched today and did not close (it is on your plate), and what started
 * asking for you in the last day; asking older than that, within the week, is
 * "still waiting". Archived or a month quiet is parked. The rest is sorted by
 * when it last moved: today, earlier this week, earlier.
 */
export function stateOf(s: Sess, marks: Marks, now: number): State {
  const m = marks[s.id]?.mark
  if (m) return m === 'working' ? 'working' : m
  if (isWorking(s, now)) return 'working'
  const age = now - s.last
  const today = startOfDay(now)
  if (!s.archived) {
    if (isAsking(s) && age < DAY) return 'need'
    if ((s.touched ?? 0) >= today) return 'need'
    if (isAsking(s) && age < WEEK) return 'waiting'
  }
  if (s.archived || age >= MONTH) return 'parked'
  if (s.last >= today) return 'today'
  return age < WEEK ? 'week' : 'earlier'
}

export function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 36) return `${h} h`
  return `${Math.round(h / 24)} d`
}

/** Every word must hit one of: title, status text, project, a file path, a commit. */
export function matches(s: Sess, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (words.length === 0) return true
  const hay = [
    s.title, s.detail, s.needs, s.project, projectLabel(s.project), s.branch,
    ...s.commits, ...s.files, ...s.media.map(m => m.p), ...s.artifacts.map(a => a.title),
  ]
    .join('\n')
    .toLowerCase()
  return words.every(w => hay.includes(w))
}

export function byRecent(a: Sess, b: Sess): number {
  return b.last - a.last
}

/** Sessions not done that share a written file with this one, both active this week. */
export function overlaps(s: Sess, all: Sess[], marks: Marks, now: number): Sess[] {
  if (s.files.length === 0 || now - s.last >= WEEK) return []
  const mine = new Set(s.files.map(f => f.toLowerCase()))
  return all.filter(o => {
    if (o.id === s.id || now - o.last >= WEEK) return false
    const st = stateOf(o, marks, now)
    if (st === 'done' || st === 'parked') return false
    return o.files.some(f => mine.has(f.toLowerCase()))
  })
}

export function setMark(marks: Marks, id: string, mark: Mark | null, now: number): Marks {
  const next = { ...marks }
  if (mark === null) delete next[id]
  else next[id] = { mark, at: now }
  return next
}

const STOP = new Set([
  'with', 'from', 'that', 'this', 'into', 'over', 'when', 'what', 'session', 'sessions', 'issue', 'issues',
  'review', 'check', 'test', 'tests', 'testing', 'probe', 'update', 'fix', 'bug', 'support', 'new', 'and', 'the',
  'for', 'not', 'add', 'make', 'handover', 'debugging', 'investigation', 'feature', 'options',
])

/** Topic words of a session: its title and status text, lower-case, 4+ letters, stop words out. */
export function words(s: Sess): Set<string> {
  const text = `${s.title} ${s.detail}`.toLowerCase()
  return new Set((text.match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter(w => !STOP.has(w)))
}

export type Related = { s: Sess; score: number; why: string }

/**
 * Sessions on the same topic, any project. Evidence, strongest first: the same
 * family (parent / child), files both wrote, then title words both use,
 * weighted by how rare the word is across all sessions (a word every session
 * has says nothing). Below 2 points is noise and is dropped.
 */
export function related(s: Sess, all: Sess[], limit = 6): Related[] {
  return relatedFinder(all)(s, limit)
}

/**
 * The word and file counts over all sessions, built once; the finder it
 * returns scores one session against them. Building them is the slow part
 * (every session's words), so a board builds a finder once per index, not
 * once per drawing.
 */
export function relatedFinder(all: Sess[]): (s: Sess, limit?: number) => Related[] {
  const df = new Map<string, number>()
  const fileDf = new Map<string, number>()
  const wordsOf = new Map<string, Set<string>>()
  for (const o of all) {
    const w = words(o)
    wordsOf.set(o.id, w)
    for (const x of w) df.set(x, (df.get(x) ?? 0) + 1)
    for (const f of new Set(o.files.map(p => p.toLowerCase()))) fileDf.set(f, (fileDf.get(f) ?? 0) + 1)
  }
  return (s, limit = 6) => scoreRelated(s, all, limit, df, fileDf, wordsOf)
}

function scoreRelated(
  s: Sess, all: Sess[], limit: number,
  df: Map<string, number>, fileDf: Map<string, number>, wordsOf: Map<string, Set<string>>,
): Related[] {
  const mine = wordsOf.get(s.id) ?? words(s)
  // a file many sessions write (a README, a shared log) is no evidence of a topic
  const myFiles = new Set(s.files.map(f => f.toLowerCase()).filter(f => (fileDf.get(f) ?? 0) <= 6))
  const out: Related[] = []
  for (const o of all) {
    if (o.id === s.id) continue
    let score = 0
    const why: string[] = []
    if (o.parent === s.id || s.parent === o.id || (s.parent !== null && o.parent === s.parent)) {
      score += 6
      why.push('same thread')
    }
    const shared = o.files.filter(f => myFiles.has(f.toLowerCase()))
    if (shared.length > 0) {
      score += Math.min(6, 2 * shared.length)
      why.push(`${shared.length} same file${shared.length > 1 ? 's' : ''}`)
    }
    const common = [...(wordsOf.get(o.id) ?? [])].filter(w => mine.has(w))
    // one shared word alone ("never", "right") matched noise on real data; words count from two
    if (common.length >= 2 || (common.length === 1 && score > 0)) {
      score += common.reduce((sum, w) => sum + Math.log(all.length / (df.get(w) ?? 1)), 0) / 2
      why.push(common.slice(0, 3).join(', '))
    }
    if (score >= 2) out.push({ s: o, score, why: why.join(' · ') })
  }
  return out.sort((a, b) => b.score - a.score || b.s.last - a.s.last).slice(0, limit)
}

export function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut < 0 ? path : path.slice(cut + 1)
}

/** What a page asks, as one string: changes when a question is added, removed or reworded. */
export function pageSig(page: QPage): string {
  return page.qs.map(q => `${q.q}|${q.title}`).join('\n')
}

/**
 * A review page still asks when it was never answered, neither from the board
 * nor pasted into a chat (`chatAt`, by its title), or when its questions
 * changed since the recorded answer. A page rewritten after the answers, with
 * the same questions, stays answered.
 */
export function isOpenPage(page: QPage, answered: Answered, chatAt?: number): boolean {
  const a = answered[page.p]
  if (a) return a.sig !== undefined && a.sig !== pageSig(page)
  return chatAt === undefined
}

/** The latest time each page title was answered in any session's chat. */
export function chatAnswers(all: Sess[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const s of all) for (const a of s.answers ?? []) out.set(a.title, Math.max(out.get(a.title) ?? 0, a.at))
  return out
}

/**
 * The answers to a review page, in the page's own "Copy answers" format, so a
 * session reads them the same either way:
 *   Answers from <title>:
 *   Q1 [me]: <picked option's full text> | note: <note>
 *   General [me]: <free text>
 * Questions with neither a pick nor a note are left out; `count` says how many went.
 */
export function composeAnswers(page: QPage, drafts: Drafts): { text: string; count: number } {
  const lines: string[] = []
  for (const q of page.qs) {
    const d = drafts[`${page.p}#${q.q}`] ?? {}
    const parts: string[] = []
    if (d.pick) parts.push(d.pick)
    if (d.note?.trim()) parts.push(`note: ${d.note.trim()}`)
    if (parts.length) lines.push(`${q.q} [${q.to}]: ${parts.join(' | ')}`)
  }
  const general = drafts[`${page.p}#general`]?.note?.trim()
  if (general) lines.push(`General [me]: ${general}`)
  return { text: `Answers from ${page.title}:\n${lines.join('\n')}`, count: lines.length }
}

/** A local calendar day as `YYYY-MM-DD`. */
export function dayOf(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
const WEEKDAYS_FULL = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']

/**
 * Reads a quick-add line the Todoist way: `@word` is a label, and one date
 * word sets the due day (today, tomorrow/tmr, a weekday = its next one,
 * `3d` = in three days, or `2026-11-04`). Both leave the text.
 */
export function parseQuick(line: string, now: number): { text: string; labels: string[]; due?: string } {
  const labels: string[] = []
  let due: string | undefined
  const kept: string[] = []
  const day = new Date(now)
  day.setHours(12, 0, 0, 0)
  for (const word of line.trim().split(/\s+/)) {
    const low = word.toLowerCase()
    const label = /^@([\w-]+)$/.exec(word)
    const inDays = /^(\d{1,3})d$/.exec(low)
    const weekday = Math.max(WEEKDAYS.indexOf(low), WEEKDAYS_FULL.indexOf(low))
    if (label) {
      labels.push(label[1])
    } else if (due === undefined && (low === 'today' || low === 'tod')) {
      due = dayOf(day.getTime())
    } else if (due === undefined && (low === 'tomorrow' || low === 'tmr')) {
      due = dayOf(day.getTime() + 86_400_000)
    } else if (due === undefined && inDays) {
      due = dayOf(day.getTime() + Number(inDays[1]) * 86_400_000)
    } else if (due === undefined && /^\d{4}-\d{2}-\d{2}$/.test(low)) {
      due = low
    } else if (due === undefined && weekday >= 0) {
      const ahead = (weekday - day.getDay() + 7) % 7 || 7
      due = dayOf(day.getTime() + ahead * 86_400_000)
    } else {
      kept.push(word)
    }
  }
  return { text: kept.join(' '), labels, due }
}

export type DueBucket = 'overdue' | 'today' | 'upcoming' | 'none'

export function dueBucket(due: string | undefined, now: number): DueBucket {
  if (!due) return 'none'
  const today = dayOf(now)
  return due < today ? 'overdue' : due === today ? 'today' : 'upcoming'
}

/** How a due day reads on a todo: "today", "tomorrow", "Fri", "Nov 4", "3 d late". */
export function dueWord(due: string, now: number): string {
  const today = new Date(now)
  today.setHours(12, 0, 0, 0)
  const [y, m, d] = due.split('-').map(Number)
  const at = new Date(y, m - 1, d, 12)
  const days = Math.round((at.getTime() - today.getTime()) / 86_400_000)
  if (days < 0) return `${-days} d late`
  if (days === 0) return 'today'
  if (days === 1) return 'tomorrow'
  if (days < 7) return at.toLocaleDateString('en', { weekday: 'short' })
  return at.toLocaleDateString('en', { month: 'short', day: 'numeric' })
}

/** A dot of the graph view: where it sits (character cells) and the name shown beside it ('' = no room). */
export type GraphSpot = { i: number; x: number; y: number; label: string }

/**
 * Places sessions so related ones sit together: every pair pushes apart, every
 * relation (weight = its relatedness score) pulls its two ends together, the
 * frame keeps them in (a force layout, Fruchterman-Reingold). It starts from a
 * fixed spiral, so the same sessions land in the same places every time.
 * Then each dot takes the nearest free cell of a `cols` x `rows` grid, and its
 * name the room to its right, cut to fit or left out where a neighbour sits.
 */
export function layoutGraph(
  titles: string[], edges: [number, number, number][], cols: number, rows: number, labelMax = 16,
): GraphSpot[] {
  const n = titles.length
  if (n === 0) return []
  // a cell is about twice as tall as wide: lay out in square units, rows count double
  // the right edge keeps room for a short name
  const W = Math.max(10, cols - 10)
  const H = Math.max(4, rows - 1) * 2
  const k = Math.sqrt((W * H) / n) * 0.75
  const px = new Float64Array(n)
  const py = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const r = Math.sqrt((i + 0.5) / n) * 0.45
    const a = i * 2.39996
    px[i] = W / 2 + r * W * Math.cos(a)
    py[i] = H / 2 + r * H * Math.sin(a)
  }
  const maxW = Math.max(1, ...edges.map(e => e[2]))
  const dx = new Float64Array(n)
  const dy = new Float64Array(n)
  let t = W / 8
  for (let it = 0; it < 200; it++) {
    dx.fill(0)
    dy.fill(0)
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const ex = px[i] - px[j]
        const ey = py[i] - py[j]
        const d2 = Math.max(0.01, ex * ex + ey * ey)
        const f = (k * k) / d2
        dx[i] += ex * f; dy[i] += ey * f
        dx[j] -= ex * f; dy[j] -= ey * f
      }
    }
    for (const [a, b, w] of edges) {
      const ex = px[a] - px[b]
      const ey = py[a] - py[b]
      const d = Math.max(0.1, Math.sqrt(ex * ex + ey * ey))
      const f = (d / k) * (0.3 + w / maxW)
      dx[a] -= ex * f; dy[a] -= ey * f
      dx[b] += ex * f; dy[b] += ey * f
    }
    for (let i = 0; i < n; i++) {
      // a pull to the middle keeps loose sessions (no relation) from piling on the walls
      dx[i] += (W / 2 - px[i]) * 0.12 * k
      dy[i] += (H / 2 - py[i]) * 0.12 * k
      const d = Math.max(0.01, Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]))
      const step = Math.min(d, t)
      px[i] = Math.min(W, Math.max(0, px[i] + (dx[i] / d) * step))
      py[i] = Math.min(H, Math.max(0, py[i] + (dy[i] / d) * step))
    }
    t = Math.max(0.05, t * 0.97)
  }
  // onto the grid: the best-connected first, so the hubs get their names
  const degree = new Array(n).fill(0)
  for (const [a, b] of edges) { degree[a] += 1; degree[b] += 1 }
  const order = [...titles.keys()].sort((a, b) => degree[b] - degree[a] || a - b)
  const taken = Array.from({ length: rows }, () => new Array<boolean>(cols).fill(false))
  const free = (x: number, y: number, w: number) => {
    for (let c = x; c < x + w; c++) if (c >= cols || taken[y][c]) return false
    return true
  }
  const out: GraphSpot[] = []
  for (const i of order) {
    const gx = Math.round(px[i])
    const gy = Math.round((py[i] / H) * (rows - 1))
    // the nearest free cell, searched outward ring by ring
    let spot: [number, number] | undefined
    for (let r = 0; r < Math.max(cols, rows) && !spot; r++) {
      for (let oy = -r; oy <= r && !spot; oy++) {
        for (let ox = -r; ox <= r && !spot; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== r) continue
          const x = gx + ox
          const y = gy + oy
          if (y >= 0 && y < rows && x >= 0 && x < cols && free(x, y, 1)) spot = [x, y]
        }
      }
    }
    if (!spot) continue
    const [x, y] = spot
    taken[y][x] = true
    // the name: as much as fits before the next taken cell, a space either side
    const want = titles[i].length > labelMax ? `${titles[i].slice(0, labelMax - 1)}…` : titles[i]
    let w = 0
    while (w < want.length + 1 && x + 1 + w < cols && !taken[y][x + 1 + w]) w++
    const label = w >= 5 ? (want.length + 1 <= w ? want : `${want.slice(0, w - 2)}…`) : ''
    for (let c = x + 1; c < x + 1 + Math.min(w, label.length + 1); c++) taken[y][c] = true
    out.push({ i, x, y, label })
  }
  return out
}
