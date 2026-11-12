// Getting the sessions: the indexer, the shared snapshot, the 20-second and
// 2-minute checks, the full-text search, and opening the board's pane.
import type { Sess, TextHit } from '../types'
import { isWorking, setProjectNames } from './board'
import type { ProjectNames } from './board'
import { background, live, loadStored, PANE, readIndex, setIndex, TITLE, updateFullText, updateIndexMeta } from './state'
import type { $T } from './state'

/**
 * Searches what was said in every conversation (the indexer's text copies,
 * local only) for all words of the query. Runs on Enter, not on each key.
 */
export async function searchText($: $T, query: string): Promise<void> {
  const q = query.trim()
  if (q.length < 3) {
    await updateFullText($, () => ({ query: q, hits: [], isLoading: false, note: '' }))
    return
  }
  await updateFullText($, f => ({ ...f, query: q, isLoading: true }))
  const root = $.plugin.root
  try {
    const run = await $.process.run(['py', '-3', `${root}/scripts/sessionindex.py`, '--search', `${root}/cache`],
      { stdin: q, timeoutMs: 60_000 })
    if (run.exitCode !== 0) throw new Error(run.stderr.slice(-200))
    const out = JSON.parse(run.stdout) as { hits: TextHit[]; files: number; ms: number }
    const note = `${out.files} conversations searched in ${out.ms} ms`
    await updateFullText($, f => (f.query === q ? { query: q, hits: out.hits, isLoading: false, note } : f))
  } catch (err) {
    await updateFullText($, f => ({ ...f, isLoading: false, note: `search failed: ${String(err).slice(0, 160)}` }))
  }
}

/** Runs the indexer (cached: ~2 s) and merges the app's live "running" flags. */
export async function refresh($: $T): Promise<void> {
  await updateIndexMeta($, ix => ({ ...ix, isLoading: true }))
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
    const running = await runningIds($)
    if (typeof running !== 'string') sessions = sessions.map(s => (running.has(s.id) ? { ...s, running: true } : s))
    const nowMs = Date.now()
    note += ` | ${sessions.filter(s => isWorking(s, nowMs)).length} working now`
      + (typeof running === 'string' ? ' (from transcript activity; the app list did not answer)' : '')
    const list = sessions
    const at = Date.now()
    await setIndex($, list, at, note, false)
    // what the next board to open draws at once, before its own refresh finishes
    await $.fs.write(`${root}/cache/snapshot.json`, JSON.stringify({ sessions: list, at, note }))
      .catch(() => undefined)
  } else {
    await updateIndexMeta($, ix => ({ ...ix, note, isLoading: false }))
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

/**
 * The 20-second check: the app's records that changed (a session finished, asks
 * for you, was looked at) are merged into the board at once, so it moves to its
 * place within seconds of the app's notification, not at the next full index.
 * Reads no transcript (about 0.1 s of work); a session the board has never seen
 * starts a full index instead. It redraws only when something really differs:
 * its time window overlaps the last one, so the same records come back.
 */
export async function quickTick($: $T): Promise<void> {
  if (!live.isShown) return
  const ix = await readIndex($)
  if (ix.sessions.length === 0 || ix.isLoading) return
  const since = Math.max(live.lastQuick, ix.at) - 5_000
  live.lastQuick = Date.now()
  const root = $.plugin.root
  const run = await $.process.run(['py', '-3', `${root}/scripts/sessionindex.py`, '--quick', String(since)], { timeoutMs: 30_000 })
  if (run.exitCode !== 0) return
  const out = JSON.parse(run.stdout) as { rows: Partial<Sess>[]; written?: Record<string, number> }
  const rows = out.rows
  const written = out.written ?? {}
  const known = new Set(ix.sessions.map(s => s.id))
  if (rows.some(r => r.id && !known.has(r.id))) {
    await refresh($)
    return
  }
  const now = Date.now()
  const changed = new Map(rows.map(r => [r.id!, r]))
  let isDifferent = false
  const merged = ix.sessions.map(s => {
    const w = written[s.cli]
    const row = changed.get(s.id)
    // a record's fields are plain values (sessionindex.py meta_fields)
    const moved = !!row && Object.entries(row).some(([k, v]) => s[k as keyof Sess] !== v)
    const next = moved ? { ...s, ...row } : s
    const withWritten = w !== undefined && w > (s.written ?? 0) ? { ...next, written: w } : next
    // a session that started or stopped working since the last check redraws the board,
    // even when nothing else changed (stopping is only time passing)
    if (moved || isWorking(s, live.lastQuickNow) !== isWorking(withWritten, now)) isDifferent = true
    return withWritten
  })
  live.lastQuickNow = now
  // a newer transcript time alone is kept for the next look, with no redraw;
  // nothing new keeps the very same list (a drawing's work on it stays valid)
  if (merged.some((s, i) => s !== ix.sessions[i])) live.sessions = merged
  if (isDifferent) await setIndex($, merged, ix.at, ix.note, false, false)
}

/**
 * The 2-minute tick. With the board open in every session, only one of them
 * needs to index: a snapshot another session wrote under two minutes ago is
 * taken as it is.
 */
export async function tick($: $T): Promise<void> {
  if (!live.isShown) return
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

/**
 * Opens the board. `isAsked`: you asked for it (the button, /board), which
 * also undoes an earlier close of yours.
 */
export async function openBoard($: $T, isAsked = false): Promise<void> {
  if (isAsked) live.wantsBoard = true
  // A session nobody is looking at has no surface: opening a pane there only
  // writes a "no surface is attached" line into its chat. It opens once the
  // session is shown (its prompt band is drawn, or a window attaches).
  if ((await $.session.surfaces()).length === 0) return
  await loadProjectNames($)
  await loadSnapshot($)
  // Closing the board in the app may only hide it: it stays open, and opening
  // an open pane changes nothing. A hidden one is closed and opened anew.
  const mine = (await $.ui.panes().catch(() => [])).find(p => p.id === PANE)
  if (mine && !mine.isShown) await $.ui.close({ id: PANE }).catch(() => undefined)
  const { isPlaced } = await $.ui.open({ id: PANE, title: TITLE, focus: true })
  live.isShown = isPlaced
  background($, loadStored($))
  background($, openFresh($))
}
