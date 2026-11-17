// What the board's buttons do: marks, answers, hiding, archiving, pasting, opening a session.
import type { Answered, Mark, Marks, QPage } from '../types'
import { pageSig, setMark } from './board'
import {
  background, flushUse, glow, live, logUse, placement, readIndex, readQuery, readSeen, setAnswered, setHidden, setIndex, setMarks, setSeen,
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

/** For a page answered some way the board cannot see (in your own words, out loud). */
export async function markAnswered($: $T, page: QPage): Promise<void> {
  logUse('answered', { questions: page.qs.length })
  const stored = ((await $.store.get('answered')) as Answered | undefined) ?? {}
  const next = { ...stored, [page.p]: { at: Date.now(), t: page.t, sig: pageSig(page) } }
  await $.store.set('answered', next)
  await setAnswered($, next)
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
 * Tidy up's Hide: takes sessions off this board (the app keeps them as they
 * are), or with `on` false brings them back. Kept in the store, so every
 * session's board leaves them out; search still finds them.
 */
export async function hideMany($: $T, ids: string[], on: boolean): Promise<void> {
  logUse(on ? 'tidy-hide' : 'tidy-unhide', { count: ids.length })
  const stored = ((await $.store.get('hidden')) as Record<string, number> | undefined) ?? {}
  const next = { ...stored }
  for (const id of ids) {
    if (on) next[id] = Date.now()
    else delete next[id]
  }
  await $.store.set('hidden', next)
  await setHidden($, next)
  $.ui.toast(on ? `Hid ${ids.length} session${ids.length === 1 ? '' : 's'} from the board (Tidy up: Unhide)` : `${ids.length} back on the board`)
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

/**
 * Saves pasted text (a log, a command's output) as a Markdown file and puts its
 * path into this session's prompt box, so Claude reads the file, or the part of
 * it it needs, instead of the whole paste riding along in the conversation.
 * Kept in the plugin's cache/ (git ignores it), never in the session's repo.
 */
export async function savePaste($: $T, text: string): Promise<void> {
  if (!text.trim()) return
  const d = new Date()
  const p2 = (n: number) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
  const first = text.split('\n').find(l => l.trim()) ?? ''
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'paste'
  const path = `${$.plugin.root}/cache/paste-${stamp}-${slug}.md`.replace(/\\/g, '/')
  const lines = text.split('\n').length
  // a fence the text cannot close by itself
  const fence = text.includes('```') ? '~~~~' : '```'
  await $.fs.write(path, `# Pasted ${d.toLocaleString()}\n\n${lines} lines\n\n${fence}text\n${text.replace(/\s+$/, '')}\n${fence}\n`)
  logUse('paste', { lines, chars: text.length })
  const filled = await $.prompt.fill({ text: ` Pasted output (${lines} lines): ${path} `, mode: 'append' }).catch(() => undefined)
  $.ui.toast(filled?.isFilled === false
    ? `Saved ${lines} lines to ${path} (the prompt box was busy: the path is not in it)`
    : `Saved ${lines} lines; its path is in your prompt`)
}

export async function openFile($: $T, path: string): Promise<void> {
  logUse('file', { kind: path.split('.').pop()?.toLowerCase() ?? '' })
  await $.process.run(['explorer.exe', path])
}

export async function reveal($: $T, path: string): Promise<void> {
  logUse('folder')
  await $.process.run(['explorer.exe', `/select,${path}`])
}
