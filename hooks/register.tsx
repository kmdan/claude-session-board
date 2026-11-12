// The mod's hooks and the board's frame: its counts, search box and tabs. What
// goes inside is in views.tsx and cards.tsx; draw.ts works out what a drawing
// reads, state.ts and indexing.ts keep the sessions, actions.ts is what buttons do.
import type { Register } from 'claude-code'

import { projectLabel } from './board'
import { stepTrail } from './actions'
import { makeCards } from './cards'
import { ACCENT, PULSE_WORKING, READY, readDrawing, short } from './draw'
import { openBoard, quickTick, refresh, searchText, tick } from './indexing'
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
      Svg, narrow, ix, ui, setUi, byId, here, topLevel, groups, dueToday, asking, unseenCount, trail, backTo, recentTrail, chips,
    } = d
    const view = makeViews($, d, makeCards($, d))

    return (
      <Box flexDirection="column" paddingX={1}>
        {/* in a narrow pane the buttons go under the counts, not squeeze them into a column */}
        <Box flexDirection="row" flexWrap="wrap" justifyContent="space-between" columnGap={2}>
          <Text bold>
            {topLevel(groups.need).length} need you · {topLevel(groups.waiting).length} waiting · {topLevel(groups.working).length} working · {topLevel(groups.good).length} good enough
            {dueToday > 0 && <Text color={ACCENT}> · {dueToday} due</Text>}
            {asking > 0 && <Text color={ACCENT}> · ? {asking}</Text>}
            {unseenCount > 0 && <Text color={READY}> · {unseenCount} unseen</Text>}
          </Text>
          <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
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
              placeholder="Search titles, files, media, commits… Enter: also what was said"
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
              onSubmit={v => {
                live.typedQuery = v
                setUi(u => ({ ...u, query: v, view: 'board' }))
                logUse('search-said', { q: v.slice(0, 60) })
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
        </Box>
        <Box flexDirection="row" flexWrap="wrap" gap={1} marginY={1}>
          <Button key="v-board" variant={ui.view === 'board' || ui.view === 'focus' ? 'primary' : 'secondary'} label="Board" onPress={() => setUi(u => ({ ...u, view: 'board' }))} />
          <Button key="v-todos" variant={ui.view === 'todos' ? 'primary' : 'secondary'}
            label={dueToday > 0 ? `Todos · ${dueToday}` : 'Todos'} onPress={() => setUi(u => ({ ...u, view: 'todos' }))} />
          <Button key="v-media" variant={ui.view === 'media' ? 'primary' : 'secondary'} label="Media" onPress={() => setUi(u => ({ ...u, view: 'media' }))} />
          <Button key="v-graph" variant={ui.view === 'graph' ? 'primary' : 'secondary'} label="Graph" onPress={() => setUi(u => ({ ...u, view: 'graph' }))} />
          {/* only while there is something to tidy */}
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
