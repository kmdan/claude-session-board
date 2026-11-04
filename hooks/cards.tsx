// A session as it is drawn: its card, its quiet line, the rows on its rail.
import type { Media, Note, Sess, Ui } from '../types'
import { ago, baseName, dueBucket, dueWord, isWorking, overlaps, projectColor, projectLabel } from './board'
import {
  addTodo, editNotes, mark, markAnswered, markSeen, openFile, openSession, reveal, sendNote, startFromTodo, toggleDone,
} from './actions'
import { ACCENT, chipOf, DOT, HERE, PULSE_WORKING, READY, stateWord, WORKING } from './draw'
import type { Drawing } from './draw'
import { background, INBOX, live } from './state'
import type { $T } from './state'

const KIND_MARK: Record<Media['k'], string> = { movie: '▶', image: '▣', page: '◧', file: '·' }

export function makeCards($: $T, d: Drawing) {
  const { Box, Text, Button, Input, Link } = d.table
  const {
    Svg, narrow, ui, marks, notes, opening, answered, now, setUi, all, byId, kidsOf, here, find, chat, st,
    isUnseen, isUnanswered, isFresh, hasReported, asksYou, isPageOpen, openPages, borderOf,
  } = d

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

  // A review page's questions, listed: its title, open page, mark answered,
  // then each question on a line. Answering is on the page (the in-card answer
  // form was taken out on request). Answered pages fold to a line each.
  const questionsBlock = (s: Sess, path: string) => {
    const open = openPages(s).sort((a, b) => b.t - a.t)
    const done = s.questions.filter(p => !isPageOpen(p)).sort((a, b) => b.t - a.t)
    const page = open[0]
    return (
      <Box flexDirection="column">
        {page && (() => {
          const pi = s.questions.indexOf(page)
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
              {/* what it asks, one line each: answering happens on the page itself */}
              {page.qs.map(q => (
                <Text key={`qq-${path}-${pi}-${q.q}`} dimColor wrap="truncate-end">
                  {q.title}{q.to !== 'me' ? `  [for ${q.to}]` : ''}
                </Text>
              ))}
              {open.length > 1 && <Text dimColor>{open.length - 1} older question page{open.length > 2 ? 's' : ''} wait after this one.</Text>}
            </Box>
          )
        })()}
        {done.slice(0, 3).map(p => (
          <Box key={`qd-${path}-${s.questions.indexOf(p)}`} flexDirection="row" gap={1}>
            <Text dimColor>✓ {p.title} · answered {ago(now - (answered[p.p]?.at ?? chat.get(p.title) ?? now))} ago</Text>
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
    // under Here, the subsession you are in is a card on its main session's rail, first
    const isHereKid = (c: Sess) => path.startsWith('@') && !!here && c.id === here.id
    const asCard = (c: Sess) => asksYou(c) || isHereKid(c)
    const asking = [...kids.filter(isHereKid), ...lively.filter(c => asksYou(c) && !isHereKid(c))]
    const rest = lively.filter(c => !asCard(c))
    const quietKids = kids.filter(c => isQuiet(c) && !isHereKid(c))
    const visible = allShown ? [...asking, ...rest, ...quietKids] : [...asking, ...rest.slice(0, 4)]
    const folded = kids.length - visible.length
    const quietCount = quietKids.length
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={1}>
        {visible.map((c, i) => {
          const cPath = `${path}>${c.id}`
          const isLast = i === visible.length - 1 && folded === 0
          if (ui.open === cPath || asCard(c)) {
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
            <Box key={`kr-${cPath}`} flexDirection="row" alignItems="center" minWidth={0} overflow="hidden">
              <Text dimColor>{isLast ? '└ ' : '├ '}</Text>
              {/* drawn beside the button: a button holds only text */}
              {working && Svg
                ? <Svg source={PULSE_WORKING} alt="working now" width={10} height={10} isInteractive />
                : reported
                    ? <Text dimColor>↩</Text>
                    : <Text color={isUnanswered(c) ? READY : DOT[cs]}>●</Text>}
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
    // The grey line says only what the dot, border and corner do not: a mark you
    // set, todos, what its subsessions do, then what the session is about (the
    // app's own one-line status). Its age sits in the corner, as on a line.
    const meta: string[] = []
    if (withState && ['good', 'done', 'parked'].includes(state)) meta.push(stateWord[state])
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
    const about = s.detail.trim()
    if (about) meta.push(about)
    // a subsession's way up: a button to its parent's card, drawn under the meta line
    const parent = s.parent && depth === 0 ? byId.get(s.parent) : undefined
    const clash = isOpen ? overlaps(s, all, marks, now) : []
    const rel = isOpen ? find(s, 5) : []
    const allNotes = notes[s.id] ?? []
    // one detail tab at a time, five items at most: the open card stays short
    const tabs: { key: Ui['tab']; label: string }[] = []
    if (s.questions.length) tabs.push({ key: 'questions', label: askCount ? `? Questions ${askCount}` : 'Questions ✓' })
    if (s.media.length + s.artifacts.length) tabs.push({ key: 'media', label: `Media ${s.media.length + s.artifacts.length}` })
    if (s.fileCount) tabs.push({ key: 'files', label: `Files ${s.fileCount}` })
    if (rel.length) tabs.push({ key: 'related', label: `Related ${rel.length}${clash.length ? ' ⚠' : ''}` })
    const openCount = allNotes.filter(n => !n.done).length
    tabs.push({ key: 'notes', label: allNotes.length ? `Todos ${openCount}` : '+ Todo' })
    const tab = !isOpen || ui.tab === 'none' ? '' : ui.tab
    const toggleTab = (k: Ui['tab']) => setUi(u => ({ ...u, tab: tab === k ? 'none' : k }))
    const toggleCard = () => {
      const isOpening = ui.open !== path
      if (isOpening && isFresh(s)) live.keptOnTop.add(s.id)
      else live.keptOnTop.delete(s.id)
      setUi(u => ({ ...u, open: u.open === path ? '' : path, tab: '' }))
      if (isUnseen(s)) background($, markSeen($, s.id))
    }
    const showNeeds = (isOpen || state === 'need') && s.needs !== ''
    // one dot, a traffic light: brown pulse working, still green done and not seen, then grey
    const dots = [
      isWorking(s, now)
        ? (Svg
          ? <Svg key={`dw-${path}`} source={PULSE_WORKING} alt="working now" width={12} height={12} isInteractive />
          : <Text key={`dw-${path}`} color={WORKING}>●</Text>)
        : <Text key={`ds-${path}`} color={isUnanswered(s) ? READY : DOT[state]}>●</Text>,
    ]
    const corner = (
      <Box flexDirection="row" gap={1} flexShrink={0}>
        <Text wrap="truncate-end">
          {here && s.id === here.id && <Text color={HERE}>◉ here  </Text>}
          {/* a nested card in its main session's project says nothing new with the tag */}
          {!(depth > 0 && s.parent && byId.get(s.parent)?.project === s.project)
            && <Text color={projectColor(s.project)}>● {narrow && projectLabel(s.project).length > 12 ? `${projectLabel(s.project).slice(0, 11)}…` : projectLabel(s.project)}</Text>}
        </Text>
        <Text dimColor>{ago(now - s.last)}</Text>
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
        <Box flexDirection="row" justifyContent="space-between" gap={1} minWidth={0}>
          {/* the title gives way in a narrow pane (cut with "…"); the corner keeps its place */}
          <Box flexDirection="row" gap={1} flexShrink={1} minWidth={0} overflow="hidden" alignItems="center">
            {/* the fold mark, as on a line: ▾ folds an open card back, ▸ unfolds it */}
            <Button key={`f-${path}`} plain onPress={toggleCard}>{isOpen ? '▾' : '▸'}</Button>
            {dots}
            <Button key={`t-${path}`} plain onPress={toggleCard}>
              <Text bold>{s.title}</Text>
            </Button>
          </Box>
          {corner}
        </Box>
        {(askCount > 0 || meta.length > 0) && (
          <Button key={`tm-${path}`} plain onPress={toggleCard}>
            {askCount > 0 && <Text color={ACCENT}>? {askCount}</Text>}
            <Text dimColor>{askCount ? ` question${askCount > 1 ? 's' : ''}${meta.length ? ' · ' : ''}` : ''}{meta.join(' · ')}</Text>
          </Button>
        )}
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

  // By project, under a session's line: its subsessions that are live (asking
  // you, working, or moved in the last day), one short line each; the title
  // opens the subsession. The rest stay in the line's "+N".
  const subLines = (s: Sess) => {
    if (ui.open === s.id) return null
    const lines = (kidsOf.get(s.id) ?? []).filter(c => asksYou(c) || isWorking(c, now) || now - c.last < 86_400_000).slice(0, 4)
    return lines.map((c, i) => {
      const working = isWorking(c, now)
      const word = working ? 'working' : asksYou(c) ? 'asks you' : hasReported(c) ? 'reported' : ''
      return (
        <Box key={`sl-${s.id}>${c.id}`} flexDirection="row" alignItems="center" marginLeft={2} minWidth={0} overflow="hidden">
          <Text dimColor>{i === lines.length - 1 ? '└ ' : '├ '}</Text>
          {working && Svg
            ? <Svg source={PULSE_WORKING} alt="working now" width={10} height={10} isInteractive />
            : <Text color={isUnanswered(c) ? READY : DOT[st(c)]}>●</Text>}
          <Button key={`sl-${c.id}`} plain onPress={() => background($, openSession($, c.id))}>
            <Text> {c.title}</Text>
          </Button>
          <Text color={asksYou(c) ? ACCENT : undefined} dimColor={!asksYou(c)}> {word ? `${word} · ` : ''}{ago(now - c.last)}</Text>
        </Box>
      )
    })
  }

  // One quiet line for a session you need not act on (working, moved today,
  // earlier): its state dot, its title, project and age. A click unfolds it
  // into its full card in place. Cards stay for what waits on you.
  const row = (s: Sess, withTag = true) => {
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
          : <Text color={isUnanswered(s) ? READY : DOT[cs]}>●</Text>}
        {/* ▸ unfolds the line into its card; the title itself opens the session */}
        <Button key={`u-${s.id}`} plain onPress={unfold}>▸</Button>
        <Box flexGrow={1} flexShrink={1}>
          <Button key={`t-${s.id}`} plain onPress={() => background($, openSession($, s.id))}>
            <Text bold={isUnseen(s)}>{s.title}</Text>
            {kids > 0 && <Text dimColor>  +{kids}{reports ? ` ↩${reports}` : ''}</Text>}
          </Button>
        </Box>
        {/* a one-off scratch folder shows as its chip: the dated name wrapped the line */}
        {withTag && <Text color={projectColor(s.project)} wrap="truncate-end">{projectLabel(chipOf(s.project))}</Text>}
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

  return { mediaRow, todoRow, card, row, subLines }
}

export type Cards = ReturnType<typeof makeCards>
