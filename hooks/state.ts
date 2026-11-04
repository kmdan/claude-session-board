// What the board keeps: the shared values a drawing subscribes to, the sessions
// in this module's memory, and taking in a new index.
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { Answered, FullText, Index, IndexMeta, Marks, Moved, Notes, Sess, Ui } from '../types'
import { byRecent, chatAnswers, pageSig, stateOf } from './board'
import type { State } from './board'

export type $T = EngineInterface

export const PANE = 'session-board'
export const TITLE = 'Sessions'
// where todos that belong to no session yet are kept
export const INBOX = '_inbox'

// The index's small facts live in shared state (a drawing subscribes to them);
// the sessions themselves (1.2 MB at 660) stay in this module's memory. In
// state they were copied out on every drawing: measured ~200 ms per click or
// keystroke at 660 sessions, growing with the count.
// The engine reads an atom only from a const of the file that uses it, so only
// this file touches them; the others go through the functions below.
const indexAtom = atom({ plugin: 'session-board', key: 'index' } as const,
  { at: 0, note: 'not indexed yet', isLoading: false, version: 0 } as IndexMeta)
const uiAtom = atom({ plugin: 'session-board', key: 'ui' } as const,
  { query: '', project: '', open: '', limits: {}, shown: {}, view: 'board', focus: '', tab: '', label: '' } as Ui)
const marksAtom = atom({ plugin: 'session-board', key: 'marks' } as const, {} as Marks)
const notesAtom = atom({ plugin: 'session-board', key: 'notes' } as const, {} as Notes)
const fullTextAtom = atom({ plugin: 'session-board', key: 'fullText' } as const,
  { query: '', hits: [], isLoading: false, note: '' } as FullText)
const movedAtom = atom({ plugin: 'session-board', key: 'moved' } as const, {} as Moved)
const openingAtom = atom({ plugin: 'session-board', key: 'opening' } as const, '')
const answeredAtom = atom({ plugin: 'session-board', key: 'answered' } as const, {} as Answered)
// per session, when you last opened its card or the session: a newer ask pulses
const seenAtom = atom({ plugin: 'session-board', key: 'seen' } as const, {} as Record<string, number>)

/** Every shared value a drawing shows; reading them here subscribes the drawing to them. */
export async function readShared($: $T) {
  return {
    ui: await read($, uiAtom),
    marks: (await read($, marksAtom)) ?? {},
    notes: (await read($, notesAtom)) ?? {},
    moved: (await read($, movedAtom)) ?? {},
    opening: (await read($, openingAtom)) ?? '',
    answered: (await read($, answeredAtom)) ?? {},
    seen: (await read($, seenAtom)) ?? {},
    fullText: await read($, fullTextAtom),
  }
}

export async function readSeen($: $T): Promise<Record<string, number>> {
  return (await read($, seenAtom)) ?? {}
}

export async function readQuery($: $T): Promise<string> {
  return (await read($, uiAtom)).query
}

export async function updateUi($: $T, fn: (u: Ui) => Ui): Promise<void> {
  await update($, uiAtom, u => fn(u))
}

export async function updateIndexMeta($: $T, fn: (m: IndexMeta) => IndexMeta): Promise<void> {
  await update($, indexAtom, m => fn(m))
}

export async function updateFullText($: $T, fn: (f: FullText) => FullText): Promise<void> {
  await update($, fullTextAtom, f => fn(f))
}

export async function updateOpening($: $T, fn: (id: string) => string): Promise<void> {
  await update($, openingAtom, o => fn(o))
}

export async function setMarks($: $T, next: Marks): Promise<void> {
  await update($, marksAtom, () => next)
}

export async function setNotes($: $T, next: Notes): Promise<void> {
  await update($, notesAtom, () => next)
}

export async function setAnswered($: $T, next: Answered): Promise<void> {
  await update($, answeredAtom, () => next)
}

export async function setSeen($: $T, next: Record<string, number>): Promise<void> {
  await update($, seenAtom, () => next)
}

/**
 * This module's own memory; a reload starts it over. An object, so the other
 * modules can write to it too.
 */
export const live = {
  sessions: [] as Sess[],
  // Only a session showing the board re-indexes on the timer: with the board
  // installed everywhere, ten open sessions must not all index every 2 minutes.
  // A reload starts it false and the next draw sets it again.
  isShown: false,
  // the search field's latest text, while the board waits for a pause in typing
  typedQuery: '',
  // the last placement this board drew; a reload starts it empty (no glow then)
  lastPlace: new Map<string, string>(),
  // fresh cards you opened: they keep their place on top until you close them
  keptOnTop: new Set<string>(),
  // when the last quick check ran: the next one asks only for records changed since
  lastQuick: 0,
  // the time of the last quick check, to see who stopped working since
  lastQuickNow: 0,
}

// The engine follows `$` past an import only into a function declaration (one
// reason `$` is handed from function to function, not kept in an object).
export function background($: $T, work: Promise<unknown>): void {
  work.catch(err => $.ui.log(`session-board: ${String(err)}`, { to: 'debug' }))
}

/** The index as a drawing or a tick uses it: the shared facts plus the sessions from memory. */
export async function readIndex($: $T): Promise<Index> {
  const meta = await read($, indexAtom)
  return { ...meta, sessions: live.sessions }
}

/** Where each session sits now: its section and its rank in it, by recency. */
export function placement(sessions: Sess[], marks: Marks, now: number): Map<string, string> {
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

// A card that moved or changed state glows and fades back in three steps.
// The pane cannot animate a card sliding to its new place; the glow is what
// lets the eye find where it went.
export const GLOW = ['', '#6b5d45', '#a8895c', '#e0b878']
const GLOW_STEP_MS = 700

export async function glow($: $T, ids: string[]): Promise<void> {
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
export async function setIndex($: $T, sessions: Sess[], at: number, note: string, isLoading: boolean, isFull = true): Promise<void> {
  const marks = (await read($, marksAtom)) ?? {}
  const place = placement(sessions, marks, Date.now())
  const moved = live.lastPlace.size === 0 ? [] : [...place].filter(([id, p]) => live.lastPlace.get(id) !== p).map(([id]) => id)
  live.lastPlace = place
  live.sessions = sessions
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

export async function loadStored($: $T): Promise<void> {
  const marks = (await $.store.get('marks')) as Marks | undefined
  if (marks) await update($, marksAtom, () => marks)
  const notes = (await $.store.get('notes')) as Notes | undefined
  if (notes) await update($, notesAtom, () => notes)
  const answered = (await $.store.get('answered')) as Answered | undefined
  if (answered) await update($, answeredAtom, () => answered)
  const seen = (await $.store.get('seen')) as Record<string, number> | undefined
  if (seen) await update($, seenAtom, () => seen)
}
