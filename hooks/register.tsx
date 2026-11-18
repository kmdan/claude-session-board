// The mod's hooks and the board's frame: its counts, search box and tabs. What
// goes inside is in views.tsx and cards.tsx; draw.ts works out what a drawing
// reads, state.ts and indexing.ts keep the sessions, actions.ts is what buttons do.
import type { Register } from 'claude-code'

import { projectColor, projectLabel } from './board'

// lines removed, as the app's Changes box shows them
const REMOVED = '#d06a6a'
import { openSession, savePaste, stepTrail } from './actions'
import { makeCards } from './cards'
import { PULSE_WORKING, READY, readDrawing, short } from './draw'
import { openBoard, quickTick, refresh, refreshHereInfo, searchText, tick } from './indexing'
import { background, flushUse, live, logUse, PANE } from './state'
import { makeViews } from './views'

export const register: Register = on => {
  // Open by default in every session; /board and the button above the prompt
  // reopen it once closed.
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'board', description: 'Open the session board' })
    $.clock.every(20_000, () => {
      background($, quickTick($))
      // the top line's branch and changes follow a commit made with no click on the board
      if (live.isShown && live.hereInfoCwd) background($, refreshHereInfo($, live.hereInfoCwd))
    })
    $.clock.every(120_000, () => {
      background($, tick($))
    })
    // the usage log goes to disk once a minute (and when you open a session)
    $.clock.every(60_000, () => {
      background($, flushUse($))
    })
    // the quick part (snapshot, pane) is awaited; the indexing runs behind it.
    // A window that detaches just then can still make opening fail ("no surface
    // is attached"): quietly, session.attach opens it.
    await openBoard($).catch(err => {
      if (!String(err).includes('no-surface')) $.ui.log(`session-board: ${String(err)}`, { to: 'debug' })
    })
    return started
  })

  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (!live.isShown) background($, openBoard($))
    return attached
  })

  on('command.run', { command: 'board' }, async $ => {
    logUse('board-open', { via: 'command' })
    await openBoard($, true)
    return { text: 'Session board opened.' }
  })

  on('ui.close', async ($, e, next) => {
    if (e.id === PANE) {
      live.isShown = false
      // your own close (its mark, Escape): not opened again unasked in this session
      if (e.origin?.kind === 'person') live.wantsBoard = false
    }
    return next(e)
  })

  // The app's own top-right toolbar takes no plugin buttons (there is no API
  // for it); the band above the prompt is the nearest place. The button is
  // always there: the app can hide the board without telling the plugin.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band is drawn when the session is shown. A session that started (or
    // reloaded) with no window has no board yet, and switching to it in the app
    // sends no other sign: it opens here, unless you closed it in this session.
    if (!live.isShown && live.wantsBoard && Date.now() - live.lastOpenTry > 10_000) {
      live.lastOpenTry = Date.now()
      background($, openBoard($))
    }
    if (e.props.hasSurvey) return next(e)
    const { Box, Button } = $.ui.resolve(e)
    return (
      <Box>
        <Button key="open-board" plain onPress={() => {
          logUse('board-open', { via: 'band-button' })
          background($, openBoard($, true))
        }}>▦ Sessions</Button>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const d = await readDrawing($, e)
    const { Box, Text, Button, Input } = d.table
    const {
      Svg, narrow, ix, ui, setUi, byId, here, trail, backTo, recentTrail, chips,
    } = d
    const view = makeViews($, d, makeCards($, d))
    // The top line: the session you are in, as the app's Environment box has it:
    // project, branch (ahead/behind), its changes (new files counted), context fill,
    // and its folder. Numbers for another folder (a moment after switching) wait.
    const info = here && d.hereInfo.cwd === here.cwd ? d.hereInfo : undefined
    const num = (n: number) => n.toLocaleString('en-US')
    // the folder's last parts, so a long path never wraps the top
    const parts = (here?.cwd ?? '').split(/[\\/]/).filter(Boolean)
    const folder = parts.length > 3 ? `…\\${parts.slice(-(narrow ? 2 : 3)).join('\\')}` : (here?.cwd ?? '')

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* in a narrow pane the buttons go under the session's line, not squeeze it into a column */}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          {here ? (
            <Box flexDirection="column" flexShrink={1} minWidth={0}>
              <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
                <Text bold color={projectColor(here.project)}>● {projectLabel(here.project)}</Text>
                {info?.branch && (
                  <Text>⎇ {info.branch}{info.ahead ? ` ↑${info.ahead}` : ''}{info.behind ? ` ↓${info.behind}` : ''}</Text>
                )}
                {info?.branch !== undefined && ((info.plus ?? 0) + (info.minus ?? 0) > 0
                  ? <Text><Text color={READY}>+{num(info.plus ?? 0)}</Text> <Text color={REMOVED}>−{num(info.minus ?? 0)}</Text></Text>
                  : <Text dimColor>no changes</Text>)}
                {info?.context !== undefined && <Text dimColor>context {info.context}%</Text>}
              </Box>
              <Text dimColor wrap="truncate-end">{folder}</Text>
            </Box>
          ) : <Text bold>Sessions</Text>}
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
            {/* the next session waiting for you, one click: the first not looked at since it moved */}
            {d.next && (
              <Button key="next" variant="primary" label={`Next ↗ ${short(d.next.title, narrow ? 12 : 22)}`}
                onPress={() => background($, openSession($, d.next!.id, 'next'))} />
            )}
            {/* back and forward through the sessions you were in */}
            {backTo && (
              <Button key="trail-back" variant="secondary" onPress={() => background($, stepTrail($, 1, here?.id, recentTrail))}
                label={`‹ ${short(byId.get(backTo ?? '')?.title ?? '', narrow ? 14 : 22)}`} />
            )}
            {trail && trail.pos > 0 && (
              <Button key="trail-forward" variant="secondary" label="›" onPress={() => background($, stepTrail($, -1, here?.id, recentTrail))} />
            )}
            {ix.isLoading && Svg && <Svg source={PULSE_WORKING} alt="indexing" width={12} height={12} isInteractive />}
            <Button key="refresh" variant="secondary" label={ix.isLoading ? 'Indexing…' : '↻ Refresh'} onPress={() => {
              logUse('refresh')
              background($, refresh($))
            }} />
          </Box>
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center">
          <Box flexGrow={1} flexShrink={1}>
            <Input
              // a new key draws a fresh, empty box: how ✕ clears a field the board does not bind
              key={ui.cleared ? `q${ui.cleared}` : 'q'}
              placeholder="Find a session… Enter opens the best match"
              // not bound to ui.query: the field keeps what is typed itself, and the
              // board redraws once typing pauses (150 ms), not on every letter. An
              // emptied box clears at once: it must never wait on the timer (in the
              // app the search stayed stuck until Enter)
              onInput={v => {
                live.typedQuery = v
                if (v.trim() === '') {
                  setUi(u => (u.query === '' ? u : { ...u, query: '' }))
                  return
                }
                $.clock.after(150, () => {
                  if (live.typedQuery === v) setUi(u => (u.query === v ? u : { ...u, query: v }))
                })
              }}
              // Enter: the best match opens (a quick switcher); with none, what was said is searched
              onSubmit={v => {
                live.typedQuery = v
                const top = d.rankFound(v)[0]
                logUse('search', { q: v.slice(0, 60), opened: !!top })
                if (top) {
                  background($, openSession($, top.id, 'search-enter'))
                  return
                }
                setUi(u => ({ ...u, query: v, view: 'board' }))
                background($, searchText($, v))
              }}
            />
          </Box>
          {ui.query !== '' && (
            <Button key="q-clear" plain onPress={() => {
              live.typedQuery = ''
              setUi(u => ({ ...u, query: '', cleared: (u.cleared ?? 0) + 1 }))
            }}>
              <Text dimColor>✕ clear</Text>
            </Button>
          )}
          {/* the paste box opens on demand: it is used now and then, not all day */}
          <Button key="paste-open" variant={ui.shown.paste ? 'primary' : 'secondary'} label="Paste log"
            onPress={() => setUi(u => ({ ...u, shown: { ...u.shown, paste: !u.shown.paste } }))} />
        </Box>
        {/* paste a log or a command's output: Enter saves it as an .md file and puts its
            path in this session's prompt (a new key draws the box anew, empty), and it folds away */}
        {ui.shown.paste && (
          <Box marginTop={1}>
            <Input
              key={`paste-${ui.pasted ?? 0}`}
              rows={3}
              autoFocus
              placeholder="Paste a log or command output. Enter: saved as an .md file, its path put in your prompt"
              submitLabel="save to prompt"
              onSubmit={v => {
                if (!v.trim()) return
                background($, savePaste($, v))
                setUi(u => ({ ...u, pasted: (u.pasted ?? 0) + 1, shown: { ...u.shown, paste: false } }))
              }}
            />
          </Box>
        )}
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginY={1}>
          <Button key="v-board" variant={ui.view === 'board' || ui.view === 'focus' ? 'primary' : 'secondary'} label="Board" onPress={() => setUi(u => ({ ...u, view: 'board' }))} />
          {/* only while there is something to tidy (a hidden one comes back by search, or Unhide there) */}
          {(d.tidy.length > 0 || ui.view === 'tidy') && (
            <Button key="v-tidy" variant={ui.view === 'tidy' ? 'primary' : 'secondary'} label={`Tidy up · ${d.tidy.length}`}
              onPress={() => setUi(u => ({ ...u, view: 'tidy' }))} />
          )}
          <Text dimColor>|</Text>
          <Button key="p-all" variant={ui.project === '' ? 'primary' : 'secondary'} label="All" onPress={() => setUi(u => ({ ...u, project: '' }))} />
          {chips.map(p => (
            <Button key={`p-${p}`} variant={ui.project === p ? 'primary' : 'secondary'} label={projectLabel(p)}
              onPress={() => setUi(u => ({ ...u, project: u.project === p ? '' : p }))} />
          ))}
        </Box>

        {view()}
        <Text dimColor wrap="truncate-end">{ix.note}</Text>
      </Box>
    )
  })
}
