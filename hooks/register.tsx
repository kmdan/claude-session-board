import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FullText, Index, Mark, Marks, Media, Moved, Note, Notes, Sess, TextHit, Ui } from '../types'
import {
  ago, baseName, byRecent, matches, overlaps, projectColor, projectLabel, related, setMark, setProjectNames, stateOf,
} from './board'
import type { ProjectNames, State } from './board'

const PANE = 'session-board'
const TITLE = 'Sessions'
const SHOWN = 5

// Calm on purpose (a red "needs you" reads as alarm): one muted accent for
// what waits on you, grey for the rest, the project colour only on a small dot.
const ACCENT = '#c9a26b'
const BORDER = '#3a3a40'
// The pulse while indexing: an SVG animating itself (SMIL), so nothing redraws
// the board on a timer. Drawn where the surface has Svg (desktop, vscode, mobile).
const PULSE = '<svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 12 12">'
  + '<circle cx="6" cy="6" r="4" fill="#c9a26b">'
  + '<animate attributeName="opacity" values="1;0.2;1" dur="1.2s" repeatCount="indefinite"/>'
  + '<animate attributeName="r" values="4;2.6;4" dur="1.2s" repeatCount="indefinite"/>'
  + '</circle></svg>'

// The session this board is drawn in (the one being watched) gets the accent;
// sessions related to it get a border the stronger the relation, in three steps.
const HERE = ACCENT
const RELATED_BORDER: [number, string][] = [[8, '#8f7a55'], [4, '#6b5d45'], [2, '#4f4840']]

// the state of each session in a drawn thread, one quiet dot each
const DOT: Record<State, string> = {
  need: ACCENT, waiting: ACCENT, working: '#5fae6e', week: '#9a9a96', earlier: '#9a9a96',
  good: '#b8a46a', done: '#6f8fbf', parked: '#5a5a5e',
}

const indexAtom = atom({ plugin: 'session-board', key: 'index' } as const,
  { sessions: [], at: 0, note: 'not indexed yet', isLoading: false } as Index)
const uiAtom = atom({ plugin: 'session-board', key: 'ui' } as const,
  { query: '', project: '', open: '', limits: {}, shown: {}, view: 'board', focus: '', tab: '' } as Ui)
const marksAtom = atom({ plugin: 'session-board', key: 'marks' } as const, {} as Marks)
const notesAtom = atom({ plugin: 'session-board', key: 'notes' } as const, {} as Notes)
const fullTextAtom = atom({ plugin: 'session-board', key: 'fullText' } as const,
  { query: '', hits: [], isLoading: false, note: '' } as FullText)
const movedAtom = atom({ plugin: 'session-board', key: 'moved' } as const, {} as Moved)

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
async function setIndex($: $T, sessions: Sess[], at: number, note: string, isLoading: boolean): Promise<void> {
  const marks = (await read($, marksAtom)) ?? {}
  const place = placement(sessions, marks, Date.now())
  const moved = lastPlace.size === 0 ? [] : [...place].filter(([id, p]) => lastPlace.get(id) !== p).map(([id]) => id)
  lastPlace = place
  await update($, indexAtom, () => ({ sessions, at, note, isLoading }))
  if (moved.length <= 12) await glow($, moved)
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
        ...s, files: s.files.slice(0, 15), commits: s.commits.slice(-6), media: s.media ?? [], artifacts: s.artifacts ?? [], running: false,
      }))
      note = `${out.sessions.length} sessions, ${out.scanned} transcripts read, ${out.cached} from cache, ${out.missing} without a transcript, ${out.ms} ms`
    }
  } catch (err) {
    note = `indexer did not run: ${String(err)}`
  }
  if (sessions) {
    const live = await runningIds($)
    if (typeof live === 'string') note += ` | running state unknown: ${live}`
    else {
      note += ` | ${live.size} running`
      sessions = sessions.map(s => (live.has(s.id) ? { ...s, running: true } : s))
    }
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
  const current = await read($, indexAtom)
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
async function mark($: $T, id: string, m: Mark | null): Promise<void> {
  const stored = ((await $.store.get('marks')) as Marks | undefined) ?? {}
  const next = setMark(stored, id, m, Date.now())
  await $.store.set('marks', next)
  await update($, marksAtom, () => next)
  // the card leaves its section: it glows where it lands
  const ix = await read($, indexAtom)
  lastPlace = placement(ix.sessions, next, Date.now())
  await glow($, [id])
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
  let result = ''
  try {
    const res = await $.mcp.call('ccd_session_mgmt', 'send_message', { session_id: s.id, message })
    const block = res.content.find(c => c.type === 'text') as { text: string } | undefined
    result = block?.text ?? ''
    if (res.isError) {
      // the board's own session cannot message itself: submit here instead
      if (/current session/i.test(result)) {
        await $.prompt.submit({ text: message })
      } else {
        $.ui.toast(`Not sent: ${result.slice(0, 200)}`)
        return
      }
    }
  } catch (err) {
    $.ui.toast(`Not sent: ${String(err).slice(0, 200)}`)
    return
  }
  await editNotes($, s.id, list => list.map(x => (x.id === n.id ? { ...x, sent: how } : x)))
  $.ui.toast(how === 'prompt' ? `Sent to "${s.title}"` : `Asked "${s.title}" to start a subsession`)
}

async function openSession($: $T, id: string): Promise<void> {
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
    $.clock.every(120_000, () => {
      background($, tick($))
    })
    // the quick part (snapshot, pane) is awaited; the indexing runs behind it
    await openBoard($).catch(err => $.ui.log(`session-board: ${String(err)}`, { to: 'debug' }))
    return started
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
    const ix = await read($, indexAtom)
    const ui = await read($, uiAtom)
    const marks = (await read($, marksAtom)) ?? {}
    const notes = (await read($, notesAtom)) ?? {}
    const moved = (await read($, movedAtom)) ?? {}
    const fullText = await read($, fullTextAtom)
    const now = Date.now()

    const setUi = (fn: (u: Ui) => Ui) => background($, update($, uiAtom, u => fn(u)))
    const all = ix.sessions
    const byId = new Map(all.map(s => [s.id, s]))

    // the watched session: the one this board is drawn in
    const selfCli = await $.session.id()
    const here = all.find(s => s.cli === selfCli)
    const nearness = new Map((here ? related(here, all, 15) : []).map(r => [r.s.id, r.score]))
    const borderOf = (s: Sess) => {
      const g = moved[s.id] ?? 0
      if (g > 0) return GLOW[g]
      if (here && s.id === here.id) return HERE
      const score = nearness.get(s.id) ?? 0
      return RELATED_BORDER.find(([min]) => score >= min)?.[1] ?? BORDER
    }
    const inProject = ui.project ? all.filter(s => s.project === ui.project) : all
    const st = (s: Sess) => stateOf(s, marks, now)
    const groups: Record<State, Sess[]> = { need: [], waiting: [], working: [], week: [], earlier: [], good: [], done: [], parked: [] }
    // the watched session has its own place under Here, so it is not listed twice
    for (const s of [...inProject].sort(byRecent)) if (!here || s.id !== here.id) groups[st(s)].push(s)
    // a subsession whose parent is in the same list shows nested under it: the
    // header counts what a section actually lists, as the sections do
    const topLevel = (items: Sess[]) => {
      const ids = new Set(items.map(s => s.id))
      return items.filter(s => !(s.parent && ids.has(s.parent)))
    }

    // chips: the projects with something this week, busiest first
    const weekCount: Record<string, number> = {}
    for (const s of all) if (now - s.last < 7 * 86_400_000) weekCount[s.project] = (weekCount[s.project] ?? 0) + 1
    const chips = Object.entries(weekCount).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([p]) => p)

    const stateWord: Record<State, string> = {
      need: 'needs you', waiting: 'still waiting', working: 'working', week: 'this week',
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

    const noteBlock = (s: Sess) => {
      const list = notes[s.id] ?? []
      return (
        <Box flexDirection="column">
          {list.map(n => (
            <Box key={`n-${n.id}`} flexDirection="column">
              <Text dimColor={n.sent !== undefined}>• {n.text}{n.sent ? `  (sent as ${n.sent})` : ''}</Text>
              <Box flexDirection="row" gap={1}>
                <Button key={`np-${n.id}`} plain onPress={() => background($, sendNote($, s, n, 'prompt'))}>
                  <Text dimColor>→ prompt</Text>
                </Button>
                <Button key={`ns-${n.id}`} plain onPress={() => background($, sendNote($, s, n, 'subsession'))}>
                  <Text dimColor>→ subsession</Text>
                </Button>
                <Button key={`nx-${n.id}`} plain onPress={() => background($, editNotes($, s.id, l => l.filter(x => x.id !== n.id)))}>
                  <Text dimColor>remove</Text>
                </Button>
              </Box>
            </Box>
          ))}
          <Input
            key={`na-${s.id}`}
            placeholder="Add a quick note…"
            submitLabel="Add"
            onSubmit={v => {
              const text = v.trim()
              if (text) background($, editNotes($, s.id, l => [...l, { id: `${Date.now()}`, text, at: Date.now() }]))
            }}
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
    const children = (s: Sess, depth: number, path: string) => {
      const kids = kidsOf.get(s.id) ?? []
      if (kids.length === 0 || depth >= 3) return null
      const allShown = ui.shown[`kids-${path}`]
      const visible = allShown ? kids : kids.slice(0, 4)
      return (
        <Box flexDirection="column" marginTop={1} marginLeft={1}>
          {visible.map((c, i) => {
            const cPath = `${path}>${c.id}`
            const isLast = i === visible.length - 1 && visible.length === kids.length
            if (ui.open === cPath) {
              return (
                <Box key={`kb-${cPath}`} flexDirection="row">
                  <Text dimColor>{isLast ? '└ ' : '├ '}</Text>
                  <Box flexDirection="column" flexGrow={1}>{card(c, true, depth + 1, cPath)}</Box>
                </Box>
              )
            }
            const cs = st(c)
            const quiet = cs === 'done' || cs === 'parked'
            const grand = (kidsOf.get(c.id) ?? []).length
            return (
              <Button key={`k-${cPath}`} plain onPress={() => setUi(u => ({ ...u, open: cPath, tab: '' }))}>
                <Text dimColor>{isLast ? '└ ' : '├ '}</Text>
                <Text color={DOT[cs]}>● </Text>
                <Text dimColor={quiet}>{c.title}</Text>
                <Text dimColor> {stateWord[cs]} · {ago(now - c.last)}{grand ? ` · +${grand}` : ''}</Text>
              </Button>
            )
          })}
          {kids.length > visible.length && (
            <Button key={`km-${path}`} plain onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, [`kids-${path}`]: true } }))}>
              <Text dimColor>└ {kids.length - visible.length} more subsessions</Text>
            </Button>
          )}
        </Box>
      )
    }

    // the section header already names the state; a card says it only where states mix
    const card = (s: Sess, withState = false, depth = 0, path = s.id) => {
      const state = st(s)
      const isOpen = ui.open === path || (depth === 0 && ui.view === 'focus' && ui.focus === s.id)
      const waits = state === 'need' || state === 'waiting'
      const meta = [waits ? `waiting ${ago(now - s.last)}` : ago(now - s.last)]
      if (withState) meta.unshift(stateWord[state])
      if (s.fileCount) meta.push(`${s.fileCount} files`)
      if (s.media.length) meta.push(`${s.media.length} media`)
      if (s.artifacts.length) meta.push(`${s.artifacts.length} pages`)
      const noteCount = (notes[s.id] ?? []).filter(n => !n.sent).length
      if (noteCount) meta.push(`${noteCount} notes`)
      const parent = s.parent ? byId.get(s.parent) : undefined
      if (parent && depth === 0) meta.push(`↰ from ${parent.title}`)
      const clash = isOpen ? overlaps(s, all, marks, now) : []
      const rel = isOpen ? related(s, all, 5) : []
      const allNotes = notes[s.id] ?? []
      // one detail tab at a time, five items at most: the open card stays short
      const tabs: { key: Ui['tab']; label: string }[] = []
      if (s.media.length + s.artifacts.length) tabs.push({ key: 'media', label: `Media ${s.media.length + s.artifacts.length}` })
      if (s.fileCount) tabs.push({ key: 'files', label: `Files ${s.fileCount}` })
      if (rel.length) tabs.push({ key: 'related', label: `Related ${rel.length}${clash.length ? ' ⚠' : ''}` })
      tabs.push({ key: 'notes', label: allNotes.length ? `Notes ${allNotes.length}` : '+ Note' })
      const tab = isOpen ? ui.tab : ''
      const toggleTab = (k: Ui['tab']) => setUi(u => ({ ...u, tab: u.tab === k ? '' : k }))
      return (
        <Box key={`c-${path}`} flexDirection="column" borderStyle="round" borderColor={borderOf(s)} paddingX={1} marginBottom={depth === 0 ? 1 : 0}>
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Box flexShrink={1}>
              <Button key={`t-${path}`} plain onPress={() => setUi(u => ({ ...u, open: u.open === path ? '' : path, tab: '' }))}>
                <Text bold>{s.title}</Text>
              </Button>
            </Box>
            <Text wrap="truncate-end">
              {here && s.id === here.id && <Text color={HERE}>◉ here  </Text>}
              <Text color={projectColor(s.project)}>● {projectLabel(s.project)}</Text>
            </Text>
          </Box>
          <Text dimColor wrap="truncate-end">{meta.join(' · ')}</Text>
          {(isOpen || state === 'need') && s.needs !== '' && <Text color={ACCENT}>→ {s.needs}</Text>}
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
                <Button key={`o-${path}`} variant="primary" label="Open" onPress={() => background($, openSession($, s.id))} />
                <Button key={`g-${path}`} label="Good enough" onPress={() => background($, mark($, s.id, 'good'))} />
                <Button key={`d-${path}`} label="Done" onPress={() => background($, mark($, s.id, 'done'))} />
                <Button key={`p-${path}`} label="Park" onPress={() => background($, mark($, s.id, 'parked'))} />
                <Button key={`w-${path}`} label="Working" onPress={() => background($, mark($, s.id, 'working'))} />
                {marks[s.id] && <Button key={`x-${path}`} label="Auto" onPress={() => background($, mark($, s.id, null))} />}
              </Box>
            </Box>
          )}
        </Box>
      )
    }

    const section = (key: string, title: string, items: Sess[], color?: string, withState = false) => {
      // a subsession whose parent is in this same list shows nested under it, not twice
      const list = topLevel(items)
      if (list.length === 0) return null
      const limit = ui.limits[key] ?? SHOWN
      return (
        <Box key={`s-${key}`} flexDirection="column" marginBottom={1}>
          <Text bold color={color}>{title} ({list.length})</Text>
          {list.slice(0, limit).map(s => card(s, withState))}
          {list.length > limit && (
            <Button key={`more-${key}`} plain onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, [key]: limit + 10 } }))}>
              <Text dimColor>show {Math.min(10, list.length - limit)} more of {list.length - limit}</Text>
            </Button>
          )}
        </Box>
      )
    }

    const folded = (key: string, title: string, list: Sess[]) => {
      if (list.length === 0) return null
      if (ui.shown[key]) return section(key, title, list)
      return (
        <Button key={`show-${key}`} plain onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, [key]: true } }))}>
          <Text dimColor>{title} ({list.length}) · show</Text>
        </Button>
      )
    }

    const boardView = () => (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>{ix.isLoading ? 'Reading your sessions…' : ix.note}</Text>}
        {here && (
          <Box key="s-here" flexDirection="column" marginBottom={1}>
            <Text bold color={HERE}>Here</Text>
            {card(here, true, 0, `@${here.id}`)}
          </Box>
        )}
        {section('need', 'Needs you', groups.need, ACCENT)}
        {folded('waiting', 'Still waiting on you, 1-7 days', groups.waiting)}
        {section('working', 'Working', groups.working)}
        {section('week', 'This week', groups.week)}
        {section('good', 'Good enough', groups.good)}
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
      ? fullText.hits.map(hit => ({ hit, s: byCli.get(hit.cli) })).filter(x => x.s && (!ui.project || x.s.project === ui.project))
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
          <Text bold>{topLevel(groups.need).length} need you · {topLevel(groups.waiting).length} waiting · {topLevel(groups.working).length} working · {topLevel(groups.good).length} good enough</Text>
          <Box flexDirection="row" gap={1} alignItems="center">
            {ix.isLoading && Svg && <Svg source={PULSE} alt="indexing" width={12} height={12} isInteractive />}
            <Button key="refresh" plain onPress={() => background($, refresh($))}>
              <Text dimColor>{ix.isLoading ? 'indexing…' : 'refresh'}</Text>
            </Button>
          </Box>
        </Box>
        <Input
          key="q"
          placeholder="Search titles, files, media, commits… Enter: also what was said"
          value={ui.query}
          onInput={v => setUi(u => ({ ...u, query: v }))}
          onSubmit={v => {
            setUi(u => ({ ...u, query: v, view: 'board' }))
            background($, searchText($, v))
          }}
        />
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginY={1}>
          <Button key="v-board" variant={ui.view === 'board' || ui.view === 'focus' ? 'primary' : 'secondary'} label="Board" onPress={() => setUi(u => ({ ...u, view: 'board' }))} />
          <Button key="v-media" variant={ui.view === 'media' ? 'primary' : 'secondary'} label="Media" onPress={() => setUi(u => ({ ...u, view: 'media' }))} />
          <Text dimColor>|</Text>
          <Button key="p-all" variant={ui.project === '' ? 'primary' : 'secondary'} label="All" onPress={() => setUi(u => ({ ...u, project: '' }))} />
          {chips.map(p => (
            <Button key={`p-${p}`} variant={ui.project === p ? 'primary' : 'secondary'} label={projectLabel(p)}
              onPress={() => setUi(u => ({ ...u, project: u.project === p ? '' : p }))} />
          ))}
        </Box>

        {ui.view === 'media' ? mediaView()
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
