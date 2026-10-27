import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Answered, Drafts, FullText, Index, IndexMeta, Mark, Marks, Media, Moved, Note, Notes, QPage, Sess, TextHit, Ui } from '../types'
import {
  ago, baseName, byRecent, chatAnswers, composeAnswers, dueBucket, dueWord, isAsking, isOpenPage, isWorking, matches,
  overlaps, pageSig,
  parseQuick, projectColor, projectLabel, relatedFinder,
  setMark, setProjectNames, stateOf,
} from './board'
import type { ProjectNames, Related, State } from './board'

const PANE = 'session-board'
const TITLE = 'Sessions'
const SHOWN = 5

// Calm on purpose (a red "needs you" reads as alarm): one muted accent for
// what waits on you, grey for the rest, the project colour only on a small dot.
const ACCENT = '#c9a26b'
const BORDER = '#3a3a40'
// A session's dot, as a traffic light: brown pulse while it works, green pulse
// when it finished and waits for you (not seen yet), grey once you have seen it.
const WORKING = '#b08455'
const READY = '#5fae6e'
const SEEN = '#8a8a86'
// The pulses are SVGs animating themselves (SMIL), so nothing redraws the board
// on a timer. Drawn where the surface has Svg (desktop, vscode, mobile).
const PULSE = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">'
  + `<circle cx="6" cy="6" r="4" fill="${READY}">`
  + '<animate attributeName="opacity" values="1;0.2;1" dur="1.2s" repeatCount="indefinite"/>'
  + '<animate attributeName="r" values="4;2.6;4" dur="1.2s" repeatCount="indefinite"/>'
  + '</circle></svg>'

// a session working right now (and the board indexing): brown and slower
const PULSE_WORKING = PULSE.replace(READY, WORKING).replaceAll('1.2s', '2s')

// The session this board is drawn in (the one being watched) gets the accent;
// sessions related to it get a border the stronger the relation, in three steps.
const HERE = ACCENT
const RELATED_BORDER: [number, string][] = [[8, '#8f7a55'], [4, '#6b5d45'], [2, '#4f4840']]

// the state of each session in a drawn thread, one quiet dot each
const DOT: Record<State, string> = {
  need: SEEN, waiting: SEEN, working: WORKING, today: SEEN, week: SEEN, earlier: SEEN,
  good: '#b8a46a', done: '#6f8fbf', parked: '#5a5a5e',
}

// The index's small facts live in shared state (a drawing subscribes to them);
// the sessions themselves (1.2 MB at 660) stay in this module's memory. In
// state they were copied out on every drawing: measured ~200 ms per click or
// keystroke at 660 sessions, growing with the count.
const indexAtom = atom({ plugin: 'session-board', key: 'index' } as const,
  { at: 0, note: 'not indexed yet', isLoading: false, version: 0 } as IndexMeta)
let sessionsNow: Sess[] = []

/** The index as a drawing or a tick uses it: the shared facts plus the sessions from memory. */
async function readIndex($: $T): Promise<Index> {
  const meta = await read($, indexAtom)
  return { ...meta, sessions: sessionsNow }
}
const uiAtom = atom({ plugin: 'session-board', key: 'ui' } as const,
  { query: '', project: '', open: '', limits: {}, shown: {}, view: 'board', focus: '', tab: '', label: '' } as Ui)
// where todos that belong to no session yet are kept
const INBOX = '_inbox'
const marksAtom = atom({ plugin: 'session-board', key: 'marks' } as const, {} as Marks)
const notesAtom = atom({ plugin: 'session-board', key: 'notes' } as const, {} as Notes)
const fullTextAtom = atom({ plugin: 'session-board', key: 'fullText' } as const,
  { query: '', hits: [], isLoading: false, note: '' } as FullText)
const movedAtom = atom({ plugin: 'session-board', key: 'moved' } as const, {} as Moved)
const openingAtom = atom({ plugin: 'session-board', key: 'opening' } as const, '')
const answeredAtom = atom({ plugin: 'session-board', key: 'answered' } as const, {} as Answered)
const draftsAtom = atom({ plugin: 'session-board', key: 'drafts' } as const, {} as Drafts)
// per session, when you last opened its card or the session: a newer ask pulses
const seenAtom = atom({ plugin: 'session-board', key: 'seen' } as const, {} as Record<string, number>)

type $T = EngineInterface

// A card that moved or changed state glows and fades back in three steps.
// The pane cannot animate a card sliding to its new place; the glow is what
// lets the eye find where it went.
const GLOW = ['', '#6b5d45', '#a8895c', '#e0b878']
const GLOW_STEP_MS = 700

/** Where each session sits now: its section and its rank in it, by recency. */
function placement(sessions: Sess[], marks: Marks, now: number): Map<string, string> {
  const rank = new Map<State, number>()
  const out = new Map<string, string>()
  for (const s of [...sessions].sort(byRecent)) {
    const st = stateOf(s, marks, now)
    const r = rank.get(st) ?? 0
    rank.set(st, r + 1)
    out.set(s.id, `${st}:${r}`)
  }
  return out
}

// the last placement this board drew; a reload starts it empty (no glow then)
let lastPlace = new Map<string, string>()

// what a drawing would otherwise compute every time: the related-session
// finder of the current index, the nearness to the watched session, and which
// session this board is drawn in (fixed for the module's life)
let memo: {
  at: number; count: number; find: (s: Sess, limit?: number) => Related[]; near: Map<string, Map<string, number>>
  /** page title -> when it was last answered in any chat */
  chat: Map<string, number>
} = { at: -1, count: -1, find: () => [], near: new Map(), chat: new Map() }
let selfCli: string | undefined

async function glow($: $T, ids: string[]): Promise<void> {
  if (ids.length === 0) return
  await update($, movedAtom, m => ({ ...m, ...Object.fromEntries(ids.map(id => [id, 3])) }))
  for (const step of [2, 1, 0]) {
    $.clock.after(GLOW_STEP_MS * (3 - step), () => {
      background($, update($, movedAtom, m => {
        const next = { ...m }
        for (const id of ids) {
          if (step === 0) delete next[id]
          else next[id] = step
        }
        return next
      }))
    })
  }
}

/** Takes a new index; the sessions whose section or rank changed glow (at most 12). */
async function setIndex($: $T, sessions: Sess[], at: number, note: string, isLoading: boolean, isFull = true): Promise<void> {
  const marks = (await read($, marksAtom)) ?? {}
  const place = placement(sessions, marks, Date.now())
  const moved = lastPlace.size === 0 ? [] : [...place].filter(([id, p]) => lastPlace.get(id) !== p).map(([id]) => id)
  lastPlace = place
  sessionsNow = sessions
  // the version bump is what redraws: the sessions themselves are not in state
  await update($, indexAtom, m => ({ at, note, isLoading, version: (m?.version ?? 0) + 1 }))
  if (moved.length <= 12) await glow($, moved)
  if (isFull) await recordChatAnswers($, sessions)
}

/**
 * A page answered by pasting its answers into a chat is recorded like one
 * answered from the board, with its questions' signature, so it stays closed
 * when its session rewrites it and opens again only for new questions.
 */
async function recordChatAnswers($: $T, sessions: Sess[]): Promise<void> {
  const chat = chatAnswers(sessions)
  const stored = ((await $.store.get('answered')) as Answered | undefined) ?? {}
  const added: Answered = {}
  for (const s of sessions) {
    for (const page of s.questions ?? []) {
      const at = chat.get(page.title)
      if (at !== undefined && !stored[page.p]) added[page.p] = { at, t: page.t, sig: pageSig(page) }
    }
  }
  if (Object.keys(added).length === 0) return
  const next = { ...stored, ...added }
  await $.store.set('answered', next)
  await update($, answeredAtom, () => next)
}

/**
 * Searches what was said in every conversation (the indexer's text copies,
 * local only) for all words of the query. Runs on Enter, not on each key.
 */
async function searchText($: $T, query: string): Promise<void> {
  const q = query.trim()
  if (q.length < 3) {
    await update($, fullTextAtom, () => ({ query: q, hits: [], isLoading: false, note: '' }))
    return
  }
  await update($, fullTextAtom, f => ({ ...f, query: q, isLoading: true }))
  const root = $.plugin.root
  try {
    const run = await $.process.run(['py', '-3', `${root}/scripts/sessionindex.py`, '--search', `${root}/cache`],
      { stdin: q, timeoutMs: 60_000 })
    if (run.exitCode !== 0) throw new Error(run.stderr.slice(-200))
    const out = JSON.parse(run.stdout) as { hits: TextHit[]; files: number; ms: number }
    const note = `${out.files} conversations searched in ${out.ms} ms`
    await update($, fullTextAtom, f => (f.query === q ? { query: q, hits: out.hits, isLoading: false, note } : f))
  } catch (err) {
    await update($, fullTextAtom, f => ({ ...f, isLoading: false, note: `search failed: ${String(err).slice(0, 160)}` }))
  }
}

/** Runs the indexer (cached: ~2 s) and merges the app's live "running" flags. */
async function refresh($: $T): Promise<void> {
  await update($, indexAtom, ix => ({ ...ix, isLoading: true }))
  await loadStored($)
  const root = $.plugin.root
  let note = ''
  let sessions: Sess[] | undefined
  try {
    const run = await $.process.run(
      ['py', '-3', `${root}/scripts/sessionindex.py`, `${root}/cache/index-cache.json`],
      { timeoutMs: 600_000 },
    )
    if (run.exitCode !== 0) {
      note = `indexer failed (exit ${run.exitCode}): ${run.stderr.slice(-300)}`
    } else {
      const out = JSON.parse(run.stdout) as { sessions: Sess[]; scanned: number; cached: number; missing: number; ms: number }
      sessions = out.sessions.map(s => ({
        ...s, files: s.files.slice(0, 15), commits: s.commits.slice(-6), media: s.media ?? [], artifacts: s.artifacts ?? [], questions: s.questions ?? [], answers: s.answers ?? [], running: false,
      }))
      note = `${out.sessions.length} sessions, ${out.scanned} transcripts read, ${out.cached} from cache, ${out.missing} without a transcript, ${out.ms} ms`
    }
  } catch (err) {
    note = `indexer did not run: ${String(err)}`
  }
  if (sessions) {
    // The app's own "running" list, when it answers; working is seen from the
    // transcripts either way (isWorking), so an unreachable list costs nothing.
    const live = await runningIds($)
    if (typeof live !== 'string') sessions = sessions.map(s => (live.has(s.id) ? { ...s, running: true } : s))
    const nowMs = Date.now()
    note += ` | ${sessions.filter(s => isWorking(s, nowMs)).length} working now`
      + (typeof live === 'string' ? ' (from transcript activity; the app list did not answer)' : '')
    const list = sessions
    const at = Date.now()
    await setIndex($, list, at, note, false)
    // what the next board to open draws at once, before its own refresh finishes
    await $.fs.write(`${root}/cache/snapshot.json`, JSON.stringify({ sessions: list, at, note }))
      .catch(() => undefined)
  } else {
    await update($, indexAtom, ix => ({ ...ix, note, isLoading: false }))
  }
}

/**
 * Draws the board from the last refresh any session saved, so it shows at
 * once (an index run takes seconds: Python start, every session file); the real
 * refresh then replaces it. An absent or broken snapshot is skipped.
 */
async function loadSnapshot($: $T, isForced = false): Promise<void> {
  const current = await readIndex($)
  if (current.sessions.length > 0 && !isForced) return
  try {
    const snap = JSON.parse(await $.fs.read(`${$.plugin.root}/cache/snapshot.json`)) as { sessions: Sess[]; at: number; note: string }
    if (snap.at <= current.at) return
    const note = `shared refresh, ${Math.round((Date.now() - snap.at) / 60_000)} min old | ${snap.note}`
    await setIndex($, snap.sessions, snap.at, note, current.isLoading)
  } catch {
    // no snapshot yet: the refresh draws the board
  }
}

// when the last quick check ran: the next one asks only for records changed since
let lastQuick = 0

/**
 * The 20-second check: the app's records that changed (a session finished, asks
 * for you, was looked at) are merged into the board at once, so it moves to its
 * place within seconds of the app's notification, not at the next full index.
 * Reads no transcript (about 0.1 s of work); a session the board has never seen
 * starts a full index instead.
 */
async function quickTick($: $T): Promise<void> {
  if (!isShown) return
  const ix = await readIndex($)
  if (ix.sessions.length === 0 || ix.isLoading) return
  const since = Math.max(lastQuick, ix.at) - 5_000
  lastQuick = Date.now()
  const root = $.plugin.root
  const run = await $.process.run(['py', '-3', `${root}/scripts/sessionindex.py`, '--quick', String(since)], { timeoutMs: 30_000 })
  if (run.exitCode !== 0) return
  const out = JSON.parse(run.stdout) as { rows: Partial<Sess>[]; written?: Record<string, number> }
  const rows = out.rows
  const written = out.written ?? {}
  const byId = new Map(ix.sessions.map(s => [s.id, s]))
  if (rows.some(r => r.id && !byId.has(r.id))) {
    await refresh($)
    return
  }
  const now = Date.now()
  const changed = new Map(rows.map(r => [r.id!, r]))
  let isDifferent = rows.length > 0
  const merged = ix.sessions.map(s => {
    const w = written[s.cli]
    const next = changed.has(s.id) ? { ...s, ...changed.get(s.id) } : s
    const withWritten = w !== undefined && w > (s.written ?? 0) ? { ...next, written: w } : next
    // a session that started or stopped working since the last check redraws the board,
    // even when nothing else changed (stopping is only time passing)
    if (withWritten !== s || isWorking(s, lastQuickNow) !== isWorking(withWritten, now)) isDifferent = true
    return withWritten
  })
  lastQuickNow = now
  if (isDifferent) await setIndex($, merged, ix.at, ix.note, false, false)
}

// the time of the last quick check, to see who stopped working since
let lastQuickNow = 0

// fresh cards you opened: they keep their place on top until you close them
const keptOnTop = new Set<string>()

// the search field's latest text, while the board waits for a pause in typing
let typedQuery = ''

/** You saw this session's latest: its "just asked" pulse stops. */
async function markSeen($: $T, id: string): Promise<void> {
  const stored = ((await $.store.get('seen')) as Record<string, number> | undefined) ?? {}
  const next = { ...stored, [id]: Date.now() }
  await $.store.set('seen', next)
  await update($, seenAtom, () => next)
}

/**
 * The 2-minute tick. With the board open in every session, only one of them
 * needs to index: a snapshot another session wrote under two minutes ago is
 * taken as it is.
 */
async function tick($: $T): Promise<void> {
  if (!isShown) return
  const stat = await $.fs.stat(`${$.plugin.root}/cache/snapshot.json`).catch(() => undefined)
  if (stat && Date.now() - stat.mtimeMs < 110_000) await loadSnapshot($, true)
  else await refresh($)
}

/** The ids the app reports running, or why that could not be read (printed on the bottom line). */
async function runningIds($: $T): Promise<Set<string> | string> {
  try {
    const res = await $.mcp.call('ccd_session_mgmt', 'list_sessions', { limit: 1000 })
    const block = res.content.find(c => c.type === 'text') as { text: string } | undefined
    if (!block) return `no text in the answer (isError ${String(res.isError)})`
    if (res.isError) return `error: ${block.text.slice(0, 160)}`
    const rows = JSON.parse(block.text) as { sessionId: string; isRunning: boolean }[]
    return new Set(rows.filter(r => r.isRunning).map(r => r.sessionId))
  } catch (err) {
    return `call failed: ${String(err).slice(0, 160)}`
  }
}

/**
 * Every open session runs its own copy of the board, all on one store. So a
 * write re-reads the store first: another session's marks and notes since
 * this one loaded are kept, not overwritten with a stale copy.
 */
async function mark($: $T, id: string, m: Mark | null, title = ''): Promise<void> {
  const stored = ((await $.store.get('marks')) as Marks | undefined) ?? {}
  const next = setMark(stored, id, m, Date.now())
  await $.store.set('marks', next)
  await update($, marksAtom, () => next)
  // the card leaves its section: it glows where it lands
  const ix = await readIndex($)
  lastPlace = placement(ix.sessions, next, Date.now())
  await glow($, [id])
  // said in words too: a card that stays put (the one under Here) shows no move
  const words: Record<Mark, string> = { good: 'good enough', done: 'done', parked: 'parked', working: 'working' }
  $.ui.toast(m ? `Marked ${words[m]}${title ? `: ${title}` : ''}` : `Back to automatic${title ? `: ${title}` : ''}`)
}

async function editNotes($: $T, id: string, fn: (list: Note[]) => Note[]): Promise<void> {
  const stored = ((await $.store.get('notes')) as Notes | undefined) ?? {}
  const list = fn(stored[id] ?? [])
  const next = { ...stored }
  if (list.length === 0) delete next[id]
  else next[id] = list
  await $.store.set('notes', next)
  await update($, notesAtom, () => next)
}

async function loadStored($: $T): Promise<void> {
  const marks = (await $.store.get('marks')) as Marks | undefined
  if (marks) await update($, marksAtom, () => marks)
  const notes = (await $.store.get('notes')) as Notes | undefined
  if (notes) await update($, notesAtom, () => notes)
  const answered = (await $.store.get('answered')) as Answered | undefined
  if (answered) await update($, answeredAtom, () => answered)
  const seen = (await $.store.get('seen')) as Record<string, number> | undefined
  if (seen) await update($, seenAtom, () => seen)
}

/**
 * Sends a note into its session. "prompt" = as the next message; "subsession"
 * = asks that session to start a linked side session for it, because that
 * session knows the topic and writes a better brief than the board can.
 */
async function sendNote($: $T, s: Sess, n: Note, how: 'prompt' | 'subsession'): Promise<void> {
  const message = how === 'prompt' ? n.text
    : `Start a linked side session for this (start_session, initiation "user_asked", context "fork"), `
      + `brief it from what you know here, then carry on with your own work:\n\n${n.text}`
  if (!(await deliver($, s.id, message))) return
  await editNotes($, s.id, list => list.map(x => (x.id === n.id ? { ...x, sent: how } : x)))
  $.ui.toast(how === 'prompt' ? `Sent to "${s.title}"` : `Asked "${s.title}" to start a subsession`)
}

/**
 * Puts a message into a session as the person's next turn. The board's own
 * session cannot message itself, so there it is submitted directly. False
 * (with a toast saying why) when it did not go.
 */
async function deliver($: $T, sessionId: string, message: string): Promise<boolean> {
  try {
    const res = await $.mcp.call('ccd_session_mgmt', 'send_message', { session_id: sessionId, message })
    const block = res.content.find(c => c.type === 'text') as { text: string } | undefined
    const result = block?.text ?? ''
    if (!res.isError) return true
    if (/current session/i.test(result)) {
      await $.prompt.submit({ text: message })
      return true
    }
    $.ui.toast(`Not sent: ${result.slice(0, 200)}`)
  } catch (err) {
    $.ui.toast(`Not sent: ${String(err).slice(0, 200)}`)
  }
  return false
}

/** One pick or note on a review page, kept until the answers are sent. */
async function setDraft($: $T, key: string, patch: { pick?: string; note?: string }): Promise<void> {
  await update($, draftsAtom, d => ({ ...d, [key]: { ...(d[key] ?? {}), ...patch } }))
}

/** For a page answered some way the board cannot see (in your own words, out loud). */
async function markAnswered($: $T, page: QPage): Promise<void> {
  const stored = ((await $.store.get('answered')) as Answered | undefined) ?? {}
  const next = { ...stored, [page.p]: { at: Date.now(), t: page.t, sig: pageSig(page) } }
  await $.store.set('answered', next)
  await update($, answeredAtom, () => next)
}

/** Sends a page's answers into the session that wrote it, and marks the page answered. */
async function sendAnswers($: $T, s: Sess, page: QPage): Promise<void> {
  const drafts = (await read($, draftsAtom)) ?? {}
  const { text, count } = composeAnswers(page, drafts)
  if (count === 0) {
    $.ui.toast('Pick an answer or write a note first.')
    return
  }
  if (!(await deliver($, s.id, text))) return
  const stored = ((await $.store.get('answered')) as Answered | undefined) ?? {}
  const next = { ...stored, [page.p]: { at: Date.now(), t: page.t, sig: pageSig(page) } }
  await $.store.set('answered', next)
  await update($, answeredAtom, () => next)
  await update($, draftsAtom, d => Object.fromEntries(Object.entries(d).filter(([k]) => !k.startsWith(`${page.p}#`))))
  $.ui.toast(`${count} answer${count > 1 ? 's' : ''} sent to "${s.title}"`)
}

/** Adds a todo from a quick-add line: `@label` and one date word are read out of it. */
async function addTodo($: $T, owner: string, line: string): Promise<void> {
  const now = Date.now()
  const { text, labels, due } = parseQuick(line, now)
  if (!text) return
  await editNotes($, owner, list => [...list, { id: `${now}`, text, at: now, labels, due }])
}

async function toggleDone($: $T, owner: string, id: string): Promise<void> {
  await editNotes($, owner, list => list.map(n => (n.id === id ? { ...n, done: !n.done } : n)))
}

/**
 * Turns an Inbox todo into a real session: a new linked session of the one
 * this board is drawn in, briefed with the todo. The todo stays, marked.
 */
async function startFromTodo($: $T, n: Note): Promise<void> {
  try {
    const res = await $.mcp.call('ccd_session', 'start_session', {
      initiation: 'user_asked',
      title: n.text.slice(0, 58),
      prompt: n.text,
      background: 'Started from a todo on the session board. The todo text is the whole brief so far; '
        + 'ask what is unclear before doing anything large.',
    })
    const block = res.content.find(c => c.type === 'text') as { text: string } | undefined
    if (res.isError) {
      $.ui.toast(`No session started: ${(block?.text ?? '').slice(0, 200)}`)
      return
    }
    const id = /local_[0-9a-f-]{36}/.exec(block?.text ?? '')?.[0]
    await editNotes($, INBOX, list => list.map(x => (x.id === n.id ? { ...x, sent: 'session', session: id } : x)))
    $.ui.toast(`Session started: ${n.text.slice(0, 60)}`)
  } catch (err) {
    $.ui.toast(`No session started: ${String(err).slice(0, 200)}`)
  }
}

/**
 * Opens a session through the app's own link. Windows hands the link to the
 * app, which takes a few seconds to switch, so the button says "opening…" at
 * once instead of looking dead.
 */
async function openSession($: $T, id: string): Promise<void> {
  await update($, openingAtom, () => id)
  $.clock.after(5_000, () => {
    background($, update($, openingAtom, o => (o === id ? '' : o)))
  })
  background($, markSeen($, id))
  // leaving for a session: the board you come back to shows everything again
  typedQuery = ''
  background($, update($, uiAtom, u => (u.query === '' && u.project === '' && u.label === '' ? u
    : { ...u, query: '', project: '', label: '', cleared: u.query === '' ? u.cleared : (u.cleared ?? 0) + 1 })))
  await $.process.run(['cmd', '/c', 'start', '', `claude://claude.ai/epitaxy/${id}`])
}

async function openFile($: $T, path: string): Promise<void> {
  await $.process.run(['explorer.exe', path])
}

async function reveal($: $T, path: string): Promise<void> {
  await $.process.run(['explorer.exe', `/select,${path}`])
}

// Only a session showing the board re-indexes on the timer: with the board
// installed everywhere, ten open sessions must not all index every 2 minutes.
// A module variable on purpose: a reload starts it false and the next draw
// sets it again.
let isShown = false

const background = ($: $T, work: Promise<unknown>) => {
  work.catch(err => $.ui.log(`session-board: ${String(err)}`, { to: 'debug' }))
}

// A board that opens at a session's start must not index on top of a fresh
// snapshot either: the first session indexes, the next ones read.
async function openFresh($: $T): Promise<void> {
  const stat = await $.fs.stat(`${$.plugin.root}/cache/snapshot.json`).catch(() => undefined)
  if (stat && Date.now() - stat.mtimeMs < 110_000) await loadSnapshot($, true)
  else await refresh($)
}

/** Your own short names and colours for project folders, if a projects.json is there. */
async function loadProjectNames($: $T): Promise<void> {
  try {
    setProjectNames(JSON.parse(await $.fs.read(`${$.plugin.root}/projects.json`)) as ProjectNames)
  } catch {
    setProjectNames({})
  }
}

async function openBoard($: $T): Promise<void> {
  await loadProjectNames($)
  await loadSnapshot($)
  // Closing the board in the app may only hide it: it stays open, and opening
  // an open pane changes nothing. A hidden one is closed and opened anew.
  const mine = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  if (mine && !mine.isShown) await $.ui.close({ id: PANE }).catch(() => undefined)
  const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  isShown = isPlaced
  background($, loadStored($))
  background($, openFresh($))
}

const KIND_MARK: Record<Media['k'], string> = { movie: '▶', image: '▣', page: '◧', file: '·' }

export const register: Register = on => {
  // Open by default in every session; /board and the button above the prompt
  // reopen it once closed.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'board', description: 'Open the session board' })
    $.clock.every(20_000, () => {
      background($, quickTick($))
    })
    $.clock.every(120_000, () => {
      background($, tick($))
    })
    // the quick part (snapshot, pane) is awaited; the indexing runs behind it.
    // A session the app resumes may start before its window attaches: opening
    // then fails ("no surface is attached"): quietly, session.attach opens it.
    await openBoard($).catch(err => {
      if (!String(err).includes('no-surface')) $.ui.log(`session-board: ${String(err)}`, { to: 'debug' })
    })
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (!isShown) background($, openBoard($))
    return attached
  })

  on('command.run', { command: 'board' }, async $ => {
    await openBoard($)
    return { text: 'Session board opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) isShown = false
    return next(e)
  })

  // The app's own top-right toolbar takes no plugin buttons (there is no API
  // for it); the band above the prompt is the nearest place. The button is
  // always there: the app can hide the board without telling the plugin.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="open-board" plain onPress={() => background($, openBoard($))}>▦ Sessions</Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Text, Button, Input, Link } = table
    // the terminal has no Svg; it keeps the word "indexing…" alone
    const Svg = 'Svg' in table ? table.Svg : undefined
    isShown = true
    const ix = await readIndex($)
    const ui = await read($, uiAtom)
    const marks = (await read($, marksAtom)) ?? {}
    const notes = (await read($, notesAtom)) ?? {}
    const moved = (await read($, movedAtom)) ?? {}
    const opening = (await read($, openingAtom)) ?? ''
    const answered = (await read($, answeredAtom)) ?? {}
    const seen = (await read($, seenAtom)) ?? {}
    // just asked for you (under half an hour) and not seen since: its card pulses, as the app's notification did
    // Just finished a turn that needs you (the app notifies on it) and not seen since: it pulses amber.
    // A subsession only when it asks YOU (blocked / ready for review): one that merely reported
    // back sends its report to its main session, which is where the attention goes.
    // Unseen: it finished a turn after you last looked at it -- in the app (its own
    // focus time, which a click on the Windows notification sets too) or on this
    // board. What the app's notification announced and you have not opened yet.
    // A subsession only when it asks you; a closed or parked one never.
    const isUnseen = (s: Sess) => !isWorking(s, now) && !s.archived && now - s.last < 7 * 86_400_000
      && Math.max(s.touched ?? 0, seen[s.id] ?? 0) < s.last
      && (isAsking(s) || !s.parent) && !['done', 'parked', 'good'].includes(stateOf(s, marks, now))
    const isFresh = (s: Sess) => isUnseen(s) && now - s.last < 30 * 60_000
      && (isAsking(s) || (!s.parent && stateOf(s, marks, now) === 'need'))
    // a subsession that finished a turn in the last half hour without asking you: it reported to its parent
    const hasReported = (s: Sess) => !!s.parent && !isWorking(s, now) && !isAsking(s) && now - s.last < 30 * 60_000
    // a subsession waiting on YOU (blocked / ready for review), not handed to its main session:
    // its own card in Needs you for as long as it waits, not only while fresh
    const asksYou = (s: Sess) => !!s.parent && isAsking(s) && !isWorking(s, now)
      && ['need', 'waiting'].includes(stateOf(s, marks, now))
    const drafts = (await read($, draftsAtom)) ?? {}
    const openPages = (s: Sess) => s.questions.filter(p => isOpenPage(p, answered, memo.chat.get(p.title)))
    const fullText = await read($, fullTextAtom)
    const now = Date.now()

    const setUi = (fn: (u: Ui) => Ui) => background($, update($, uiAtom, u => fn(u)))
    const all = ix.sessions
    const byId = new Map(all.map(s => [s.id, s]))

    // the watched session: the one this board is drawn in
    // The per-index work is done once per index, not on every drawing: a
    // drawing that takes long is what shows as a blink when sessions switch.
    if (memo.at !== ix.at || memo.count !== all.length) {
      memo = { at: ix.at, count: all.length, find: relatedFinder(all), near: new Map(), chat: chatAnswers(all) }
    }
    selfCli ??= await $.session.id()
    const here = all.find(s => s.cli === selfCli)
    if (here && !memo.near.has(here.id)) memo.near.set(here.id, new Map(memo.find(here, 15).map(r => [r.s.id, r.score])))
    const nearness = here ? memo.near.get(here.id)! : new Map<string, number>()
    const borderOf = (s: Sess) => {
      const g = moved[s.id] ?? 0
      if (g > 0) return GLOW[g]
      if (here && s.id === here.id) return HERE
      const score = nearness.get(s.id) ?? 0
      return RELATED_BORDER.find(([min]) => score >= min)?.[1] ?? BORDER
    }
    // one-off scratch folders (scratch-2026-10-21-4d8001) share one "scratch" chip;
    // each still shows its own folder name on its card and is found by search
    const chipOf = (p: string) => (p.startsWith('scratch-') ? 'scratch' : p)
    const inChip = (s: Sess | undefined) => !ui.project || (!!s && chipOf(s.project) === ui.project)
    const inProject = ui.project ? all.filter(inChip) : all
    const st = (s: Sess) => stateOf(s, marks, now)
    const groups: Record<State, Sess[]> = { need: [], waiting: [], working: [], today: [], week: [], earlier: [], good: [], done: [], parked: [] }
    // the watched session has its own place under Here, so it is not listed twice
    for (const s of [...inProject].sort(byRecent)) if (!here || s.id !== here.id) groups[st(s)].push(s)
    // a subsession whose parent is in the same list shows nested under it: the
    // header counts what a section actually lists, as the sections do
    // A subsession whose parent is in the same list shows nested under it, not
    // twice: except one that just asked for you, which gets its own card on
    // top (a notification about it must not point at a row hidden in an older
    // parent). The rest sort by their family's newest move, so a parent whose
    // child just moved comes up with it.
    // On the board (no search) a subsession that only reports is never listed on
    // its own: it is a row on its main session's rail, wherever that is listed.
    const topLevel = (items: Sess[]) => {
      const ids = new Set(items.map(s => s.id))
      // kidsOf is newest first: the family's newest move is its first child's
      const at = (s: Sess) => Math.max(s.last, kidsOf.get(s.id)?.[0]?.last ?? 0)
      // opening a card marks it seen, which ends its "fresh" place: the card you
      // just opened keeps that place while it is open, or it would vanish under the click
      // A subsession whose main session is listed here (or is the Here card) is
      // drawn on that card's rail, an asking one as a small card of its own: the
      // family reads as one block. One whose main session is elsewhere gets its
      // own card when it asks you, and is a rail row there otherwise.
      const onTop = (s: Sess) => isFresh(s) || asksYou(s) || (keptOnTop.has(s.id) && ui.open === s.id)
      const familyAsks = (s: Sess) => (kidsOf.get(s.id) ?? []).some(asksYou)
      const listedParent = (s: Sess) => !!s.parent && (ids.has(s.parent) || (!!here && s.parent === here.id))
      const nested = (s: Sess) => !!s.parent && (ids.has(s.parent) || (!ui.query && byId.has(s.parent)))
      return items
        .filter(s => !nested(s) || (onTop(s) && !listedParent(s)))
        .sort((a, b) => Number(onTop(b) || familyAsks(b)) - Number(onTop(a) || familyAsks(a)) || at(b) - at(a))
    }

    // chips: every project with something this week, busiest first (a new project
    // must show from its first session; the row wraps)
    const weekCount: Record<string, number> = {}
    for (const s of all) if (now - s.last < 7 * 86_400_000) weekCount[chipOf(s.project)] = (weekCount[chipOf(s.project)] ?? 0) + 1
    const chips = Object.entries(weekCount).sort((a, b) => b[1] - a[1]).map(([p]) => p)

    const stateWord: Record<State, string> = {
      need: 'needs you', waiting: 'still waiting', working: 'working', today: 'today', week: 'earlier this week',
      earlier: 'earlier', good: 'good enough', done: 'done', parked: 'parked',
    }

    const mediaRow = (s: Sess, m: Media, withSession: boolean) => (
      <Box key={`m-${s.id}-${m.p}`} flexDirection="row" gap={1}>
        <Button key={`mo-${s.id}-${m.p}`} plain onPress={() => background($, openFile($, m.p))}>
          {KIND_MARK[m.k]} {baseName(m.p)}
        </Button>
        <Text dimColor>{ago(now - m.t)}{withSession ? ` · ${s.title}` : ''}</Text>
        <Button key={`mf-${s.id}-${m.p}`} plain onPress={() => background($, reveal($, m.p))}>
          <Text dimColor>folder</Text>
        </Button>
      </Box>
    )

    // One todo: tick box, text, @labels and its due day, then what it can
    // become. `owner` is its session's id, or INBOX; `s` the session, if any.
    const todoRow = (owner: string, n: Note, s: Sess | undefined, withSession: boolean) => {
      const bucket = dueBucket(n.due, now)
      const isLate = !n.done && (bucket === 'overdue' || bucket === 'today')
      return (
        <Box key={`n-${n.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Button key={`nd-${n.id}`} plain onPress={() => background($, toggleDone($, owner, n.id))}>
              <Text dimColor={n.done}>{n.done ? '☑' : '☐'}</Text>
            </Button>
            <Box flexShrink={1}>
              <Text dimColor={n.done || n.sent !== undefined} strikethrough={n.done}>
                {n.text}
                {(n.labels ?? []).map(l => <Text key={`nl-${n.id}-${l}`} dimColor> @{l}</Text>)}
                {n.due && <Text color={isLate ? ACCENT : undefined} dimColor={!isLate}>  {dueWord(n.due, now)}</Text>}
                {n.sent && <Text dimColor>  (sent as {n.sent})</Text>}
              </Text>
            </Box>
          </Box>
          {!n.done && (
            <Box flexDirection="row" gap={1} marginLeft={2}>
              {withSession && s && (
                <Button key={`ng-${n.id}`} plain onPress={() => setUi(u => ({ ...u, view: 'focus', focus: s.id, open: '', tab: 'notes' }))}>
                  <Text color={projectColor(s.project)}>● </Text><Text dimColor>{s.title}</Text>
                </Button>
              )}
              {s && (
                <Button key={`np-${n.id}`} plain onPress={() => background($, sendNote($, s, n, 'prompt'))}>
                  <Text dimColor>→ prompt</Text>
                </Button>
              )}
              {s && (
                <Button key={`ns-${n.id}`} plain onPress={() => background($, sendNote($, s, n, 'subsession'))}>
                  <Text dimColor>→ subsession</Text>
                </Button>
              )}
              {!s && owner === INBOX && !n.session && (
                <Button key={`nn-${n.id}`} plain onPress={() => background($, startFromTodo($, n))}>
                  <Text dimColor>→ new session</Text>
                </Button>
              )}
              <Button key={`nx-${n.id}`} plain onPress={() => background($, editNotes($, owner, l => l.filter(x => x.id !== n.id)))}>
                <Text dimColor>remove</Text>
              </Button>
            </Box>
          )}
        </Box>
      )
    }

    // A review page's questions, answered here: each option is a button (★ =
    // the session's own pick), a note per question, free text at the end, and
    // Send puts it all into the session in the page's own answer format. The
    // newest open page shows in full; answered ones fold to a line each.
    const questionsBlock = (s: Sess, path: string) => {
      const open = openPages(s).sort((a, b) => b.t - a.t)
      const done = s.questions.filter(p => !isOpenPage(p, answered, memo.chat.get(p.title))).sort((a, b) => b.t - a.t)
      const page = open[0]
      return (
        <Box flexDirection="column">
          {page && (() => {
            const pi = s.questions.indexOf(page)
            const { count } = composeAnswers(page, drafts)
            return (
              <Box key={`qp-${path}-${pi}`} flexDirection="column">
                <Box flexDirection="row" gap={1}>
                  <Box flexShrink={1}><Text bold>{page.title}</Text></Box>
                  <Button key={`qpo-${path}-${pi}`} plain onPress={() => background($, openFile($, page.p))}>
                    <Text dimColor>open page ↗</Text>
                  </Button>
                  <Button key={`qpm-${path}-${pi}`} plain onPress={() => background($, markAnswered($, page))}>
                    <Text dimColor>✓ mark answered</Text>
                  </Button>
                </Box>
                {page.qs.map(q => {
                  const key = `${page.p}#${q.q}`
                  const d = drafts[key] ?? {}
                  return (
                    <Box key={`qq-${path}-${pi}-${q.q}`} flexDirection="column" marginTop={1}>
                      <Text>{q.title}{q.to !== 'me' ? <Text dimColor>  [for {q.to}]</Text> : null}</Text>
                      {/* the options side by side under their question: one click answers */}
                      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                      {q.opts.map((o, oi) => (
                        <Button key={`qo-${path}-${pi}-${q.q}-${oi}`} plain
                          onPress={() => background($, setDraft($, key, { pick: d.pick === o.value ? '' : o.value }))}>
                          <Text color={d.pick === o.value ? ACCENT : undefined} dimColor={d.pick !== o.value}>
                            {d.pick === o.value ? '◉ ' : '○ '}{o.label}
                          </Text>
                          {o.rec && <Text color={DOT.good}> ★</Text>}
                        </Button>
                      ))}
                      </Box>
                      {q.notes && (
                        <Input key={`qn-${path}-${pi}-${q.q}`} placeholder="note" value={d.note ?? ''}
                          onInput={v => background($, setDraft($, key, { note: v }))}
                          onSubmit={v => background($, setDraft($, key, { note: v }))} />
                      )}
                    </Box>
                  )
                })}
                <Box marginTop={1} flexDirection="column">
                  <Input key={`qg-${path}-${pi}`} placeholder="Anything else? (screenshots: paste them on the page)"
                    value={drafts[`${page.p}#general`]?.note ?? ''}
                    onInput={v => background($, setDraft($, `${page.p}#general`, { note: v }))}
                    onSubmit={v => background($, setDraft($, `${page.p}#general`, { note: v }))} />
                </Box>
                <Box marginTop={1}>
                  <Button key={`qs-${path}-${pi}`} variant="primary"
                    label={count ? `Send ${count} answer${count > 1 ? 's' : ''} to this session` : 'Send answers'}
                    onPress={() => background($, sendAnswers($, s, page))} />
                </Box>
                {open.length > 1 && <Text dimColor>{open.length - 1} older question page{open.length > 2 ? 's' : ''} wait after this one.</Text>}
              </Box>
            )
          })()}
          {done.slice(0, 3).map(p => (
            <Box key={`qd-${path}-${s.questions.indexOf(p)}`} flexDirection="row" gap={1}>
              <Text dimColor>✓ {p.title} · answered {ago(now - (answered[p.p]?.at ?? memo.chat.get(p.title) ?? now))} ago</Text>
              <Button key={`qdo-${path}-${s.questions.indexOf(p)}`} plain onPress={() => background($, openFile($, p.p))}>
                <Text dimColor>open page ↗</Text>
              </Button>
            </Box>
          ))}
        </Box>
      )
    }

    const noteBlock = (s: Sess) => {
      const list = notes[s.id] ?? []
      return (
        <Box flexDirection="column">
          {list.filter(n => !n.done).map(n => todoRow(s.id, n, s, false))}
          {list.filter(n => n.done).map(n => todoRow(s.id, n, s, false))}
          <Input
            key={`na-${s.id}`}
            placeholder="Add a todo…  @label  today / fri / 3d"
            submitLabel="Add"
            onSubmit={v => background($, addTodo($, s.id, v))}
          />
        </Box>
      )
    }

    // children by parent, newest first: drawn as live rows under their parent's card
    const kidsOf = new Map<string, Sess[]>()
    for (const o of [...all].sort(byRecent)) {
      if (o.parent && byId.has(o.parent)) kidsOf.set(o.parent, [...(kidsOf.get(o.parent) ?? []), o])
    }

    // A session's subsessions as compact live rows under its card: state dot,
    // title, state and age. A row opens into the child's own card in place.
    // `path` names this instance (a session may show at the top of one
    // section and nested under its parent too), so opening one opens only it.
    // Parked and done subsessions fold into one "· N parked" line; one that asks
    // you is drawn as a small card of its own right on the rail (its question, its
    // needs line), so a family reads as one block.
    const children = (s: Sess, depth: number, path: string) => {
      const kids = kidsOf.get(s.id) ?? []
      if (kids.length === 0 || depth >= 3) return null
      const allShown = ui.shown[`kids-${path}`]
      const isQuiet = (c: Sess) => ['parked', 'done'].includes(st(c)) && !isWorking(c, now)
      const lively = kids.filter(c => !isQuiet(c))
      const asking = lively.filter(asksYou)
      const rest = lively.filter(c => !asksYou(c))
      const visible = allShown ? [...asking, ...rest, ...kids.filter(isQuiet)] : [...asking, ...rest.slice(0, 4)]
      const folded = kids.length - visible.length
      const quietCount = kids.filter(isQuiet).length
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          {visible.map((c, i) => {
            const cPath = `${path}>${c.id}`
            const isLast = i === visible.length - 1 && folded === 0
            if (ui.open === cPath || asksYou(c)) {
              return (
                // indented, no connector (beside a card it floated mid-height); it may
                // shrink, so a long needs line is cut with "…" and never pushes past the edge
                <Box key={`kb-${cPath}`} flexDirection="column" flexShrink={1} minWidth={0} overflow="hidden" marginLeft={1}>
                  {card(c, true, depth + 1, cPath)}
                </Box>
              )
            }
            const cs = st(c)
            const grand = (kidsOf.get(c.id) ?? []).length
            // the rail says how each subsession relates to you: working, asks you
            // (its own card is up in Needs you), reported to this session, or quiet
            const working = isWorking(c, now)
            const asks = !working && asksYou(c)
            const reported = !working && !asks && hasReported(c)
            const quiet = reported || cs === 'done' || cs === 'parked'
            // "needs you" on a subsession you only touched today read as an ask: it is not one
            const word = working ? 'working' : asks ? 'asks you' : reported ? 'reported'
              : cs === 'need' ? 'touched today' : stateWord[cs]
            return (
              <Box key={`kr-${cPath}`} flexDirection="row" alignItems="center">
                <Text dimColor>{isLast ? '└ ' : '├ '}</Text>
                {/* drawn beside the button: a button holds only text */}
                {working && Svg
                  ? <Svg source={PULSE_WORKING} alt="working now" width={10} height={10} isInteractive />
                  : isFresh(c) && Svg
                    ? <Svg source={PULSE} alt="just asked for you" width={10} height={10} isInteractive />
                    : reported
                      ? <Text dimColor>↩</Text>
                      : <Text color={isUnseen(c) ? READY : DOT[cs]}>●</Text>}
                <Button key={`k-${cPath}`} plain onPress={() => setUi(u => ({ ...u, open: cPath, tab: '' }))}>
                  <Text dimColor={quiet}> {c.title}</Text>
                  <Text dimColor={!asks} color={asks ? ACCENT : undefined}> {word} · {ago(now - c.last)}{grand ? ` · +${grand}` : ''}</Text>
                </Button>
              </Box>
            )
          })}
          {/* on a nested card, parked-only subsessions are not worth a line */}
          {folded > 0 && !(depth > 0 && folded === quietCount) && (
            <Button key={`km-${path}`} plain onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, [`kids-${path}`]: true } }))}>
              <Text dimColor>└ {folded === quietCount ? `${quietCount} parked or done` : `${folded} more subsessions${quietCount ? ` (${quietCount} parked or done)` : ''}`}</Text>
            </Button>
          )}
        </Box>
      )
    }

    // A button takes clicks only on its own box. Tried and dropped: padding the
    // lines out (wrapped them in the desktop's proportional font) and a blank
    // button laid under the card (the desktop paints an absolute box above the
    // rest whatever the order: it swallowed the answers and Open), and one button
    // for all three lines (the desktop ignores line breaks in a button: they ran
    // into one line and pushed the corner off). So each line is its own button.

    const card = (s: Sess, withState = false, depth = 0, path = s.id) => {
      const state = st(s)
      const isOpen = ui.open === path || (depth === 0 && ui.view === 'focus' && ui.focus === s.id)
      const waits = state === 'need' || state === 'waiting'
      const meta = [waits ? `waiting ${ago(now - s.last)}` : ago(now - s.last)]
      if (withState) meta.unshift(stateWord[state])
      // only what matters now: file, media and page counts are on the card's tabs
      const asks = openPages(s)
      const askCount = asks.reduce((sum, p) => sum + p.qs.length, 0)
      // the count of open questions is drawn ahead of the meta in the accent: a scan finds them
      const openTodos = (notes[s.id] ?? []).filter(n => !n.done && !n.sent)
      if (openTodos.length) {
        const dueNow = openTodos.filter(n => ['overdue', 'today'].includes(dueBucket(n.due, now))).length
        meta.push(`${openTodos.length} todo${openTodos.length > 1 ? 's' : ''}${dueNow ? ` (${dueNow} due)` : ''}`)
      }
      // what its subsessions are doing, said on the parent too
      const kidsNow = kidsOf.get(s.id) ?? []
      const kidsWorking = kidsNow.filter(c => isWorking(c, now)).length
      const kidsAsking = kidsNow.filter(asksYou).length
      const kidsReported = kidsNow.filter(hasReported).length
      // reports land here: read them in this session, not in the subsessions
      if (kidsReported) meta.push(`↩ ${kidsReported} report${kidsReported > 1 ? 's' : ''} in`)
      if (kidsWorking) meta.push(`${kidsWorking} sub working`)
      if (kidsAsking) meta.push(`${kidsAsking} sub asks you`)
      // a subsession's way up: a button to its parent's card, drawn under the meta line
      const parent = s.parent && depth === 0 ? byId.get(s.parent) : undefined
      const clash = isOpen ? overlaps(s, all, marks, now) : []
      const rel = isOpen ? memo.find(s, 5) : []
      const allNotes = notes[s.id] ?? []
      // one detail tab at a time, five items at most: the open card stays short
      const tabs: { key: Ui['tab']; label: string }[] = []
      if (s.questions.length) tabs.push({ key: 'questions', label: askCount ? `? Questions ${askCount}` : 'Questions ✓' })
      if (s.media.length + s.artifacts.length) tabs.push({ key: 'media', label: `Media ${s.media.length + s.artifacts.length}` })
      if (s.fileCount) tabs.push({ key: 'files', label: `Files ${s.fileCount}` })
      if (rel.length) tabs.push({ key: 'related', label: `Related ${rel.length}${clash.length ? ' ⚠' : ''}` })
      const openCount = allNotes.filter(n => !n.done).length
      tabs.push({ key: 'notes', label: allNotes.length ? `Todos ${openCount}` : '+ Todo' })
      // a card with open questions unfolds onto them: answering is what it waits for
      const tab = !isOpen ? '' : ui.tab === '' ? (askCount ? 'questions' : '') : ui.tab
      const toggleTab = (k: Ui['tab']) => setUi(u => ({ ...u, tab: tab === k ? 'none' : k }))
      const toggleCard = () => {
        const isOpening = ui.open !== path
        if (isOpening && isFresh(s)) keptOnTop.add(s.id)
        else keptOnTop.delete(s.id)
        setUi(u => ({ ...u, open: u.open === path ? '' : path, tab: '' }))
        if (isUnseen(s)) background($, markSeen($, s.id))
      }
      const unseen = isUnseen(s)
      const showNeeds = (isOpen || state === 'need') && s.needs !== ''
      // one dot, a traffic light: brown pulse working, green pulse done and not seen, then still
      const dots = [
        isWorking(s, now)
          ? (Svg
            ? <Svg key={`dw-${path}`} source={PULSE_WORKING} alt="working now" width={12} height={12} isInteractive />
            : <Text key={`dw-${path}`} color={WORKING}>●</Text>)
          : isFresh(s)
            ? (Svg
              ? <Svg key={`df-${path}`} source={PULSE} alt="just asked for you" width={12} height={12} isInteractive />
              : <Text key={`df-${path}`} color={READY}>●</Text>)
            : <Text key={`ds-${path}`} color={unseen ? READY : DOT[state]}>●</Text>,
      ]
      const corner = (
        <Box flexDirection="row" gap={1} flexShrink={0}>
          <Text wrap="truncate-end">
            {here && s.id === here.id && <Text color={HERE}>◉ here  </Text>}
            {/* a nested card in its main session's project says nothing new with the tag */}
            {!(depth > 0 && s.parent && byId.get(s.parent)?.project === s.project)
              && <Text color={projectColor(s.project)}>● {projectLabel(s.project)}</Text>}
          </Text>
          {/* one click to the session itself; the title only unfolds the card */}
          {!(here && s.id === here.id) && (
            <Button key={`go-${path}`} plain onPress={() => background($, openSession($, s.id))}>
              {opening === s.id ? <Text color={ACCENT}>opening…</Text> : <Text dimColor>open ↗</Text>}
            </Button>
          )}
        </Box>
      )
      // A Client region per card took clicks anywhere, but measured 2x slower
      // at 660 sessions and pushed "open" off the edge; it was removed.
      return (
        <Box key={`c-${path}`} flexDirection="column" borderStyle="round" borderColor={borderOf(s)} paddingX={1} marginBottom={depth === 0 ? 1 : 0} minWidth={0}>
          {/* a subsession's main session, above its title: "Parent ›", one click up */}
          {parent && (
            <Box flexDirection="row" gap={1}>
              {/* one "open ↗" per card, the card's own: the parent is one click up from here */}
              <Button key={`up-${path}`} plain onPress={() => setUi(u => ({ ...u, view: 'focus', focus: parent.id, open: '', tab: '' }))}>
                <Text dimColor>{parent.title} ›</Text>
              </Button>
            </Box>
          )}
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexDirection="row" gap={1} flexShrink={1} alignItems="center">
              {dots}
              <Button key={`t-${path}`} plain onPress={toggleCard}>
                <Text bold>{s.title}</Text>
              </Button>
            </Box>
            {corner}
          </Box>
          <Button key={`tm-${path}`} plain onPress={toggleCard}>
            {unseen && <Text color={READY}>unseen · </Text>}
            {askCount > 0 && <Text color={ACCENT}>? {askCount}</Text>}
            <Text dimColor>{askCount ? ` question${askCount > 1 ? 's' : ''} · ` : ''}{meta.join(' · ')}</Text>
          </Button>
          {showNeeds && (
            <Button key={`tn-${path}`} plain onPress={toggleCard}>
              <Text color={ACCENT}>→ {s.needs}</Text>
            </Button>
          )}
          {children(s, depth, path)}
          {isOpen && (
            <Box flexDirection="column" marginTop={1}>
              {s.detail !== '' && <Text>{s.detail}</Text>}

              <Box flexDirection="row" flexWrap="wrap" gap={2} marginTop={1}>
                {tabs.map(t => (
                  <Button key={`tab-${path}-${t.key}`} plain onPress={() => toggleTab(t.key)}>
                    <Text dimColor={tab !== t.key} underline={tab === t.key}>{t.label}</Text>
                  </Button>
                ))}
              </Box>

              {tab === 'questions' && questionsBlock(s, path)}
              {tab === 'media' && (
                <Box flexDirection="column">
                  {s.artifacts.slice(0, 2).map(a => (
                    <Link key={`a-${path}-${a.url}`} href={a.url} label={`◧ ${a.title}`} />
                  ))}
                  {s.media.slice(0, 5).map(m => mediaRow(s, m, false))}
                  {s.media.length > 5 && <Text dimColor>+{s.media.length - 5} more in the Media view</Text>}
                </Box>
              )}
              {tab === 'files' && (
                <Box flexDirection="column">
                  {s.files.slice(0, 5).map(f => (
                    <Button key={`f-${path}-${f}`} plain onPress={() => background($, reveal($, f))}>
                      <Text mono dimColor>{baseName(f)}</Text>
                    </Button>
                  ))}
                  {s.fileCount > 5 && <Text dimColor>+{s.fileCount - 5} more</Text>}
                  {s.commits.length > 0 && <Text dimColor>commits {s.commits.slice(-3).join(' ')}</Text>}
                </Box>
              )}
              {tab === 'related' && (
                <Box flexDirection="column">
                  {clash.length > 0 && <Text color={ACCENT}>⚠ also editing the same files: {clash[0].title}</Text>}
                  {rel.map(r => (
                    <Button key={`r-${path}-${r.s.id}`} plain onPress={() => setUi(u => ({ ...u, view: 'focus', focus: r.s.id, open: '', tab: '' }))}>
                      <Text color={projectColor(r.s.project)}>●</Text> {r.s.title}
                    </Button>
                  ))}
                </Box>
              )}
              {tab === 'notes' && noteBlock(s)}
              {s.transcript === '' && <Text dimColor>no transcript found, so files and media were never read</Text>}

              <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
                {/* this session's own card has nowhere to open to */}
                {!(here && s.id === here.id) && (
                  <Button key={`o-${path}`} label="Open" onPress={() => background($, openSession($, s.id))} />
                )}
                {/* the state set by hand is the highlighted one; pressing it again goes back to automatic */}
                {([['g', 'good', 'Good enough'], ['d', 'done', 'Done'], ['p', 'parked', 'Park'], ['w', 'working', 'Working']] as const).map(([k, m, label]) => (
                  <Button key={`${k}-${path}`} variant={marks[s.id]?.mark === m ? 'primary' : 'secondary'}
                    label={marks[s.id]?.mark === m ? `✓ ${label}` : label}
                    onPress={() => background($, mark($, s.id, marks[s.id]?.mark === m ? null : m, s.title))} />
                ))}
                {marks[s.id] && <Button key={`x-${path}`} label="Auto" onPress={() => background($, mark($, s.id, null, s.title))} />}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    // One quiet line for a session you need not act on (working, moved today,
    // earlier): its state dot, its title, project and age. A click unfolds it
    // into its full card in place. Cards stay for what waits on you.
    const row = (s: Sess) => {
      if (ui.open === s.id) return card(s, true)
      const cs = st(s)
      const kidList = kidsOf.get(s.id) ?? []
      const kids = kidList.length
      const reports = kidList.filter(hasReported).length
      const unfold = () => setUi(u => ({ ...u, open: s.id, tab: '' }))
      // the family's activity: a working subsession makes its main row pulse too
      return (
        <Box key={`row-${s.id}`} flexDirection="row" gap={1} alignItems="center">
          {(isWorking(s, now) || kidList.some(c => isWorking(c, now))) && Svg
            ? <Svg source={PULSE_WORKING} alt="working now" width={10} height={10} isInteractive />
            : isFresh(s) && Svg
              ? <Svg source={PULSE} alt="just asked for you" width={10} height={10} isInteractive />
              : <Text color={isUnseen(s) ? READY : DOT[cs]}>●</Text>}
          <Box flexGrow={1} flexShrink={1}>
            <Button key={`t-${s.id}`} plain onPress={unfold}>
              <Text bold={isUnseen(s)}>{s.title}</Text>
              {kids > 0 && <Text dimColor>  +{kids}{reports ? ` ↩${reports}` : ''}</Text>}
            </Button>
          </Box>
          <Text color={projectColor(s.project)}>{projectLabel(s.project)}</Text>
          <Text dimColor>{ago(now - s.last)}</Text>
          {/* quick marks without unfolding: done, park (undo: the card's Auto button) */}
          <Button key={`rd-${s.id}`} plain dimColor onPress={() => background($, mark($, s.id, 'done', s.title))}>✓</Button>
          <Button key={`rp-${s.id}`} plain dimColor onPress={() => background($, mark($, s.id, 'parked', s.title))}>⏸</Button>
          <Button key={`go-${s.id}`} plain onPress={() => background($, openSession($, s.id))}>
            {opening === s.id ? <Text color={ACCENT}>opening…</Text> : <Text dimColor>↗</Text>}
          </Button>
        </Box>
      )
    }

    const section = (key: string, title: string, items: Sess[], color?: string, withState = false, asRows = false) => {
      // a subsession whose parent is in this same list shows nested under it, not twice
      const list = topLevel(items)
      if (list.length === 0) return null
      const limit = ui.limits[key] ?? (asRows ? 8 : SHOWN)
      return (
        <Box key={`s-${key}`} flexDirection="column" marginBottom={1}>
          {/* the label in small capitals; a quoted search query keeps its own case */}
          <Text bold={color !== undefined} color={color} dimColor={color === undefined}>
            {title.replace(/^[^"]*/, m => m.toUpperCase())} · {list.length}
          </Text>
          {/* quiet sessions: one soft card per section holding a line each (an
              unfolded one opens as its own card in place) */}
          {asRows
            ? (
              <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
                {list.slice(0, limit).map(s => row(s))}
                {list.length > limit && (
                  <Button key={`more-${key}`} plain onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, [key]: limit + 10 } }))}>
                    <Text dimColor>show {Math.min(10, list.length - limit)} more of {list.length - limit}</Text>
                  </Button>
                )}
              </Box>
            )
            : list.slice(0, limit).map(s => card(s, withState))}
          {!asRows && list.length > limit && (
            <Button key={`more-${key}`} plain onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, [key]: limit + 10 } }))}>
              <Text dimColor>show {Math.min(10, list.length - limit)} more of {list.length - limit}</Text>
            </Button>
          )}
        </Box>
      )
    }

    const folded = (key: string, title: string, list: Sess[], asRows = true) => {
      if (list.length === 0) return null
      if (ui.shown[key]) return section(key, title, list, undefined, false, asRows)
      return (
        <Button key={`show-${key}`} plain onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, [key]: true } }))}>
          <Text dimColor>{title} · {list.length} ›</Text>
        </Button>
      )
    }

    const boardView = () => (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>{ix.isLoading ? 'Reading your sessions…' : ix.note}</Text>}
        {here && (
          <Box key="s-here" flexDirection="column" marginBottom={1}>
            <Text dimColor>HERE</Text>
            {card(here, true, 0, `@${here.id}`)}
          </Box>
        )}
        {/* cards where you act; one quiet line each for the rest */}
        {section('need', 'Needs you', groups.need, ACCENT)}
        {folded('waiting', 'Still waiting on you, 1-7 days', groups.waiting, false)}
        {section('working', 'Working', groups.working, undefined, false, true)}
        {section('today', 'Today, not touched by you yet', groups.today, undefined, false, true)}
        {section('week', 'Earlier this week', groups.week, undefined, false, true)}
        {folded('good', 'Good enough', groups.good, false)}
        {folded('earlier', 'Earlier this month', groups.earlier)}
        {folded('done', 'Done', groups.done)}
        {folded('parked', 'Parking lot', groups.parked)}
      </Box>
    )

    const mediaView = () => {
      type Row = { s: Sess; m?: Media; a?: { url: string; title: string; t: number }; t: number }
      const rows: Row[] = []
      for (const s of inProject) {
        for (const m of s.media) if (!ui.query || matches(s, ui.query) || m.p.toLowerCase().includes(ui.query.toLowerCase())) rows.push({ s, m, t: m.t })
        for (const a of s.artifacts) rows.push({ s, a, t: a.t })
      }
      rows.sort((x, y) => y.t - x.t)
      const limit = ui.limits.media ?? 25
      return (
        <Box flexDirection="column">
          <Text bold>Made by your sessions, newest first ({rows.length})</Text>
          {rows.slice(0, limit).map(r => (r.m
            ? mediaRow(r.s, r.m, true)
            : <Link key={`ma-${r.s.id}-${r.a!.url}`} href={r.a!.url} label={`◧ ${r.a!.title} · ${ago(now - r.t)} · ${r.s.title}`} />))}
          {rows.length > limit && (
            <Button key="more-media" plain onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, media: limit + 25 } }))}>
              <Text dimColor>show 25 more of {rows.length - limit}</Text>
            </Button>
          )}
        </Box>
      )
    }

    // Every open todo, the Todoist way: Overdue / Today / Upcoming / No date,
    // label chips to filter, the Inbox's quick add on top. Done ones fold away.
    type Row = { owner: string; n: Note; s?: Sess }
    const allTodos: Row[] = Object.entries(notes).flatMap(([owner, list]) =>
      list.map(n => ({ owner, n, s: owner === INBOX ? undefined : byId.get(owner) })))
    const labelsInUse = [...new Set(allTodos.filter(r => !r.n.done).flatMap(r => r.n.labels ?? []))].sort()
    const dueToday = allTodos.filter(r => !r.n.done && ['overdue', 'today'].includes(dueBucket(r.n.due, now))).length
    // sessions with unanswered question pages written in the last two weeks (older ones are history)
    const asking = all.filter(s => openPages(s).some(p => now - p.t < 14 * 86_400_000)).length
    // finished since you last looked (the app's notifications you have not opened)
    const unseenCount = inProject.filter(s => (!here || s.id !== here.id) && isUnseen(s)).length

    const todosView = () => {
      const shown = allTodos.filter(r =>
        (!ui.label || (r.n.labels ?? []).includes(ui.label))
        && (!ui.project || r.owner === INBOX || inChip(r.s)))
      const open = shown.filter(r => !r.n.done)
      const done = shown.filter(r => r.n.done)
      const byDue = (a: Row, b: Row) => (a.n.due ?? '9999').localeCompare(b.n.due ?? '9999') || a.n.at - b.n.at
      const group = (key: string, title: string, rows: Row[], color?: string) => rows.length === 0 ? null : (
        <Box key={`tg-${key}`} flexDirection="column" marginBottom={1}>
          <Text bold color={color}>{title} ({rows.length})</Text>
          {rows.sort(byDue).map(r => todoRow(r.owner, r.n, r.s, true))}
        </Box>
      )
      return (
        <Box flexDirection="column">
          <Input
            key="todo-add"
            placeholder="Inbox: add a todo…  @label  today / fri / 3d"
            submitLabel="Add"
            onSubmit={v => background($, addTodo($, INBOX, v))}
          />
          {labelsInUse.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" gap={1} marginY={1}>
              <Button key="l-all" variant={ui.label === '' ? 'primary' : 'secondary'} label="All labels"
                onPress={() => setUi(u => ({ ...u, label: '' }))} />
              {labelsInUse.map(l => (
                <Button key={`l-${l}`} variant={ui.label === l ? 'primary' : 'secondary'} label={`@${l}`}
                  onPress={() => setUi(u => ({ ...u, label: u.label === l ? '' : l }))} />
              ))}
            </Box>
          )}
          {open.length === 0 && <Text dimColor>No open todos{ui.label ? ` with @${ui.label}` : ''}. Add one above, or on any session's card.</Text>}
          {group('overdue', 'Overdue', open.filter(r => dueBucket(r.n.due, now) === 'overdue'), ACCENT)}
          {group('today', 'Today', open.filter(r => dueBucket(r.n.due, now) === 'today'), ACCENT)}
          {group('upcoming', 'Upcoming', open.filter(r => dueBucket(r.n.due, now) === 'upcoming'))}
          {group('none', 'No date', open.filter(r => dueBucket(r.n.due, now) === 'none'))}
          {done.length > 0 && (ui.shown.todosDone
            ? group('done', 'Done', done)
            : (
              <Button key="show-todos-done" plain onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, todosDone: true } }))}>
                <Text dimColor>Done ({done.length}) · show</Text>
              </Button>
            ))}
        </Box>
      )
    }

    const focusView = () => {
      const s = byId.get(ui.focus)
      if (!s) return <Text dimColor>That session is not in the index.</Text>
      return (
        <Box flexDirection="column">
          <Button key="back" plain onPress={() => setUi(u => ({ ...u, view: 'board', focus: '' }))}>
            <Text dimColor>← back to the board</Text>
          </Button>
          {card(s, true)}
        </Box>
      )
    }

    const found = ui.query && ui.view === 'board' ? inProject.filter(s => matches(s, ui.query)).sort(byRecent) : []

    // what was said in conversations: only once the search was run for this query
    const byCli = new Map(all.map(s => [s.cli, s]))
    const foundIds = new Set(found.map(s => s.id))
    const said = fullText.query === ui.query.trim()
      // never name a variable `h` in this file: JSX compiles to calls of the global `h`
      ? fullText.hits.map(hit => ({ hit, s: byCli.get(hit.cli) })).filter(x => x.s && inChip(x.s))
      : []
    const saidView = () => {
      if (ui.query.trim().length < 3) return null
      if (fullText.query !== ui.query.trim()) {
        return <Text dimColor>Press Enter to search what was said in every conversation too.</Text>
      }
      if (fullText.isLoading) return <Text dimColor>Searching conversations…</Text>
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Said in conversations ({said.length})</Text>
          {said.slice(0, ui.limits.said ?? 8).map(({ hit, s }) => {
            const path = `ft>${s!.id}`
            if (ui.open === path) return card(s!, true, 0, path)
            return (
              <Button key={`ft-${s!.id}`} plain onPress={() => setUi(u => ({ ...u, open: path, tab: '' }))}>
                <Text color={DOT[st(s!)]}>● </Text>
                <Text bold={!foundIds.has(s!.id)}>{s!.title}</Text>
                <Text dimColor>  {hit.count}×  {hit.snip}</Text>
              </Button>
            )
          })}
          {said.length > (ui.limits.said ?? 8) && (
            <Button key="more-said" plain onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, said: (u.limits.said ?? 8) + 10 } }))}>
              <Text dimColor>show more of {said.length - (ui.limits.said ?? 8)}</Text>
            </Button>
          )}
          <Text dimColor>{fullText.note}</Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold>
            {topLevel(groups.need).length} need you · {topLevel(groups.waiting).length} waiting · {topLevel(groups.working).length} working · {topLevel(groups.good).length} good enough
            {dueToday > 0 && <Text color={ACCENT}> · {dueToday} due</Text>}
            {asking > 0 && <Text color={ACCENT}> · ? {asking}</Text>}
            {unseenCount > 0 && <Text color={READY}> · {unseenCount} unseen</Text>}
          </Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            {ix.isLoading && Svg && <Svg source={PULSE_WORKING} alt="indexing" width={12} height={12} isInteractive />}
            <Button key="refresh" plain onPress={() => background($, refresh($))}>
              <Text dimColor>{ix.isLoading ? 'indexing…' : 'refresh'}</Text>
            </Button>
          </Box>
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1} flexShrink={1}>
            <Input
              // a new key draws a fresh, empty box: how ✕ clears a field the board does not bind
              key={ui.cleared ? `q${ui.cleared}` : 'q'}
              placeholder="Search titles, files, media, commits… Enter: also what was said"
              // not bound to ui.query: the field keeps what is typed itself, and the
              // board redraws once typing pauses (150 ms), not on every letter. An
              // emptied box clears at once: it must never wait on the timer (in the
              // app the search stayed stuck until Enter)
              onInput={v => {
                typedQuery = v
                if (v.trim() === '') {
                  setUi(u => (u.query === '' ? u : { ...u, query: '' }))
                  return
                }
                $.clock.after(150, () => {
                  if (typedQuery === v) setUi(u => (u.query === v ? u : { ...u, query: v }))
                })
              }}
              onSubmit={v => {
                typedQuery = v
                setUi(u => ({ ...u, query: v, view: 'board' }))
                background($, searchText($, v))
              }}
            />
          </Box>
          {ui.query !== '' && (
            <Button key="q-clear" plain onPress={() => {
              typedQuery = ''
              setUi(u => ({ ...u, query: '', cleared: (u.cleared ?? 0) + 1 }))
            }}>
              <Text dimColor>✕ clear</Text>
            </Button>
          )}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginY={1}>
          <Button key="v-board" variant={ui.view === 'board' || ui.view === 'focus' ? 'primary' : 'secondary'} label="Board" onPress={() => setUi(u => ({ ...u, view: 'board' }))} />
          <Button key="v-todos" variant={ui.view === 'todos' ? 'primary' : 'secondary'}
            label={dueToday > 0 ? `Todos · ${dueToday}` : 'Todos'} onPress={() => setUi(u => ({ ...u, view: 'todos' }))} />
          <Button key="v-media" variant={ui.view === 'media' ? 'primary' : 'secondary'} label="Media" onPress={() => setUi(u => ({ ...u, view: 'media' }))} />
          <Text dimColor>|</Text>
          <Button key="p-all" variant={ui.project === '' ? 'primary' : 'secondary'} label="All" onPress={() => setUi(u => ({ ...u, project: '' }))} />
          {chips.map(p => (
            <Button key={`p-${p}`} variant={ui.project === p ? 'primary' : 'secondary'} label={projectLabel(p)}
              onPress={() => setUi(u => ({ ...u, project: u.project === p ? '' : p }))} />
          ))}
        </Box>

        {ui.view === 'media' ? mediaView()
          : ui.view === 'todos' ? todosView()
          : ui.view === 'focus' ? focusView()
          : ui.query !== '' ? (
            <Box flexDirection="column">
              {section('found', `Found for "${ui.query}"`, found, undefined, true)}
              {found.length === 0 && <Text dimColor>No title, file or commit matches, archived and parked sessions included.</Text>}
              {saidView()}
            </Box>
          ) : boardView()}
        <Text dimColor wrap="truncate-end">{ix.note}</Text>
      </Box>
    )
  })
}
