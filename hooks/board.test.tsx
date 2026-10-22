import { expect, test } from 'claude-code/testing'

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
const logged: string[] = []
const searched: string[] = []

// files the board writes (its snapshot), shared by every "session" of a test
const disk: Record<string, { text: string; mtimeMs: number }> = {}

function engine(on: any, store: Record<string, unknown> = {}, self = 'cli-elsewhere') {
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
  on('ui.close', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'board' } }))
  on('ui.open', () => {
    opened += 1
    return { value: { isPlaced: placed } }
  })
  on('ui.toast', () => ({ value: undefined }))
  on('session.start', (_: unknown, e: any) => ({ cwd: e.cwd }))
  on('store.get', (_: unknown, e: any) => ({ value: store[e.key] }))
  on('store.set', (_: unknown, e: any) => {
    store[e.key] = JSON.parse(JSON.stringify(e.value))
    return { value: undefined }
  })
  on('clock.every', () => ({ value: undefined }))
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
    if (e.tool === 'send_message') {
      sent.push(e.args)
      return { value: { isError: false, content: [{ type: 'text', text: 'delivered' }] } }
    }
    return { value: { isError: false, content: [{ type: 'text', text: JSON.stringify([{ sessionId: 'Docs audit', isRunning: true }]) }] } }
  })
}

async function start($: any, on: any, store?: Record<string, unknown>, self?: string) {
  engine(on, store, self)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.command.run({ command: 'board' })
}

const indexRuns = () => ran.filter(a => String(a[2] ?? '').endsWith('sessionindex.py')).length

test('a session start opens the board; the first indexes, a second reads its snapshot', async ($, on) => {
  logged.length = 0
  for (const k of Object.keys(disk)) delete disk[k]
  engine(on)
  opened = 0
  const before = indexRuns()
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect([opened, ...logged]).toEqual([1])
  // the indexing runs behind the open; a drawn pane has waited it out
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
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
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /shared refresh/ })).toBeDefined()
  await ui.unmount()
})

test('Enter searches what was said in conversations, and a hit opens its card', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.input({ key: 'q', text: 'timeout', kind: 'change' })
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
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 't-Parser rewrite' })
  const before = await ui.find({ key: 'c-Parser rewrite' })
  await ui.press({ key: 'g-Parser rewrite' })
  const after = await ui.find({ key: 'c-Parser rewrite' })
  // the brightest glow step right after the move, against the plain border before
  expect([before?.props?.borderColor, after?.props?.borderColor]).toEqual(['#3a3a40', '#e0b878'])
  await ui.unmount()
})

test('the watched session is listed once, under Here, and the header counts what is listed', async ($, on) => {
  await start($, on, {}, 'cli-Parser rewrite')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ key: 't-@Parser rewrite' })).toBeDefined()
  expect(await ui.find({ key: 't-Parser rewrite' })).toBeUndefined()
  // Parser rewrite is Here, so 0 need you; its child waits (its parent is not in that list)
  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('0 need you · 1 waiting · 1 working · 0 good enough')
  await ui.unmount()
})

test('the button above the prompt opens the board, then steps aside', async ($, on) => {
  engine(on)
  // stands for the app's own band, drawn once the button steps aside
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'session-board', component: 'AbovePrompt', requestId: 'band', surface: 'desktop',
    props: { hasSurvey: false, bodyColumns: 80, view: {} },
  } as any)
  // placed at the start: the button stays away
  expect(await band.find({ key: 'open-board' })).toBeUndefined()
  await band.unmount()
})

test('while no surface placed the board, the button stays, and a press opens it', async ($, on) => {
  engine(on)
  on('ui.render', ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)
    return <Text>engine band</Text>
  })
  placed = false
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const band = await $.ui.mount({
    plugin: 'session-board', component: 'AbovePrompt', requestId: 'band', surface: 'desktop',
    props: { hasSurvey: false, bodyColumns: 80, view: {} },
  } as any)
  expect(await band.find({ key: 'open-board' })).toBeDefined()
  placed = true
  opened = 0
  await band.press({ key: 'open-board' })
  expect(opened).toBe(1)
  expect(await band.find({ key: 'open-board' })).toBeUndefined()
  await band.unmount()
})

test('a mark keeps the marks another session wrote since this one loaded', async ($, on) => {
  const store: Record<string, unknown> = {}
  await start($, on, store)
  store.marks = { 'Old probe': { mark: 'done', at: 1 } } // written by another session meanwhile
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 't-Parser rewrite' })
  await ui.press({ key: 'g-Parser rewrite' })
  expect(Object.keys(store.marks as object).sort()).toEqual(['Old probe', 'Parser rewrite'])
  await ui.unmount()
})

test('the board sorts sessions into needs-you, working and parked, on every surface with input', async ($, on) => {
  await start($, on)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('1 need you · 1 waiting · 1 working · 0 good enough')
    expect(await ui.find({ type: 'Text', text: /^Needs you \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Still waiting on you, 1-7 days \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Working \(1\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Parking lot \(2\)/ })).toBeDefined()
    // the project (its folder name, with no projects.json) sits on the card
    expect(await ui.find({ type: 'Text', text: /● api/ })).toBeDefined()
    await ui.unmount()
  }
})

test('marking a session good enough moves it, and the files overlap shows', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 't-Parser rewrite' })
  // details stay folded until one tab is opened
  expect(await ui.find({ type: 'Text', text: /also editing the same files/ })).toBeUndefined()
  await ui.press({ key: 'tab-Parser rewrite-related' })
  expect(await ui.find({ type: 'Text', text: /also editing the same files: Docs audit/ })).toBeDefined()
  await ui.press({ key: 'g-Parser rewrite' })
  expect((await ui.find({ type: 'Text', text: /need you/ }))?.text).toBe('0 need you · 1 waiting · 1 working · 1 good enough')

  await ui.press({ key: 'o-Parser rewrite' })
  expect(ran.some(a => a.join(' ').includes('claude://claude.ai/epitaxy/Parser rewrite'))).toBe(true)
  await ui.unmount()
})

test('search finds an archived session by a file it wrote and by its commit', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.input({ key: 'q', text: 'csvexporter' })
  expect(await ui.find({ type: 'Text', text: /Found for "csvexporter" \(1\)/ })).toBeDefined()
  await ui.input({ key: 'q', text: 'a1b2c3d' })
  expect(await ui.find({ type: 'Text', text: /\(1\)/ })).toBeDefined()
  await ui.unmount()
})

test('the media view lists movies and pages newest first, and a click opens the file', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 'v-media' })
  expect(await ui.find({ type: 'Text', text: /newest first \(2\)/ })).toBeDefined()
  await ui.press({ key: 'mo-Parser rewrite-C:\\out\\demo_walkthrough.mov' })
  expect(ran.some(a => a[0] === 'explorer.exe' && a[1] === 'C:\\out\\demo_walkthrough.mov')).toBe(true)
  await ui.unmount()
})

test('a quick note is kept, and goes to its session as a prompt or as a subsession request', async ($, on) => {
  const store: Record<string, unknown> = {}
  await start($, on, store)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

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
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  // Parser edge cases is Parser rewrite's child: a row under the parent, closed card or not
  expect(await ui.find({ key: 'k-Parser rewrite>Parser edge cases' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /still waiting · 3 d/ })).toBeDefined()
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
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /^Here$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /◉ here/ })).toBeDefined()
  expect(await ui.find({ key: 't-@Parser rewrite' })).toBeDefined()
  await ui.unmount()
})

test('a board in a session it does not know shows no Here', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await ui.find({ type: 'Text', text: /◉ here/ })).toBeUndefined()
  await ui.unmount()
})

test('an open card lists related sessions, and one opens on its own', async ($, on) => {
  await start($, on)
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })

  await ui.press({ key: 't-Parser rewrite' })
  // Parser edge cases is its child; Docs audit wrote the same file
  await ui.press({ key: 'tab-Parser rewrite-related' })
  await ui.press({ key: 'r-Parser rewrite-Parser edge cases' })
  expect(await ui.find({ type: 'Text', text: /back to the board/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^still waiting/ })).toBeDefined()
  await ui.unmount()
})
