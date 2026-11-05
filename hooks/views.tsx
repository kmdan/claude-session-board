// The board's sections and its views: board (by state or by project), search
// results, graph, media, todos, one session in focus.
import type { Media, Sess } from '../types'
import { ago, byRecent, dueBucket, isWorking, layoutGraph, matches, projectColor, projectLabel } from './board'
import type { GraphSpot } from './board'
import type { Cards } from './cards'
import { addTodo } from './actions'
import { ACCENT, BORDER, chipOf, DOT, HERE, READY, SEEN, stateWord, WORKING } from './draw'
import type { Drawing, TodoRow } from './draw'
import { background, INBOX } from './state'
import type { $T } from './state'

// how many cards a section shows before "Show more"
const SHOWN = 5

// the graph view's layout, worked out once per index, project chip and pane width
let graphMemo: { key: string; ids: string[]; spots: GraphSpot[] } = { key: '', ids: [], spots: [] }

// "Show 9 more" when that is all of them, "Show 10 more of 23" when more stay folded
const moreWord = (total: number, limit: number) => {
  const rest = total - limit
  return rest > 10 ? `Show 10 more of ${rest}` : `Show ${rest} more`
}

type SectionOpts = { note?: string; byTime?: boolean; project?: string; foldable?: boolean }
type Fold = { key: string; title: string; list: Sess[]; asRows?: boolean }

export function makeViews($: $T, d: Drawing, cards: Cards) {
  const { Box, Text, Button, Input, Link } = d.table
  const {
    bodyColumns, ix, ui, notes, fullText, now, setUi, all, byId, byCli, kidsOf, here, find, st,
    isUnseen, isUnanswered, inChip, inProject, listed, groups, topLevel, allTodos,
  } = d
  const { mediaRow, todoRow, card, row, subLines } = cards

  // A section: its heading (a coloured mark, the name, the count and a quiet
  // note), then cards, or lines in one soft card. `byTime` lists strictly newest
  // first (the by-project order); `project` set, the lines leave out the tag.
  const section = (key: string, title: string, items: Sess[], color?: string, withState = false, asRows = false, opts: SectionOpts = {}) => {
    // a subsession whose parent is in this same list shows nested under it, not twice
    const top = topLevel(items)
    // newest first by the family's latest move: a main session whose subsession just moved comes up
    const famAt = (s: Sess) => Math.max(s.last, kidsOf.get(s.id)?.[0]?.last ?? 0)
    const list = opts.byTime ? [...top].sort((a, b) => famAt(b) - famAt(a)) : top
    if (list.length === 0) return null
    const limit = ui.limits[key] ?? (asRows ? 8 : SHOWN)
    const more = list.length > limit && (
      <Box marginTop={asRows ? 0 : 0}>
        <Button key={`more-${key}`} variant="secondary" label={moreWord(list.length, limit)}
          onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, [key]: limit + 10 } }))} />
      </Box>
    )
    return (
      <Box key={`s-${key}`} flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={color ?? SEEN}>▎</Text>
          <Text>
            <Text bold color={color}>{title}</Text>
            <Text dimColor> {list.length}{opts.note ? ` · ${opts.note}` : ''}</Text>
          </Text>
          {opts.foldable && (
            <Button key={`hide-${key}`} plain onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, [key]: false } }))}>
              <Text dimColor>fold ▴</Text>
            </Button>
          )}
        </Box>
        {/* quiet sessions: one soft card per section holding a line each (an
            unfolded one opens as its own card in place) */}
        {asRows
          ? (
            <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
              {list.slice(0, limit).map(s => (
                <Box key={`fam-${s.id}`} flexDirection="column">
                  {row(s, opts.project === undefined)}
                  {subLines(s)}
                </Box>
              ))}
              {more}
            </Box>
          )
          : list.slice(0, limit).map(s => card(s, withState))}
        {!asRows && more}
      </Box>
    )
  }

  // Quiet sections fold into one row of buttons; an unfolded one is drawn below
  // that row as a section, with "fold ▴" to put it back.
  const foldRow = (folds: Fold[]) => {
    const present = folds.filter(f => f.list.length > 0)
    if (present.length === 0) return null
    return (
      <Box flexDirection="column">
        {present.some(f => !ui.shown[f.key]) && (
          <Box flexDirection="row" flexWrap="wrap" gap={1} marginBottom={1}>
            {present.filter(f => !ui.shown[f.key]).map(f => (
              <Button key={`show-${f.key}`} variant="secondary" label={`${f.title} · ${f.list.length} ▾`}
                onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, [f.key]: true } }))} />
            ))}
          </Box>
        )}
        {present.filter(f => ui.shown[f.key]).map(f => section(f.key, f.title, f.list, undefined, false, f.asRows ?? true, { foldable: true }))}
      </Box>
    )
  }

  // The graph: the last two weeks' open sessions as dots, related ones close
  // together (the same evidence as a card's Related tab: same thread, same
  // files, same rare words). A dot's colour is its project, or its state where
  // that matters (brown working, green not answered yet, as the board's dots;
  // drawn outside the button, which colours its own text). A click
  // opens the session's card; hovering shows its title in full.
  const graphView = () => {
    const cols = Math.max(30, bodyColumns ?? 60) - 2
    const pool = inProject
      .filter(s => !s.archived && !['done', 'parked'].includes(st(s)) && now - s.last < 14 * 86_400_000)
      .sort(byRecent).slice(0, 60)
    const rows = Math.min(32, Math.max(12, Math.round(pool.length * 0.6)))
    const key = `${ix.at}|${ui.project}|${cols}|${pool.map(s => s.id).join(',')}`
    if (graphMemo.key !== key) {
      const at = new Map(pool.map((s, i) => [s.id, i]))
      const edges: [number, number, number][] = []
      pool.forEach((s, i) => {
        for (const r of find(s, 8)) {
          const j = at.get(r.s.id)
          if (j !== undefined && j > i) edges.push([i, j, r.score])
        }
      })
      graphMemo = { key, ids: pool.map(s => s.id), spots: layoutGraph(pool.map(s => s.title), edges, cols, rows) }
    }
    if (pool.length === 0) return <Text dimColor>No open sessions in the last two weeks{ui.project ? ' in this project' : ''}.</Text>
    return (
      <Box flexDirection="column">
        <Text dimColor wrap="wrap">{pool.length} open sessions of the last two weeks. Close together = related: the same thread, files or words. Click one to open its card.</Text>
        <Box key="graph" position="relative" height={rows} width={cols} marginTop={1}>
          {graphMemo.spots.map(sp => {
            const s = byId.get(graphMemo.ids[sp.i])
            if (!s) return null
            const working = isWorking(s, now)
            const quiet = !working && !['need', 'waiting'].includes(st(s))
            const nameColor = here && s.id === here.id ? HERE : working ? WORKING : isUnanswered(s) ? READY : undefined
            return (
              <Box key={`gn-${s.id}`} position="absolute" top={sp.y} left={sp.x} flexDirection="row">
                {/* the dot beside the button: the desktop draws a button's text in its own colour */}
                <Text color={nameColor ?? projectColor(s.project)}>{nameColor ? '◉' : '●'}</Text>
                <Button key={`g-${s.id}`} plain
                  onPress={() => setUi(u => ({ ...u, view: 'focus', focus: s.id, open: '', tab: '', from: 'graph' }))}>
                  <Text color={nameColor} dimColor={!nameColor && quiet} bold={isUnseen(s)}> {sp.label || '·'}</Text>
                </Button>
                <Box position="absolute" top={1} left={sp.x > cols - 34 ? -30 : 0} display="none" hover={{ display: 'flex' }}
                  flexDirection="column" borderStyle="round" borderColor={BORDER} backgroundColor="#1e1e22" paddingX={1} width={32}>
                  <Text bold wrap="wrap">{s.title}</Text>
                  <Text dimColor wrap="truncate-end">{projectLabel(s.project)} · {working ? 'working' : stateWord[st(s)]} · {ago(now - s.last)}</Text>
                </Box>
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={2} marginTop={1}>
          <Text dimColor>● colour = project</Text>
          <Text color={WORKING}>◉ working</Text>
          <Text color={READY}>◉ not answered yet</Text>
          <Text color={HERE}>◉ here</Text>
        </Box>
      </Box>
    )
  }

  // By project: one section per project, the project last edited first, each
  // session a line, newest first. Done and parked stay folded at the end.
  const byProject = () => {
    const byChip = new Map<string, Sess[]>()
    // `listed` is newest first already, so each project's first is its latest
    for (const s of listed) {
      if ((here && s.id === here.id) || ['done', 'parked'].includes(st(s))) continue
      const p = chipOf(s.project)
      const list = byChip.get(p)
      if (list) list.push(s)
      else byChip.set(p, [s])
    }
    const order = [...byChip.entries()].sort((a, b) => b[1][0].last - a[1][0].last)
    return (
      <Box flexDirection="column">
        {order.map(([p, list]) => section(`proj-${p}`, projectLabel(p), list, projectColor(p), false, true,
          { note: `active ${ago(now - list[0].last)} ago`, byTime: true, project: p }))}
        {foldRow([
          { key: 'done', title: 'Done', list: groups.done },
          { key: 'parked', title: 'Parking lot', list: groups.parked },
        ])}
      </Box>
    )
  }

  const boardView = () => {
    // A subsession you are in is drawn as the board draws its family: its main
    // session's whole card, with the rail of siblings (asking, working, the
    // rest) and your subsession as a card on it, first.
    const hereParent = here?.parent ? byId.get(here.parent) : undefined
    return (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>{ix.isLoading ? 'Reading your sessions…' : ix.note}</Text>}
        {here && (
          <Box key="s-here" flexDirection="column" marginBottom={1}>
            <Text dimColor>HERE</Text>
            {card(hereParent ?? here, true, 0, `@${(hereParent ?? here).id}`)}
          </Box>
        )}
        {/* two orders of the same sessions: by what they need of you, or by project */}
        {/* drawn as the view buttons are: a plain button's text styling is not shown on the desktop */}
        <Box flexDirection="row" gap={1} marginBottom={1} alignItems="center">
          <Text dimColor>Order</Text>
          <Button key="by-state" variant={ui.boardBy !== 'project' ? 'primary' : 'secondary'} label="By state"
            onPress={() => setUi(u => ({ ...u, boardBy: 'state' }))} />
          <Button key="by-project" variant={ui.boardBy === 'project' ? 'primary' : 'secondary'} label="By project"
            onPress={() => setUi(u => ({ ...u, boardBy: 'project' }))} />
        </Box>
        {ui.boardBy === 'project' ? byProject() : (
          <Box flexDirection="column">
            {/* cards where you act; one quiet line each for the rest */}
            {section('need', 'Needs you', groups.need, ACCENT)}
            {foldRow([{ key: 'waiting', title: 'Still waiting on you, 1-7 days', list: groups.waiting, asRows: false }])}
            {section('working', 'Working', groups.working, WORKING, false, true)}
            {section('today', 'Today', groups.today, undefined, false, true, { note: 'not touched by you yet' })}
            {section('week', 'Earlier this week', groups.week, undefined, false, true)}
            {foldRow([
              { key: 'good', title: 'Good enough', list: groups.good, asRows: false },
              { key: 'earlier', title: 'Earlier this month', list: groups.earlier },
              { key: 'done', title: 'Done', list: groups.done },
              { key: 'parked', title: 'Parking lot', list: groups.parked },
            ])}
          </Box>
        )}
      </Box>
    )
  }

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
  const todosView = () => {
    const labelsInUse = [...new Set(allTodos.filter(r => !r.n.done).flatMap(r => r.n.labels ?? []))].sort()
    const shown = allTodos.filter(r =>
      (!ui.label || (r.n.labels ?? []).includes(ui.label))
      && (!ui.project || r.owner === INBOX || inChip(r.s)))
    const open = shown.filter(r => !r.n.done)
    const done = shown.filter(r => r.n.done)
    const byDue = (a: TodoRow, b: TodoRow) => (a.n.due ?? '9999').localeCompare(b.n.due ?? '9999') || a.n.at - b.n.at
    const group = (key: string, title: string, rows: TodoRow[], color?: string) => rows.length === 0 ? null : (
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
        <Button key="back" plain onPress={() => setUi(u => ({ ...u, view: u.from === 'graph' ? 'graph' : 'board', focus: '', from: undefined }))}>
          <Text dimColor>← back to the {ui.from === 'graph' ? 'graph' : 'board'}</Text>
        </Button>
        {card(s, true)}
      </Box>
    )
  }

  // What the search found: titles, files and commits at once; what was said in
  // conversations once the search was run for this query (Enter).
  const foundView = () => {
    const found = inProject.filter(s => matches(s, ui.query)).sort(byRecent)
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
      <Box flexDirection="column">
        {section('found', `Found for "${ui.query}"`, found, undefined, true)}
        {found.length === 0 && <Text dimColor>No title, file or commit matches, archived and parked sessions included.</Text>}
        {saidView()}
      </Box>
    )
  }

  // which view the tabs and the search ask for
  return () => (ui.view === 'media' ? mediaView()
    : ui.view === 'graph' ? graphView()
    : ui.view === 'todos' ? todosView()
    : ui.view === 'focus' ? focusView()
    : ui.query !== '' ? foundView()
    : boardView())
}
