// The board's sections and its views: the board (by project, with Waiting for
// you and Here on top), search results, Tidy up, one session in focus.
import type { Sess } from '../types'
import { ago, projectColor, projectLabel } from './board'
import type { Cards } from './cards'
import { archiveMany, hideMany, openSession } from './actions'
import { ACCENT, BORDER, chipOf, DOT, READY, SEEN, short, stateWord } from './draw'
import type { Drawing } from './draw'
import { background, logUse, setPref } from './state'
import { searchText } from './indexing'
import type { $T } from './state'

// how many cards a section shows before "Show more"
const SHOWN = 5

// "Show 9 more" when that is all of them, "Show 10 more of 23" when more stay folded
const moreWord = (total: number, limit: number) => {
  const rest = total - limit
  return rest > 10 ? `Show 10 more of ${rest}` : `Show ${rest} more`
}

// `fill`: the only list on the board (search results, one project): it shows as
// many as the pane has room for, not the few a section among others shows
type SectionOpts = { note?: string; byTime?: boolean; project?: string; foldable?: boolean; fill?: boolean }

// the rows above the lists (counts, search, tabs, heading) and what a card takes
// with its gap (border, title, grey line, a needs line now and then)
const TOP_ROWS = 12
const CARD_ROWS = 5
type Fold = { key: string; title: string; list: Sess[]; asRows?: boolean }

export function makeViews($: $T, d: Drawing, cards: Cards) {
  const { Box, Text, Button } = d.table
  const {
    bodyRows, ix, ui, fullText, now, setUi, all, byId, byCli, kidsOf, here, st,
    inChip, inProject, listed, groups, topLevel,
  } = d
  const { card, row, subLines } = cards

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
    const room = bodyRows - TOP_ROWS
    const limit = ui.limits[key] ?? (asRows
      ? (opts.fill ? Math.max(8, room) : 8)
      : (opts.fill ? Math.max(SHOWN, Math.floor(room / CARD_ROWS)) : SHOWN))
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

  // By project: one section per project, the project last edited first, each
  // session a line, newest first. Done and parked stay folded at the end.
  const byProject = () => {
    const byChip = new Map<string, Sess[]>()
    // `listed` is newest first already, so each project's first is its latest
    for (const s of listed) {
      if (['done', 'parked'].includes(st(s)) && !(here && s.id === here.id)) continue
      const p = chipOf(s.project)
      const list = byChip.get(p)
      if (list) list.push(s)
      else byChip.set(p, [s])
    }
    // the project of the session you are in comes first; the rest by their latest move.
    // Inside a project the order stays by time: only the project moves up.
    const hereChip = here ? chipOf((d.hereChain[0] ?? here).project) : undefined
    const order = [...byChip.entries()]
      .sort((a, b) => Number(b[0] === hereChip) - Number(a[0] === hereChip) || b[1][0].last - a[1][0].last)
    return (
      <Box flexDirection="column">
        {order.map(([p, list]) => section(`proj-${p}`, projectLabel(p), list, projectColor(p), false, true,
          { note: `active ${ago(now - list[0].last)} ago`, byTime: true, project: p, fill: order.length === 1 }))}
        {foldRow([
          { key: 'done', title: 'Done', list: groups.done },
          { key: 'parked', title: 'Parking lot', list: groups.parked },
        ])}
      </Box>
    )
  }

  // Waiting for you, on top: one short line each (dot, title that opens it,
  // project, "asks you" or "new", age), newest first; five, then "N more".
  // One you already looked at stays while it still asks, quieter.
  const waitingStrip = () => {
    const { waiting, looked, waitsForYou, narrow } = d
    if (waiting.length === 0) return null
    const limit = ui.shown.waitingAll ? waiting.length : 5
    // folded by its ▾ / ▸ to the heading alone; Next ↗ on top still goes through them
    const isFolded = !!ui.shown.waitingFolded
    // kept in the store too: every session's board then opens the same way
    const toggle = () => {
      setUi(u => ({ ...u, shown: { ...u.shown, waitingFolded: !isFolded } }))
      background($, setPref($, 'waitingFolded', !isFolded))
    }
    return (
      <Box key="s-waiting" flexDirection="column" marginBottom={1}>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={READY}>▎</Text>
          <Button key="waiting-fold" plain onPress={toggle}>{isFolded ? '▸' : '▾'}</Button>
          <Text>
            <Text bold color={READY}>Waiting for you</Text>
            <Text dimColor> {waiting.length}</Text>
          </Text>
        </Box>
        {!isFolded && (
        <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
          {waiting.slice(0, limit).map(s => {
            const asks = waitsForYou(s)
            const isNew = !looked(s)
            const parent = s.parent ? byId.get(s.parent) : undefined
            return (
              <Box key={`wl-${s.id}`} flexDirection="row" gap={1} alignItems="center" minWidth={0} overflow="hidden">
                <Text color={isNew || asks ? READY : SEEN}>●</Text>
                <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                  <Button key={`wt-${s.id}`} plain onPress={() => background($, openSession($, s.id, 'waiting'))}>
                    {parent && <Text dimColor>{short(parent.title, narrow ? 12 : 24)} › </Text>}
                    <Text bold={isNew} wrap="truncate-end">{s.title}</Text>
                  </Button>
                </Box>
                <Box flexDirection="row" gap={1} flexShrink={0}>
                  <Text color={projectColor(s.project)}>{short(projectLabel(chipOf(s.project)), narrow ? 10 : 16)}</Text>
                  <Text color={asks ? ACCENT : READY}>{asks ? 'asks you' : 'new'}</Text>
                  <Text dimColor>{ago(now - s.last)}</Text>
                </Box>
              </Box>
            )
          })}
          {waiting.length > limit && (
            <Box>
              <Button key="more-waiting" plain onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, waitingAll: true } }))}>
                <Text dimColor>└ {waiting.length - limit} more</Text>
              </Button>
            </Box>
          )}
        </Box>
        )}
      </Box>
    )
  }

  const boardView = () => {
    // A subsession you are in is drawn with its whole family, from the top: its
    // main session's card, the way down to you as cards, everyone else as lines.
    const hereTop = d.hereChain[0]
    return (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>{ix.isLoading ? 'Reading your sessions…' : ix.note}</Text>}
        {waitingStrip()}
        {hereTop && (
          <Box key="s-here" flexDirection="column" marginBottom={1}>
            <Text dimColor>HERE</Text>
            {card(hereTop, true, 0, `@${hereTop.id}`)}
          </Box>
        )}
        {byProject()}
      </Box>
    )
  }

  // Tidy up: sessions quiet a long while, all ticked. Hide takes them off the
  // board at once, here only (no approvals; Unhide brings them back; search still
  // finds them). Archive asks the app, which may want each one approved and
  // removes a worktree: sessions in their own worktree are left out of it.
  const tidyView = () => {
    const { tidy, famLast, inWorktree, isTicked, marks, hiddenCount } = d
    const list = [...tidy].sort((a, b) => famLast(a) - famLast(b))
    const ticked = list.filter(isTicked)
    const archivable = ticked.filter(s => !inWorktree(s))
    const limit = ui.limits.tidy ?? Math.max(10, bodyRows - TOP_ROWS - 6)
    const pick = (ids: string[], on: boolean) =>
      setUi(u => ({ ...u, tidyPick: { ...u.tidyPick, ...Object.fromEntries(ids.map(id => [id, on])) } }))
    // a session's subsessions go with it: archiving takes them along, so hiding does too
    const withFamily = (ids: string[]): string[] => {
      const out = new Set<string>()
      const add = (id: string, depth: number) => {
        if (out.has(id) || depth > 8) return
        out.add(id)
        for (const c of kidsOf.get(id) ?? []) add(c.id, depth + 1)
      }
      for (const id of ids) add(id, 0)
      return [...out]
    }
    const unhide = hiddenCount > 0 && (
      <Button key="tidy-unhide" variant="secondary" label={`Unhide all ${hiddenCount}`}
        onPress={() => background($, hideMany($, d.hiddenIds, false))} />
    )
    if (list.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          <Text dimColor>Nothing to tidy: no session has been quiet a month{ui.project ? ' in this project' : ''}.</Text>
          {unhide}
        </Box>
      )
    }
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={SEEN}>▎</Text>
          <Text>
            <Text bold>Tidy up</Text>
            <Text dimColor> {list.length} · quiet a month, or done / parked and quiet 3 days</Text>
          </Text>
        </Box>
        <Text dimColor wrap="wrap">
          Hide takes them off this board only, at once, no approvals: Unhide brings them back and search still finds
          them. Archive asks the app instead (it may want each approved), and leaves out sessions in a worktree.
        </Text>
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginY={1}>
          <Button key="tidy-hide" variant="primary" label={`Hide ${ticked.length} from the board`}
            onPress={() => { if (ticked.length) background($, hideMany($, withFamily(ticked.map(s => s.id)), true)) }} />
          <Button key="tidy-archive" variant="secondary" label={`Archive ${archivable.length} in the app`}
            onPress={() => { if (archivable.length) background($, archiveMany($, archivable.map(s => s.id))) }} />
          {unhide}
          <Button key="tidy-all" variant="secondary" label="Tick all" onPress={() => pick(list.map(s => s.id), true)} />
          <Button key="tidy-none" variant="secondary" label="Untick all" onPress={() => pick(list.map(s => s.id), false)} />
          <Button key="tidy-back" variant="secondary" label="Back to the board" onPress={() => setUi(u => ({ ...u, view: 'board' }))} />
        </Box>
        <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
          {list.slice(0, limit).map(s => {
            const kids = (kidsOf.get(s.id) ?? []).length
            const m = marks[s.id]?.mark
            return (
              <Box key={`td-${s.id}`} flexDirection="row" gap={1} alignItems="center" minWidth={0} overflow="hidden">
                <Button key={`tk-${s.id}`} plain onPress={() => pick([s.id], !isTicked(s))}>{isTicked(s) ? '☑' : '☐'}</Button>
                <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
                  <Text wrap="truncate-end">{s.title}{kids ? <Text dimColor>  +{kids}</Text> : null}</Text>
                </Box>
                {inWorktree(s) && <Text color={ACCENT}>worktree</Text>}
                {m && <Text dimColor>{stateWord[m === 'working' ? 'working' : m]}</Text>}
                <Text color={projectColor(s.project)} wrap="truncate-end">{projectLabel(chipOf(s.project))}</Text>
                <Text dimColor>{ago(now - famLast(s))}</Text>
              </Box>
            )
          })}
          {list.length > limit && (
            <Box>
              <Button key="more-tidy" variant="secondary" label={moreWord(list.length, limit)}
                onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, tidy: limit + 10 } }))} />
            </Box>
          )}
        </Box>
      </Box>
    )
  }

  const focusView = () => {
    const s = byId.get(ui.focus)
    if (!s) return <Text dimColor>That session is not in the index.</Text>
    return (
      <Box flexDirection="column">
        <Button key="back" plain onPress={() => setUi(u => ({ ...u, view: 'board', focus: '', from: undefined }))}>
          <Text dimColor>← back to the board</Text>
        </Button>
        {card(s, true)}
      </Box>
    )
  }

  // What the search found: titles, files and commits at once; what was said in
  // conversations once the search was run for this query (Enter).
  const foundView = () => {
    const found = d.rankFound(ui.query)
    const foundIds = new Set(found.map(s => s.id))
    const said = fullText.query === ui.query.trim()
      // never name a variable `h` in this file: JSX compiles to calls of the global `h`
      ? fullText.hits.map(hit => ({ hit, s: byCli.get(hit.cli) })).filter(x => x.s && inChip(x.s))
      : []
    const saidView = () => {
      if (ui.query.trim().length < 3) return null
      if (fullText.query !== ui.query.trim()) {
        return (
          <Box marginTop={1}>
            <Button key="said-search" variant="secondary" label="Also search what was said"
              onPress={() => {
                logUse('search-said', { q: ui.query.slice(0, 60) })
                background($, searchText($, ui.query))
              }} />
          </Box>
        )
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
    // one line each, best match first, as many as the pane holds; Enter opens the first
    const limit = ui.limits.found ?? Math.max(8, bodyRows - TOP_ROWS)
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1} alignItems="center">
          <Text color={SEEN}>▎</Text>
          <Text>
            <Text bold>Found for "{ui.query}"</Text>
            <Text dimColor> {found.length}{found.length ? ' · Enter opens the first' : ''}</Text>
          </Text>
        </Box>
        {found.length > 0 && (
          <Box flexDirection="column" borderStyle="round" borderColor={BORDER} paddingX={1}>
            {found.slice(0, limit).map(s => row(s, true))}
            {found.length > limit && (
              <Box>
                <Button key="more-found" variant="secondary" label={moreWord(found.length, limit)}
                  onPress={() => setUi(u => ({ ...u, limits: { ...u.limits, found: limit + 10 } }))} />
              </Box>
            )}
          </Box>
        )}
        {found.length === 0 && <Text dimColor>No title, file or commit matches, archived and hidden sessions included.</Text>}
        {saidView()}
      </Box>
    )
  }

  // which view the tabs and the search ask for
  // (Todos, Media, Graph and the by-state order were taken out: the usage log saw them unused)
  return () => (ui.view === 'focus' ? focusView()
    : ui.view === 'tidy' ? tidyView()
    : ui.query !== '' ? foundView()
    : boardView())
}
