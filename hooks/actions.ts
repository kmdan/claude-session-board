// What the board's buttons do: marks, todos, answers, opening a session.
import type { Answered, Mark, Marks, Note, Notes, QPage, Sess } from '../types'
import { pageSig, parseQuick, setMark } from './board'
import {
  background, flushUse, glow, INBOX, live, logUse, placement, readIndex, readQuery, readSeen, setAnswered, setIndex, setMarks, setNotes, setSeen,
  updateOpening, updateUi,
} from './state'
import type { $T } from './state'

/** You saw this session's latest: its "just asked" pulse stops. */
export async function markSeen($: $T, id: string): Promise<void> {
  const stored = ((await $.store.get('seen')) as Record<string, number> | undefined) ?? {}
  const next = { ...stored, [id]: Date.now() }
  await $.store.set('seen', next)
  await setSeen($, next)
}

/**
 * Every open session runs its own copy of the board, all on one store. So a
 * write re-reads the store first: another session's marks and notes since
 * this one loaded are kept, not overwritten with a stale copy.
 */
export async function mark($: $T, id: string, m: Mark | null, title = '', via = 'card'): Promise<void> {
  logUse('mark', { id, mark: m ?? 'auto', via })
  const stored = ((await $.store.get('marks')) as Marks | undefined) ?? {}
  const next = setMark(stored, id, m, Date.now())
  await $.store.set('marks', next)
  await setMarks($, next)
  // the card leaves its section: it glows where it lands
  const ix = await readIndex($)
  live.lastPlace = placement(ix.sessions, next, Date.now())
  await glow($, [id])
  // said in words too: a card that stays put (the one under Here) shows no move
  const words: Record<Mark, string> = { good: 'good enough', done: 'done', parked: 'parked', working: 'working' }
  $.ui.toast(m ? `Marked ${words[m]}${title ? `: ${title}` : ''}` : `Back to automatic${title ? `: ${title}` : ''}`)
}

export async function editNotes($: $T, id: string, fn: (list: Note[]) => Note[]): Promise<void> {
  const stored = ((await $.store.get('notes')) as Notes | undefined) ?? {}
  const list = fn(stored[id] ?? [])
  const next = { ...stored }
  if (list.length === 0) delete next[id]
  else next[id] = list
  await $.store.set('notes', next)
  await setNotes($, next)
}

/**
 * Sends a note into its session. "prompt" = as the next message; "subsession"
 * = asks that session to start a linked side session for it, because that
 * session knows the topic and writes a better brief than the board can.
 */
export async function sendNote($: $T, s: Sess, n: Note, how: 'prompt' | 'subsession'): Promise<void> {
  const message = how === 'prompt' ? n.text
    : `Start a linked side session for this (start_session, initiation "user_asked", context "fork"), `
      + `brief it from what you know here, then carry on with your own work:\n\n${n.text}`
  logUse('todo-send', { how })
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

/** For a page answered some way the board cannot see (in your own words, out loud). */
export async function markAnswered($: $T, page: QPage): Promise<void> {
  logUse('answered', { questions: page.qs.length })
  const stored = ((await $.store.get('answered')) as Answered | undefined) ?? {}
  const next = { ...stored, [page.p]: { at: Date.now(), t: page.t, sig: pageSig(page) } }
  await $.store.set('answered', next)
  await setAnswered($, next)
}

/** Adds a todo from a quick-add line: `@label` and one date word are read out of it. */
export async function addTodo($: $T, owner: string, line: string): Promise<void> {
  const now = Date.now()
  const { text, labels, due } = parseQuick(line, now)
  if (!text) return
  logUse('todo', { inbox: owner === INBOX, labels: labels.length, due: !!due })
  await editNotes($, owner, list => [...list, { id: `${now}`, text, at: now, labels, due }])
}

export async function toggleDone($: $T, owner: string, id: string): Promise<void> {
  await editNotes($, owner, list => list.map(n => (n.id === id ? { ...n, done: !n.done } : n)))
}

/**
 * Turns an Inbox todo into a real session: a new linked session of the one
 * this board is drawn in, briefed with the todo. The todo stays, marked.
 */
export async function startFromTodo($: $T, n: Note): Promise<void> {
  logUse('todo-session')
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
export async function openSession($: $T, id: string, via = '?'): Promise<void> {
  // the link goes out first: everything else redraws the board, and the switch
  // should not wait for that. Only what changes redraws: a session already seen
  // and an empty search stay as they are.
  const launched = $.process.run(['cmd', '/c', 'start', '', `claude://claude.ai/epitaxy/${id}`])
  await updateOpening($, () => id)
  $.clock.after(5_000, () => {
    background($, updateOpening($, o => (o === id ? '' : o)))
  })
  const s = live.sessions.find(x => x.id === id)
  const seen = await readSeen($)
  const isUnseen = !s || Math.max(s.touched ?? 0, seen[id] ?? 0) < s.last
  // where it was opened from, and what the session was like then
  logUse('open', {
    via, id, project: s?.project, sub: !!s?.parent, status: s?.appStatus ?? null, unseen: isUnseen,
    ageMin: s ? Math.round((Date.now() - s.last) / 60_000) : null,
  })
  background($, flushUse($))
  if (isUnseen) background($, markSeen($, id))
  // leaving for a session: the search is cleared, the project chip stays (it is where you work)
  live.typedQuery = ''
  if ((await readQuery($)) !== '') {
    background($, updateUi($, u => ({ ...u, query: '', cleared: (u.cleared ?? 0) + 1 })))
  }
  await launched
}

/**
 * ‹ and ›: back and forward through the sessions you were in, as a browser does.
 * The trail is the app's own "last looked at" order, so a session you clicked in
 * the app counts too. It is fixed when you first step back (stepping would
 * otherwise reorder it) and kept in the store: each step lands in another
 * session, whose own board reads it there. A trail you left (opened something
 * else) or ten minutes old starts over.
 */
type Trail = { list: string[]; pos: number; at: number }

export async function trailOf($: $T, here: string | undefined): Promise<Trail | undefined> {
  const t = (await $.store.get('trail')) as Trail | undefined
  return t && Date.now() - t.at < 10 * 60_000 && t.list[t.pos] === here ? t : undefined
}

export async function stepTrail($: $T, dir: 1 | -1, here: string | undefined, recent: string[]): Promise<void> {
  const t = (await trailOf($, here)) ?? { list: here ? [here, ...recent.filter(id => id !== here)] : recent, pos: here ? 0 : -1, at: 0 }
  const pos = t.pos + dir
  if (pos < 0 || pos >= t.list.length) return
  await $.store.set('trail', { list: t.list, pos, at: Date.now() })
  await openSession($, t.list[pos], dir === 1 ? 'trail-back' : 'trail-forward')
}

/**
 * Tidy up: archives the ticked sessions through the app's own archive, one by
 * one (the app may ask you to approve each). Archived is reversible: the app's
 * Archived list brings a session back. A refusal is counted and the rest go on;
 * three in a row stop it (you most likely said no).
 */
export async function archiveMany($: $T, ids: string[]): Promise<void> {
  logUse('tidy-archive', { count: ids.length })
  $.ui.toast(`Archiving ${ids.length} session${ids.length === 1 ? '' : 's'}…`)
  const done: string[] = []
  const failed: string[] = []
  let refusedInRow = 0
  for (const id of ids) {
    let ok = false
    let why = ''
    try {
      const res = await $.mcp.call('ccd_session_mgmt', 'archive_session', { session_id: id, reason: 'Tidy up on the session board: quiet for a long while' })
      const block = res.content.find(c => c.type === 'text') as { text: string } | undefined
      ok = !res.isError
      why = block?.text ?? ''
    } catch (err) {
      why = String(err)
    }
    if (ok) {
      done.push(id)
      refusedInRow = 0
    } else {
      failed.push(`${id}: ${why.slice(0, 80)}`)
      refusedInRow += 1
      if (refusedInRow >= 3) break
    }
  }
  // the board shows them archived at once; the next index confirms it
  const gone = new Set(done)
  const ix = await readIndex($)
  if (gone.size) await setIndex($, ix.sessions.map(s => (gone.has(s.id) ? { ...s, archived: true } : s)), ix.at, ix.note, false, false)
  const left = ids.length - done.length - failed.length
  $.ui.toast(`Archived ${done.length}${failed.length ? `, ${failed.length} not (${failed[0]})` : ''}${left ? `, stopped before ${left} more` : ''}`)
}

export async function openFile($: $T, path: string): Promise<void> {
  logUse('file', { kind: path.split('.').pop()?.toLowerCase() ?? '' })
  await $.process.run(['explorer.exe', path])
}

export async function reveal($: $T, path: string): Promise<void> {
  logUse('folder')
  await $.process.run(['explorer.exe', `/select,${path}`])
}
