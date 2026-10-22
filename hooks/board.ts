// Pure board logic: no `$`, so the tests drive it directly.
import type { Mark, Marks, Sess } from '../types'

export type State = 'need' | 'waiting' | 'working' | 'week' | 'earlier' | 'good' | 'done' | 'parked'

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

/**
 * A hand-set mark wins. Otherwise: running is working; a session the app says
 * is blocked or ready for review is "needs you" for its first day and
 * "still waiting" for the rest of the week (a week of them at once is too
 * many to act on); archived or a month quiet is parked.
 */
export function stateOf(s: Sess, marks: Marks, now: number): State {
  const m = marks[s.id]?.mark
  if (m) return m === 'working' ? 'working' : m
  if (s.running) return 'working'
  const age = now - s.last
  if (!s.archived && age < WEEK && (s.appStatus === 'blocked' || s.appStatus === 'review_ready')) {
    return age < DAY ? 'need' : 'waiting'
  }
  if (s.archived || age >= MONTH) return 'parked'
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
  const df = new Map<string, number>()
  const fileDf = new Map<string, number>()
  const wordsOf = new Map<string, Set<string>>()
  for (const o of all) {
    const w = words(o)
    wordsOf.set(o.id, w)
    for (const x of w) df.set(x, (df.get(x) ?? 0) + 1)
    for (const f of new Set(o.files.map(p => p.toLowerCase()))) fileDf.set(f, (fileDf.get(f) ?? 0) + 1)
  }
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
