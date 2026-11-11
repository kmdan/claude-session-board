// One drawing's facts: the colours, the values read from state, and what is
// worked out from them, shared by the cards, sections and views.
import type { Note, QPage, Sess, Ui } from '../types'
import { byRecent, chatAnswers, dueBucket, isAsking, isOpenPage, isWorking, relatedFinder, stateOf } from './board'
import type { Related, State } from './board'
import { trailOf } from './actions'
import { background, GLOW, INBOX, live, readIndex, readShared, updateUi } from './state'
import type { $T } from './state'

// Calm on purpose (a red "needs you" reads as alarm): one muted accent for
// what waits on you, grey for the rest, the project colour only on a small dot.
export const ACCENT = '#c9a26b'
export const BORDER = '#3a3a40'
// A session's dot, as a traffic light: brown pulse while it works, still green
// when it finished and waits for you (not seen yet), grey once you have seen it.
// Only work pulses: a pulse reads as "still running, still spending".
export const WORKING = '#b08455'
export const READY = '#5fae6e'
export const SEEN = '#8a8a86'
// The pulse is an SVG animating itself (SMIL), so nothing redraws the board
// on a timer. Drawn where the surface has Svg (desktop, vscode, mobile).
// A session working right now (and the board indexing).
export const PULSE_WORKING = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">'
  + `<circle cx="6" cy="6" r="4" fill="${WORKING}">`
  + '<animate attributeName="opacity" values="1;0.2;1" dur="2s" repeatCount="indefinite"/>'
  + '<animate attributeName="r" values="4;2.6;4" dur="2s" repeatCount="indefinite"/>'
  + '</circle></svg>'

// The session this board is drawn in (the one being watched) gets the accent;
// sessions related to it get a border the stronger the relation, in three steps.
export const HERE = ACCENT
const RELATED_BORDER: [number, string][] = [[8, '#8f7a55'], [4, '#6b5d45'], [2, '#4f4840']]

// the state of each session in a drawn thread, one quiet dot each
export const DOT: Record<State, string> = {
  need: SEEN, waiting: SEEN, working: WORKING, today: SEEN, week: SEEN, earlier: SEEN,
  good: '#b8a46a', done: '#6f8fbf', parked: '#5a5a5e',
}

export const stateWord: Record<State, string> = {
  need: 'needs you', waiting: 'still waiting', working: 'working', today: 'today', week: 'earlier this week',
  earlier: 'earlier', good: 'good enough', done: 'done', parked: 'parked',
}

// one-off scratch folders (scratch-2026-10-21-4d8001) share one "scratch" chip;
// each still shows its own folder name on its card and is found by search
export const chipOf = (p: string) => (p.startsWith('scratch-') ? 'scratch' : p)

export const short = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t)

// what a drawing would otherwise compute every time: the related-session
// finder of the current index, the nearness to the watched session
let memo: {
  at: number; count: number; find: (s: Sess, limit?: number) => Related[]; near: Map<string, Map<string, number>>
  /** page title -> when it was last answered in any chat */
  chat: Map<string, number>
} = { at: -1, count: -1, find: () => [], near: new Map(), chat: new Map() }

// which session this board is drawn in (fixed for the module's life)
let selfCli: string | undefined

// What depends only on the list of sessions, worked out once per list: a quick
// check that changes nothing keeps the very same list, so most draws reuse this.
let lists = {
  all: undefined as Sess[] | undefined,
  byId: new Map<string, Sess>(),
  byCli: new Map<string, Sess>(),
  /** newest first */
  sorted: [] as Sess[],
  /** children by parent, newest first; archived ones only when you are in one */
  kidsOf: new Map<string, Sess[]>(),
  /** what the header's "? N" has to look through */
  withQuestions: [] as Sess[],
  /** the sessions you were in, last looked at first: what ‹ steps back through */
  byTouched: [] as Sess[],
}

function listsOf(all: Sess[]) {
  if (lists.all === all) return lists
  const sorted = [...all].sort(byRecent)
  const byId = new Map(all.map(s => [s.id, s]))
  const kidsOf = new Map<string, Sess[]>()
  for (const o of sorted) {
    if (!o.parent || !byId.has(o.parent) || (o.archived && o.cli !== selfCli)) continue
    const kids = kidsOf.get(o.parent)
    if (kids) kids.push(o)
    else kidsOf.set(o.parent, [o])
  }
  lists = {
    all,
    byId,
    byCli: new Map(all.map(s => [s.cli, s])),
    sorted,
    kidsOf,
    withQuestions: all.filter(s => !s.archived && s.questions.length > 0),
    byTouched: all.filter(s => !s.archived && (s.touched ?? 0) > 0).sort((a, b) => (b.touched ?? 0) - (a.touched ?? 0)),
  }
  return lists
}

export type TodoRow = { owner: string; n: Note; s?: Sess }

/**
 * Everything a drawing reads. Each drawing makes one; the cards, sections and
 * views are made from it.
 */
export async function readDrawing($: $T, e: Parameters<$T['ui']['resolve']>[0]) {
  const table = $.ui.resolve(e)
  // the terminal has no Svg; it keeps the word "indexing…" alone
  const Svg = 'Svg' in table ? table.Svg : undefined
  live.isShown = true
  const bodyColumns = (e.props as { bodyColumns?: number }).bodyColumns
  // a pane docked narrow: shorter tags and names, so the corners stay inside the cards
  const narrow = (bodyColumns ?? 80) < 60
  // how many rows the pane shows at once: a list standing alone fills them
  const bodyRows = (e.props as { scroll?: { bodyRows?: number } }).scroll?.bodyRows ?? 40
  const ix = await readIndex($)
  const { ui, marks, notes, moved, opening, answered, seen, fullText } = await readShared($)
  const now = Date.now()

  const setUi = (fn: (u: Ui) => Ui) => background($, updateUi($, fn))
  const all = ix.sessions
  selfCli ??= await $.session.id()
  const { byId, byCli, sorted, kidsOf, withQuestions, byTouched } = listsOf(all)

  // The per-index work is done once per index, not on every drawing: a
  // drawing that takes long is what shows as a blink when sessions switch.
  if (memo.at !== ix.at || memo.count !== all.length) {
    memo = { at: ix.at, count: all.length, find: relatedFinder(all), near: new Map(), chat: chatAnswers(all) }
  }
  // the watched session: the one this board is drawn in
  const here = byCli.get(selfCli)
  if (here && !memo.near.has(here.id)) memo.near.set(here.id, new Map(memo.find(here, 15).map(r => [r.s.id, r.score])))
  const nearness = here ? memo.near.get(here.id)! : new Map<string, number>()
  const { find, chat } = memo

  // The family of the session you are in, from its top: the sessions leading down
  // to you, last of all you. An archived session ends the climb: the board leaves it out.
  const hereChain: Sess[] = []
  for (let c = here; c && !hereChain.includes(c); c = c.parent ? byId.get(c.parent) : undefined) {
    if (c !== here && c.archived) break
    hereChain.unshift(c)
  }

  // a session's state is asked for many times in one drawing
  const states = new Map<string, State>()
  const st = (s: Sess) => {
    let state = states.get(s.id)
    if (state === undefined) {
      state = stateOf(s, marks, now)
      states.set(s.id, state)
    }
    return state
  }

  // Unseen: it finished a turn after you last looked at it -- in the app (its own
  // focus time, which a click on the Windows notification sets too) or on this
  // board. What the app's notification announced and you have not opened yet.
  // A subsession only when it asks you; a closed or parked one never.
  // Two marks, two questions: the green BORDER is "not looked at yet" (goes when
  // you look), the green DOT is "it asks you something" (the app says so, or a
  // question page is open). The dot fades after two days: a session quiet that
  // long is taken as okay. "No message from you since it finished" can't be the
  // test: a session always finishes after your message, so every one was green.
  const finishedForYou = (s: Sess) => !isWorking(s, now) && !s.archived && now - s.last < 7 * 86_400_000
    && (isAsking(s) || !s.parent) && !['done', 'parked', 'good'].includes(st(s))
  const isUnseen = (s: Sess) => finishedForYou(s) && Math.max(s.touched ?? 0, seen[s.id] ?? 0) < s.last
  const waitsForYou = (s: Sess) => finishedForYou(s) && now - s.last < 2 * 86_400_000
    && (isAsking(s) || s.questions.some(isPageOpen))
  // Just finished a turn that needs you (the app notifies on it) and not seen since: it comes on top.
  // A subsession only when it asks YOU (blocked / ready for review): one that merely reported
  // back sends its report to its main session, which is where the attention goes.
  const isFresh = (s: Sess) => isUnseen(s) && now - s.last < 30 * 60_000
    && (isAsking(s) || (!s.parent && st(s) === 'need'))
  // a subsession that finished a turn in the last half hour without asking you: it reported to its parent
  const hasReported = (s: Sess) => !!s.parent && !isWorking(s, now) && !isAsking(s) && now - s.last < 30 * 60_000
  // a subsession waiting on YOU (blocked / ready for review), not handed to its main session:
  // its own card in Needs you for as long as it waits, not only while fresh
  const asksYou = (s: Sess) => !!s.parent && isAsking(s) && !isWorking(s, now) && ['need', 'waiting'].includes(st(s))
  const isPageOpen = (p: QPage) => isOpenPage(p, answered, chat.get(p.title))
  const openPages = (s: Sess) => s.questions.filter(isPageOpen)

  const borderOf = (s: Sess) => {
    const g = moved[s.id] ?? 0
    if (g > 0) return GLOW[g]
    if (here && s.id === here.id) return HERE
    // finished since you last looked: the whole card says so, not only its dot
    if (isUnseen(s)) return READY
    const score = nearness.get(s.id) ?? 0
    return RELATED_BORDER.find(([min]) => score >= min)?.[1] ?? BORDER
  }

  const inChip = (s: Sess | undefined) => !ui.project || (!!s && chipOf(s.project) === ui.project)
  const inProject = ui.project ? all.filter(inChip) : all
  // archived sessions are found by search only: the board's lists leave them out
  // (the one this board is drawn in stays, under Here)
  const listed = sorted.filter(s => !s.archived && inChip(s))
  const groups: Record<State, Sess[]> = { need: [], waiting: [], working: [], today: [], week: [], earlier: [], good: [], done: [], parked: [] }
  // the watched session stays in its own place too: Here on top is a highlight, not a move
  for (const s of listed) groups[st(s)].push(s)

  // A subsession whose parent is in the same list shows nested under it, not
  // twice: except one that just asked for you, which gets its own card on
  // top (a notification about it must not point at a row hidden in an older
  // parent). The rest sort by their family's newest move, so a parent whose
  // child just moved comes up with it.
  // On the board (no search) a subsession that only reports is never listed on
  // its own: it is a row on its main session's rail, wherever that is listed.
  // The header and the section each ask for the same list: kept per list.
  const tops = new Map<Sess[], Sess[]>()
  const topLevel = (items: Sess[]) => {
    const kept = tops.get(items)
    if (kept) return kept
    const ids = new Set(items.map(s => s.id))
    // kidsOf is newest first: the family's newest move is its first child's
    const at = (s: Sess) => Math.max(s.last, kidsOf.get(s.id)?.[0]?.last ?? 0)
    // opening a card marks it seen, which ends its "fresh" place: the card you
    // just opened keeps that place while it is open, or it would vanish under the click
    // A subsession whose main session is listed here (or is the Here card) is
    // drawn on that card's rail, an asking one as a small card of its own: the
    // family reads as one block. One whose main session is elsewhere gets its
    // own card when it asks you, and is a rail row there otherwise.
    const onTop = (s: Sess) => isFresh(s) || asksYou(s) || (live.keptOnTop.has(s.id) && ui.open === s.id)
    const familyAsks = (s: Sess) => (kidsOf.get(s.id) ?? []).some(asksYou)
    const listedParent = (s: Sess) => !!s.parent && (ids.has(s.parent) || (!!here && s.parent === here.id))
    const nested = (s: Sess) => !!s.parent && (ids.has(s.parent) || (!ui.query && byId.has(s.parent)))
    const top = items
      .filter(s => !nested(s) || (onTop(s) && !listedParent(s)))
      .sort((a, b) => Number(onTop(b) || familyAsks(b)) - Number(onTop(a) || familyAsks(a)) || at(b) - at(a))
    tops.set(items, top)
    return top
  }

  // chips: every project with something this week, busiest first (a new project
  // must show from its first session; the row wraps)
  const weekCount: Record<string, number> = {}
  for (const s of all) if (!s.archived && now - s.last < 7 * 86_400_000) weekCount[chipOf(s.project)] = (weekCount[chipOf(s.project)] ?? 0) + 1
  const chips = Object.entries(weekCount).sort((a, b) => b[1] - a[1]).map(([p]) => p)

  // Every todo, with its session
  const allTodos: TodoRow[] = Object.entries(notes).flatMap(([owner, list]) =>
    list.map(n => ({ owner, n, s: owner === INBOX ? undefined : byId.get(owner) })))
  const dueToday = allTodos.filter(r => !r.n.done && ['overdue', 'today'].includes(dueBucket(r.n.due, now))).length
  // sessions with unanswered question pages written in the last two weeks (older ones are history)
  const asking = withQuestions.filter(s => openPages(s).some(p => now - p.t < 14 * 86_400_000)).length
  const recentTrail = byTouched.filter(s => !here || s.id !== here.id).slice(0, 30).map(s => s.id)
  const trail = await trailOf($, here?.id)
  const backTo = trail ? trail.list[trail.pos + 1] : recentTrail[0]
  // finished since you last looked (the app's notifications you have not opened)
  const unseenCount = listed.filter(s => (!here || s.id !== here.id) && isUnseen(s)).length

  // Tidy up: what could be archived. A family quiet a month (the session and all
  // its subsessions), or one you marked done or parked that has been quiet three
  // days. Never the family you are in, nor anything working. A subsession whose
  // main session is listed is not listed again: archiving the main session takes
  // its finished subsessions with it.
  const famLast = (s: Sess, depth = 0): number =>
    Math.max(s.last, ...(depth < 6 ? (kidsOf.get(s.id) ?? []).map(c => famLast(c, depth + 1)) : []))
  const isTidy = (s: Sess) => {
    if (hereChain.includes(s) || isWorking(s, now)) return false
    const quiet = now - famLast(s)
    const m = marks[s.id]?.mark
    return quiet >= 30 * 86_400_000 || ((m === 'done' || m === 'parked') && quiet >= 3 * 86_400_000)
  }
  const tidyAll = listed.filter(isTidy)
  const tidyIds = new Set(tidyAll.map(s => s.id))
  const tidy = tidyAll.filter(s => !(s.parent && tidyIds.has(s.parent)))
  // a session in its own worktree: archiving removes that worktree, so it is unticked unless you tick it
  const inWorktree = (s: Sess) => /[\\/](worktrees?|\.claude[\\/]worktrees)[\\/]/i.test(s.cwd)
  const isTicked = (s: Sess) => ui.tidyPick?.[s.id] ?? !inWorktree(s)

  return {
    table, Svg, bodyColumns, bodyRows, narrow, ix, ui, marks, notes, moved, opening, answered, seen, fullText, now, setUi,
    all, byId, byCli, kidsOf, here, hereChain, find, chat, st,
    finishedForYou, isUnseen, waitsForYou, isFresh, hasReported, asksYou, isPageOpen, openPages, borderOf,
    inChip, inProject, listed, groups, topLevel, chips, allTodos, dueToday, asking, recentTrail, trail, backTo, unseenCount,
    tidy, famLast, inWorktree, isTicked,
  }
}

export type Drawing = Awaited<ReturnType<typeof readDrawing>>
