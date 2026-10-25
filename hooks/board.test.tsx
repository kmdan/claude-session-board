import { expect, mock, test } from 'claude-code/testing'

import { dayOf, dueBucket, isOpenPage, pageSig, parseQuick, startOfDay, stateOf } from './board'

const PANE = {
  plugin: 'session-board',
  component: 'Pane',
  requestId: 'session-board',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = Date.now()
const H = 3_600_000
const sess = (id: string, over: Record<string, unknown>) => ({
  id, cli: `cli-${id}`, title: id, cwd: 'C:\\x', project: 'webapp', archived: false, created: NOW - 9 * H, last: NOW - H,
  appStatus: null, detail: '', needs: '', parent: null, branch: '', transcript: 'C:\\t.jsonl',
  files: [], fileCount: 0, commits: [], media: [], artifacts: [], ...over,
})
const INDEX = {
  sessions: [
    sess('Parser rewrite', {
      appStatus: 'blocked', needs: 'OK to merge', files: ['C:\\r\\a.py'], fileCount: 1,
      media: [{ p: 'C:\\out\\demo_walkthrough.mov', k: 'movie', t: NOW - 2 * H }],
      questions: [{
        p: 'C:\\out\\questions.html', t: NOW - H, title: 'Parser: open questions', qs: [
          { q: 'Q1', to: 'me', title: 'Q1. Keep the old API?', notes: true, opts: [
            { label: 'A. Yes, for one release', value: 'Keep it one release, then remove', rec: true },
            { label: 'B. No', value: 'Remove it now', rec: false },
          ] },
          { q: 'Q2', to: 'parser-tests', title: 'Q2. Fuzz the tokenizer?', notes: true, opts: [
            { label: 'A. Yes', value: 'Fuzz it', rec: false },
          ] },
        ],
      }],
    }),
    sess('Parser edge cases', { appStatus: 'blocked', last: NOW - 3 * 24 * H, parent: 'Parser rewrite' }),
    sess('Docs audit', { project: 'api', files: ['C:\\r\\a.py'], fileCount: 1 }),
    sess('Old probe', { last: NOW - 40 * 24 * H }),
    sess('Archived exporter', {
      archived: true, files: ['C:\\b\\csvExporter.ts'], fileCount: 1, commits: ['a1b2c3d'],
      artifacts: [{ url: 'https://claude.ai/artifact/x', title: 'Export report', t: NOW - 5 * H }],
    }),
  ],
  scanned: 4, cached: 0, missing: 0, ms: 5,
}

const ran: string[][] = []
const sent: { session_id: string; message: string }[] = []
let opened = 0
let placed = true // what the surface answers to ui.open: false = nothing drew the pane
let closed = 0
// what the app reports of the board's pane: none, or one it keeps open but hidden
let panes: { id: string; title: string; isShown: boolean; isFocused: boolean; isPlaced: boolean }[] = []
const logged: string[] = []
const searched: string[] = []
const started: { title: string; prompt: string }[] = []
const toasts: string[] = []

// files the board writes (its snapshot), shared by every "session" of a test
const disk: Record<string, { text: string; mtimeMs: number }> = {}

// `ownClock` false: the test brings mock.clock (to move time by hand) instead of these stand-ins
function engine(on: any, store: Record<string, unknown> = {}, self = 'cli-elsewhere', ownClock = true) {
  on('session.id', () => ({ value: self }))
  on('ui.log', (_: unknown, e: any) => {
    logged.push(String(e.text ?? JSON.stringify(e)))
    return { value: undefined }
  })
  on('fs.write', (_: unknown, e: any) => {
    disk[e.path] = { text: e.text, mtimeMs: Date.now() }
    return { value: undefined }
  })
  on('fs.read', (_: unknown, e: any) => {
    if (!disk[e.path]) throw new Error('ENOENT')
    return { value: disk[e.path].text }
  })
  on('fs.stat', (_: unknown, e: any) => {
    if (!disk[e.path]) throw new Error('ENOENT')
    return { value: { kind: 'file', size: disk[e.path].text.length, mtimeMs: disk[e.path].mtimeMs, isLink: false } }
  })
  on('ui.close', () => {
    closed += 1
    return { value: undefined }
  })
  on('ui.panes', () => ({ value: panes }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: placed } }
  })
  on('ui.toast', (_: unknown, e: any) => {
    toasts.push(String(e.text ?? e))
    return { value: undefined }
  })
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: unknown, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  if (ownClock) on('clock.every', () => ({ value: undefined }))
  on('process.run', (_: unknown, e: any) => {
    ran.push([...e.argv])
    const isIndexer = String(e.argv[2] ?? '').endsWith('sessionindex.py')
    let stdout = ''
    if (isIndexer && e.argv[3] === '--search') {
      searched.push(String(e.stdin ?? e.init?.stdin))
      stdout = JSON.stringify({ hits: [{ cli: 'cli-Old probe', count: 4, snip: '…the flaky timeout came back…' }], files: 5, ms: 3 })
    } else if (isIndexer) stdout = JSON.stringify(INDEX)
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('mcp.call', (_: unknown, e: any) => {
    if (e.tool === 'start_session') {
      started.push(e.args)
      return { value: { isError: false, content: [{ type: 'text', text: 'Started local_00000000-0000-0000-0000-000000000001' }] } }
    }
    if (e.tool === 'send_message') {
      sent.push(e.args)
      return { value: { isError: false, content: [{ type: 'text', text: 'delivered' }] } }
    }
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify([{ sessionId: 'Docs audit', isRunning: true }]) }] } }
  })
}

async function start($: any, on: any, store?: Record<string, unknown>, self?: string, ownClock = true) {
  engine(on, store, self, ownClock)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'board' })
}

// full index runs only (not --search or --quick)
const indexRuns = () => ran.filter(a => String(a[2] ?? '').endsWith('sessionindex.py') && !String(a[3] ?? '').startsWith('--')).length

test('a session whose transcript was written in the last minute is working, without the app saying so', () => {
  const now = Date.now()
  const s = (over: Record<string, unknown>) => ({ ...sess('x', {}), touched: 0, ...over }) as any
  expect(stateOf(s({ written: now - 10_000, appStatus: 'blocked' }), {}, now)).toBe('working')
  // a minute and a half quiet: back to what the app said (here: asking)
  expect(stateOf(s({ written: now - 90_000, appStatus: 'blocked', last: now - 90_000 }), {}, now)).toBe('need')
})

test('needs you = touched by you today and not closed, or asking since a day; untouched activity today is Today', () => {
  // a Wednesday afternoon
  const now = new Date(2026, 9, 21, 15).getTime()
  const today = startOfDay(now)
  const s = (over: Record<string, unknown>) => ({ ...sess('x', {}), touched: 0, ...over }) as any
  // you looked at it this morning, it finished days ago: on your plate
  expect(stateOf(s({ touched: today + 3600_000, last: now - 3 * 24 * H }), {}, now)).toBe('need')
  // ...unless you closed it
  expect(stateOf(s({ touched: today + 3600_000 }), { x: { mark: 'done', at: 1 } }, now)).toBe('done')
  // touched yesterday, quiet since: not today's
  expect(stateOf(s({ touched: today - H, last: today - H }), {}, now)).toBe('week')
  // moved today on its own (a subsession finishing), never touched: Today
  expect(stateOf(s({ last: today + 2 * 3600_000 }), {}, now)).toBe('today')
  // asked for you two days ago: still waiting
  expect(stateOf(s({ appStatus: 'blocked', last: now - 2 * 24 * H }), {}, now)).toBe('waiting')
})

// the real board's size; the TIMING line in the test output is the measure to compare against
const SIZE = 660
test('timing at a real size: 660 sessions, first draw, a search keystroke, unfolding a section', async ($, on) => {
  const saved = INDEX.sessions
  const words = ['parser', 'export', 'cache', 'render', 'docs', 'audit', 'probe', 'fold', 'rig', 'mesh', 'shot', 'ui']
  INDEX.sessions = Array.from({ length: Number(SIZE) }, (_, i) => sess(`S${i} ${words[i % 12]} ${words[(i * 7) % 12]} work`, {
    project: `proj${i % 9}`, last: NOW - i * 3 * H, touched: i % 5 === 0 ? NOW - H : 0,
    appStatus: i % 4 === 0 ? 'blocked' : 'completed', parent: i > 20 && i % 6 === 0 ? `S${i - 1} ${words[(i - 1) % 12]} ${words[((i - 1) * 7) % 12]} work` : null,
    files: Array.from({ length: 15 }, (_, k) => `C:\\repo${i % 9}\\src\\file${(i * k) % 200}.py`), fileCount: 15,
    media: Array.from({ length: 3 }, (_, k) => ({ p: `C:\\out\\m${i}_${k}.png`, k: 'image', t: NOW - k * H })),
  })) as any
  for (const k of Object.keys(disk)) delete disk[k]
  try {
    await start($, on)
    const times: Record<string, number> = {}
    let t0 = performance.now()
    // desktop, as the app draws it (Client cards included)
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    times.firstDraw = performance.now() - t0
    t0 = performance.now()
    await ui.input({ key: 'q', text: 'pa', kind: 'change' })
    times.searchKeystroke = performance.now() - t0
    await ui.input({ key: 'q', text: '', kind: 'change' })
    t0 = performance.now()
    await ui.press({ key: 'show-waiting' })
    times.unfoldSection = performance.now() - t0
    console.log(`TIMING ${JSON.stringify(Object.fromEntries(Object.entries(times).map(([k, v]) => [k, Math.round(v)])))}`)
    await ui.unmount()
  } finally {
    INDEX.sessions = saved
  }
})

test('a subsession that just asked gets its own card on top, and its parent says so', async ($, on) => {
  const child = INDEX.sessions[1] as any
  const saved = { last: child.last }
  child.last = Date.now() // Parser edge cases (a child of Parser rewrite) asks right now
  for (const k of Object.keys(disk)) delete disk[k]
  try {
    await start($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    // its own card, in Needs you, not only a row under the parent
    expect(await ui.find({ key: 't-Parser edge cases' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /1 sub asks you/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^NEEDS YOU · 2/ })).toBeDefined()
    // its main session sits above its title, one click up
    expect(await ui.find({ type: 'Text', text: /^Parser rewrite ›$/ })).toBeDefined()
    // on its parent's rail it points up to its card
    expect(await ui.find({ type: 'Text', text: /asks you ↑/ })).toBeDefined()
    // opening it marks it seen; it must not vanish under the click (back into its parent)
    await ui.press({ key: 't-Parser edge cases' })
    expect(await ui.find({ key: 'o-Parser edge cases' })).toBeDefined()
    // seen and closed, it still waits on you: it keeps its own card
    await ui.press({ key: 't-Parser edge cases' })
    expect(await ui.find({ key: 't-Parser edge cases' })).toBeDefined()
    await ui.unmount()
  } finally {
    child.last = saved.last
  }
})

test('a subsession that only reported back stays under its parent, which says so', async ($, on) => {
  const child = INDEX.sessions[1] as any
  const saved = { last: child.last, appStatus: child.appStatus }
  Object.assign(child, { last: Date.now(), appStatus: 'completed' }) // finished a turn, asks nothing of you
  for (const k of Object.keys(disk)) delete disk[k]
  try {
    await start($, on)
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
    expect(await ui.find({ type: 'Text', text: /↩ 1 report in/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reported · / })).toBeDefined()
    // not asking you: out of Needs you (only its parent there), and not listed on its own
    // anywhere: it is a row on its main session's rail
    expect(await ui.find({ type: 'Text', text: /^NEEDS YOU · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^TODAY, NOT TOUCHED BY YOU YET/ })).toBeUndefined()
    expect(await ui.find({ key: 'k-Parser rewrite>Parser edge cases' })).toBeDefined()
    // the grey line unfolds the card too, not only the title
    await ui.press({ key: 'tm-Parser rewrite' })
    expect(await ui.find({ key: 'o-Parser rewrite' })).toBeDefined()
    await ui.unmount()
  } finally {
    Object.assign(child, saved)
  }
})

test('a session that just asked for you pulses until you open its card', async ($, on) => {
  const saved = INDEX.sessions[0].last
  // Parser rewrite asks right now: later than any "seen" an earlier test left (opening it counts as seen)
  INDEX.sessions[0].last = Date.now()
  for (const k of Object.keys(disk)) delete disk[k] // no older snapshot: this index is drawn
  try {
    await start($, on)
    // desktop: the pulses are SVGs
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    // the first pulse on the board: Needs you comes before Working, so it is the amber one while it pulses
    const firstPulse = async () => ((await ui.find({ type: 'Svg' } as any)) as any)?.props?.alt
    expect(await firstPulse()).toBe('just asked for you')
    await ui.press({ key: 't-Parser rewrite' })
    // seen: the amber pulse stops; the green one of the working session stays
    expect(await firstPulse()).toBe('working now')
    await ui.unmount()
  } finally {
    INDEX.sessions[0].last = saved
  }
})

test('a question page closes when answered anywhere, and opens again only for new questions', () => {
  const q = (n: string) => ({ q: n, to: 'me', title: `${n}. ?`, notes: true, opts: [] })
  const page = { p: 'C:\\r\\q.html', t: 100, title: 'Review', qs: [q('Q1'), q('Q2')] }
  // never answered: open; pasted into a chat: closed
  expect(isOpenPage(page, {})).toBe(true)
  expect(isOpenPage(page, {}, 50)).toBe(false)
  // answered, then the session rewrote the page (newer mtime) with the same questions: still closed
  const answered = { [page.p]: { at: 120, t: 100, sig: pageSig(page) } }
  expect(isOpenPage({ ...page, t: 200 }, answered)).toBe(false)
  // a question added: open again
  expect(isOpenPage({ ...page, t: 300, qs: [q('Q1'), q('Q2'), q('Q3')] }, answered)).toBe(true)
  // an answer from an older board (no signature) stays answered
  expect(isOpenPage({ ...page, t: 300 }, { [page.p]: { at: 120, t: 100 } })).toBe(false)
})

test('quick add reads labels and one date word out of the text', () => {
  // a Wednesday at noon
  const wed = new Date(2026, 9, 21, 12).getTime()
  expect(parseQuick('fix the export @ops @client fri', wed)).toEqual({ text: 'fix the export', labels: ['ops', 'client'], due: '2026-10-23' })
  expect(parseQuick('call back tomorrow', wed).due).toBe('2026-10-22')
  expect(parseQuick('review today', wed).due).toBe('2026-10-21')
  expect(parseQuick('ship it 3d', wed).due).toBe('2026-10-24')
  // a weekday that is today means next week's, as in Todoist
  expect(parseQuick('standup wed', wed).due).toBe('2026-10-28')
  expect(parseQuick('due 2026-11-04', wed).due).toBe('2026-11-04')
  // only the first date word is a date; words that only look like one stay text
  expect(parseQuick('today and tomorrow', wed)).toEqual({ text: 'and tomorrow', labels: [], due: '2026-10-21' })
  expect(parseQuick('wednesdays notes', wed)).toEqual({ text: 'wednesdays notes', labels: [], due: undefined })
  expect([dueBucket('2026-10-20', wed), dueBucket(dayOf(wed), wed), dueBucket('2026-10-30', wed), dueBucket(undefined, wed)])
    .toEqual(['overdue', 'today', 'upcoming', 'none'])
})

test('the Todos view: Inbox quick add, Today, label filter, tick, and a session from a todo', async ($, on) => {
  const store: Record<string, unknown> = {}
  await start($, on, store)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'v-todos' })
  await ui.input({ key: 'todo-add', text: 'check the cache size @ops today' })
  await ui.input({ key: 'todo-add', text: 'write the release notes @docs' })
  const inbox = (store.notes as Record<string, { id: string; text: string; labels: string[]; due?: string }[]>)._inbox
  expect(inbox.map(n => [n.text, n.labels, n.due !== undefined])).toEqual([
    ['check the cache size', ['ops'], true], ['write the release notes', ['docs'], false],
  ])
  expect(await ui.find({ type: 'Text', text: /^Today \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^No date \(1\)/ })).toBeDefined()
  expect(await ui.find({ key: 'v-todos' })).toMatchObject({ props: { label: 'Todos · 1' } })

  // the label chip filters
  await ui.press({ key: 'l-docs' })
  expect(await ui.find({ type: 'Text', text: /^Today/ })).toBeUndefined()
  await ui.press({ key: 'l-docs' })

  // tick: it leaves the open lists and folds into Done
  await ui.press({ key: `nd-${inbox[0].id}` })
  expect(await ui.find({ type: 'Text', text: /^Today/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Done \(1\) · show/ })).toBeDefined()

  // an Inbox todo becomes a session, briefed with its text
  started.length = 0
  await ui.press({ key: `nn-${inbox[1].id}` })
  expect(started.map(s => s.prompt)).toEqual(['write the release notes'])
  const after = (store.notes as Record<string, { sent?: string; session?: string }[]>)._inbox[1]
  expect([after.sent, after.session]).toEqual(['session', 'local_00000000-0000-0000-0000-000000000001'])
  await ui.unmount()
})

test('a session start opens the board; the first indexes, a second reads its snapshot', async ($, on) => {
  logged.length = 0
  for (const k of Object.keys(disk)) delete disk[k]
  engine(on)
  opened = 0
  const before = indexRuns()
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect([opened, ...logged]).toEqual([1])
  // the indexing runs behind the open; a drawn pane has waited it out
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(indexRuns()).toBe(before + 1)
  expect(Object.keys(disk).some(p => p.endsWith('snapshot.json'))).toBe(true)
  await ui.unmount()
})

test('a board opened right after another draws the shared snapshot and does not index', async ($, on) => {
  // disk still holds the snapshot the test above wrote, under a minute old
  engine(on)
  const before = indexRuns()
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(indexRuns()).toBe(before)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /shared refresh/ })).toBeDefined()
  await ui.unmount()
})

test('Enter searches what was said in conversations, and a hit opens its card', async ($, on) => {
  const clock = mock.clock(on, { now: Date.now() })
  await start($, on, undefined, undefined, false)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.input({ key: 'q', text: 'timeout', kind: 'change' })
  // the board waits for a pause in typing before it redraws
  expect(await ui.find({ type: 'Text', text: /Press Enter to search what was said/ })).toBeUndefined()
  await clock.advance(200)
  expect(await ui.find({ type: 'Text', text: /Press Enter to search what was said/ })).toBeDefined()
  searched.length = 0
  await ui.input({ key: 'q', text: 'timeout' })
  expect(searched).toEqual(['timeout'])
  expect(await ui.find({ type: 'Text', text: /Said in conversations \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /flaky timeout came back/ })).toBeDefined()
  await ui.press({ key: 'ft-Old probe' })
  expect(await ui.find({ key: 'o-ft>Old probe' })).toBeDefined()
  await ui.unmount()
})

test('a card that changes section glows, then fades back in three steps', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't-Parser rewrite' })
  const before = await ui.find({ key: 'c-Parser rewrite' })
  // marked working: it moves from Needs you to Working, open as it was, and glows there
  await ui.press({ key: 'w-Parser rewrite' })
  const after = await ui.find({ key: 'c-Parser rewrite' })
  // the brightest glow step right after the move, against the plain border before
  expect([before?.props?.borderColor, after?.props?.borderColor]).toEqual(['#3a3a40', '#e0b878'])
  await ui.unmount()
})

test('on the Here card: no Open, and a mark shows as the active button, says so, and toggles back', async ($, on) => {
  await start($, on, {}, 'cli-Parser rewrite')
  // the terminal: there the Here card unfolds by its title button (desktop has the Client region)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't-@Parser rewrite' })
  expect(await ui.find({ key: 'o-@Parser rewrite' })).toBeUndefined()
  toasts.length = 0
  await ui.press({ key: 'd-@Parser rewrite' })
  expect(await ui.find({ key: 'd-@Parser rewrite' })).toMatchObject({ props: { label: '✓ Done', variant: 'primary' } })
  expect(toasts).toEqual(['Marked done: Parser rewrite'])
  // the same button again: back to automatic
  await ui.press({ key: 'd-@Parser rewrite' })
  expect(await ui.find({ key: 'd-@Parser rewrite' })).toMatchObject({ props: { label: 'Done', variant: 'secondary' } })
  await ui.unmount()
})

test('the watched session is listed once, under Here, and the header counts what is listed', async ($, on) => {
  await start($, on, {}, 'cli-Parser rewrite')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ key: 't-@Parser rewrite' })).toBeDefined()
  expect(await ui.find({ key: 't-Parser rewrite' })).toBeUndefined()
  // Parser rewrite is Here, so 0 need you; its child waits (its parent is not in that list)
  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('0 need you · 1 waiting · 1 working · 0 good enough · ❓ 1')
  await ui.unmount()
})

const BAND = {
  plugin: 'session-board', component: 'AbovePrompt', requestId: 'band', surface: 'desktop',
  props: { hasSurvey: false, isWorking: false, bodyColumns: 80, view: {} },
} as any

test('the button above the prompt is always there, the board open or not', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount(BAND)
  expect(await band.find({ key: 'open-board' })).toBeDefined()
  await band.unmount()
})

test('a board the app only hid is closed and opened anew, so it shows again', async ($, on) => {
  engine(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount(BAND)
  // the person "closed" it: the app keeps it open, hidden
  panes = [{ id: 'session-board', title: 'Sessions', isShown: false, isFocused: false, isPlaced: true }]
  opened = 0
  closed = 0
  await band.press({ key: 'open-board' })
  expect([closed, opened]).toEqual([1, 1])
  // shown already: just opened (focused), never closed
  panes = [{ id: 'session-board', title: 'Sessions', isShown: true, isFocused: false, isPlaced: true }]
  closed = 0
  await band.press({ key: 'open-board' })
  expect(closed).toBe(0)
  panes = []
  await band.unmount()
})

test('a mark keeps the marks another session wrote since this one loaded', async ($, on) => {
  const store: Record<string, unknown> = {}
  await start($, on, store)
  store.marks = { 'Old probe': { mark: 'done', at: 1 } } // written by another session meanwhile
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 't-Parser rewrite' })
  await ui.press({ key: 'g-Parser rewrite' })
  expect(Object.keys(store.marks as object).sort()).toEqual(['Old probe', 'Parser rewrite'])
  await ui.unmount()
})

test('the board sorts sessions into needs-you, working and parked, on every surface with input', async ($, on) => {
  await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('1 need you · 1 waiting · 1 working · 0 good enough · ❓ 1')
    expect(await ui.find({ type: 'Text', text: /^NEEDS YOU · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Still waiting on you, 1-7 days · 1 ›/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^WORKING · 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Parking lot · 2 ›/ })).toBeDefined()
    // the project (its folder name, with no projects.json) sits on its row (working: one quiet line)
    expect(await ui.find({ type: 'Text', text: /^api$/ })).toBeDefined()
    expect(await ui.find({ key: 'row-Docs audit' })).toBeDefined()
    await ui.unmount()
  }
})

test('marking a session good enough moves it, and the files overlap shows', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 't-Parser rewrite' })
  // details stay folded until one tab is opened
  expect(await ui.find({ type: 'Text', text: /also editing the same files/ })).toBeUndefined()
  await ui.press({ key: 'tab-Parser rewrite-related' })
  expect(await ui.find({ type: 'Text', text: /also editing the same files: Docs audit/ })).toBeDefined()
  await ui.press({ key: 'o-Parser rewrite' })
  expect(ran.some(a => a.join(' ').includes('claude://claude.ai/epitaxy/Parser rewrite'))).toBe(true)

  // good enough: out of Needs you, into the folded Good enough
  await ui.press({ key: 'g-Parser rewrite' })
  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('0 need you · 1 waiting · 1 working · 1 good enough · ❓ 1')
  expect(await ui.find({ type: 'Text', text: /^Good enough · 1 ›/ })).toBeDefined()
  await ui.unmount()
})

test('search finds an archived session by a file it wrote and by its commit', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.input({ key: 'q', text: 'csvexporter' })
  // the label in capitals, the query in its own case
  expect(await ui.find({ type: 'Text', text: /^FOUND FOR "csvexporter" · 1/ })).toBeDefined()
  await ui.input({ key: 'q', text: 'a1b2c3d' })
  expect(await ui.find({ type: 'Text', text: /\(1\)/ })).toBeDefined()
  await ui.unmount()
})

test('the media view lists movies and pages newest first, and a click opens the file', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 'v-media' })
  expect(await ui.find({ type: 'Text', text: /newest first \(2\)/ })).toBeDefined()
  await ui.press({ key: 'mo-Parser rewrite-C:\\out\\demo_walkthrough.mov' })
  expect(ran.some(a => a[0] === 'explorer.exe' && a[1] === 'C:\\out\\demo_walkthrough.mov')).toBe(true)
  await ui.unmount()
})

test('a quick note is kept, and goes to its session as a prompt or as a subsession request', async ($, on) => {
  const store: Record<string, unknown> = {}
  await start($, on, store)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 't-Parser rewrite' })
  await ui.press({ key: 'tab-Parser rewrite-notes' })
  await ui.input({ key: 'na-Parser rewrite', text: 'try the empty-file case' })
  const notes = store.notes as Record<string, { id: string; text: string }[]>
  expect(notes['Parser rewrite'].map(n => n.text)).toEqual(['try the empty-file case'])

  const id = notes['Parser rewrite'][0].id
  sent.length = 0
  await ui.press({ key: `np-${id}` })
  expect(sent[0]).toEqual({ session_id: 'Parser rewrite', message: 'try the empty-file case' })
  await ui.press({ key: `ns-${id}` })
  expect(sent[1].message).toMatch(/start_session[\s\S]*try the empty-file case/)
  await ui.unmount()
})

test('subsessions show live under their parent card and open in place', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // Parser edge cases is Parser rewrite's child: a row under the parent, closed card or not
  expect(await ui.find({ key: 'k-Parser rewrite>Parser edge cases' })).toBeDefined()
  // it waits on you (blocked): its rail row says so and points up to its own card
  expect(await ui.find({ type: 'Text', text: /asks you ↑ · 3 d/ })).toBeDefined()
  await ui.press({ key: 'k-Parser rewrite>Parser edge cases' })
  // it opens as its own card, nested: its buttons carry the nested path
  expect(await ui.find({ key: 'o-Parser rewrite>Parser edge cases' })).toBeDefined()
  // and it still has its own place in "Still waiting", a different section
  await ui.press({ key: 'show-waiting' })
  expect(await ui.find({ key: 't-Parser edge cases' })).toBeDefined()
  await ui.unmount()
})

test('the watched session is marked and pinned under Here; elsewhere there is no Here', async ($, on) => {
  await start($, on, {}, 'cli-Parser rewrite')
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /^HERE$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◉ here/ })).toBeDefined()
  expect(await ui.find({ key: 't-@Parser rewrite' })).toBeDefined()
  await ui.unmount()
})

test('desktop: a card unfolds from anywhere on it: the blank layer under it, the title, the grey line, the needs line', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // the lines are no longer padded (it wrapped them in a proportional font)
  const info = (await ui.find({ type: 'Text', text: /^❓ 2 questions · waiting/ })) as any
  expect(info?.text).not.toMatch(/⠀/)
  for (const line of ['tb', 't', 'tm', 'tn']) {
    await ui.press({ key: `${line}-Parser rewrite` })
    expect(await ui.find({ key: 'd-Parser rewrite' })).toBeDefined()
    await ui.press({ key: `${line}-Parser rewrite` })
    expect(await ui.find({ key: 'd-Parser rewrite' })).toBeUndefined()
  }
  await ui.unmount()
})

test('a board in a session it does not know shows no Here', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: /◉ here/ })).toBeUndefined()
  await ui.unmount()
})

test('a review page is answered on the card and the answers go to its session in the page format', async ($, on) => {
  const store: Record<string, unknown> = {}
  await start($, on, store)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  expect(await ui.find({ type: 'Text', text: /❓ 2 questions/ })).toBeDefined()
  await ui.press({ key: 't-Parser rewrite' })
  await ui.press({ key: 'tab-Parser rewrite-questions' })
  expect(await ui.find({ type: 'Text', text: /^Q1\. Keep the old API\?/ })).toBeDefined()

  // pick B (not the session's own pick), a note on Q1, Q2 left open, and free text
  await ui.press({ key: 'qo-Parser rewrite-0-Q1-1' })
  await ui.input({ key: 'qn-Parser rewrite-0-Q1', text: 'nobody uses it', kind: 'change' })
  await ui.input({ key: 'qg-Parser rewrite-0', text: 'nice work', kind: 'change' })
  sent.length = 0
  await ui.press({ key: 'qs-Parser rewrite-0' })
  expect(sent).toEqual([{
    session_id: 'Parser rewrite',
    message: 'Answers from Parser: open questions:\nQ1 [me]: Remove it now | note: nobody uses it\nGeneral [me]: nice work',
  }])

  // answered: the badge goes, the tab says so, and the page is remembered
  expect(await ui.find({ type: 'Text', text: /❓ 2 questions/ })).toBeUndefined()
  expect(await ui.find({ key: 'tab-Parser rewrite-questions' })).toMatchObject({ props: { } })
  expect(Object.keys(store.answered as object)).toEqual(['C:\\out\\questions.html'])
  expect(await ui.find({ type: 'Text', text: /✓ Parser: open questions · answered/ })).toBeDefined()
  await ui.unmount()
})

test('one click opens a session; a subsession links up to its parent', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // closed card, one press: the session opens
  ran.length = 0
  await ui.press({ key: 'go-Docs audit' })
  expect(ran.some(a => a.join(' ').includes('claude://claude.ai/epitaxy/Docs audit'))).toBe(true)
  // the app takes seconds to switch: the button answers at once
  expect(await ui.find({ type: 'Text', text: /^opening…$/ })).toBeDefined()

  // the subsession's own card (in Still waiting) carries its way up
  await ui.press({ key: 'show-waiting' })
  ran.length = 0
  await ui.press({ key: 'upo-Parser edge cases' })
  expect(ran.some(a => a.join(' ').includes('claude://claude.ai/epitaxy/Parser rewrite'))).toBe(true)
  await ui.press({ key: 'up-Parser edge cases' })
  expect(await ui.find({ type: 'Text', text: /back to the board/ })).toBeDefined()
  expect(await ui.find({ key: 't-Parser rewrite' })).toBeDefined()
  await ui.unmount()
})

test('an open card lists related sessions, and one opens on its own', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  await ui.press({ key: 't-Parser rewrite' })
  // Parser edge cases is its child; Docs audit wrote the same file
  await ui.press({ key: 'tab-Parser rewrite-related' })
  await ui.press({ key: 'r-Parser rewrite-Parser edge cases' })
  expect(await ui.find({ type: 'Text', text: /back to the board/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^still waiting/ })).toBeDefined()
  await ui.unmount()
})
