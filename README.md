# Session Board for Claude Code

A pane beside the chat in the Claude Code desktop app that keeps **all your
sessions** in one calm place, across every project. Made for people who run a
lot of sessions at once and lose track of them, ADHD brains included.

## What it shows

- **The top line**: the session you are in, as the app's Environment box has
  it: project, branch (ahead / behind), lines added and removed (new files
  counted), context fill, and its folder. Read with git every 30 seconds while
  the board is shown.
- **Here**: the session you are in, pinned at the top.
- **A paste box**: paste a log or a command's output and press Enter. It is
  saved as `cache/paste-<time>-<first words>.md` and its path (not the text)
  goes into this session's prompt, so Claude reads what it needs from the file.
- **Waiting for you**: what asks you or finished since you last looked, newest
  first, and **Next ↗** to open the first you have not looked at. It folds.
- **By project**: a section per project, the one you are in first, then the
  last active; a line per session, its live subsessions under it. **Done** and
  a **Parking lot** (a month quiet) stay folded at the end.
- It checks the app's own session records every 20 seconds, so a session that
  just finished moves to its place within seconds. A session whose transcript
  was written in the last minute counts as **Working** and has a brown pulse:
  a turn in progress writes every few seconds, one waiting for you writes nothing.
  Only work pulses. A session that finished since you last looked is **unseen**:
  a green border, until you open it here or in the app. A **green dot** means it
  asks you something (the app says so, or a question page is open); after two
  quiet days it goes grey.
- Every card (▸ on a line): its status line, what it needs from you, and one tab
  at a time for its **questions**, **media** (movies, images, HTML pages and
  published artifacts it made), **files** it wrote and **related** sessions.
- **Subsessions** show as short lines under their parent; an unfolded card
  lists all of them, every level.
- **Related sessions** to the one you are in get a warmer border, the closer
  the relation; a card that just moved or changed state glows and fades.

## What you can do

- Mark a session **Good enough**, **Done**, **Park** or **Working**. Nothing is
  archived or deleted; the marks are the board's own.
- **Open** a session, open a file or show it in Explorer.
- **Tidy up** lists sessions quiet a month (or done / parked and quiet three
  days). **Hide** takes them off the board at once, with no approvals: search
  still finds them, and **Unhide** brings them back. **Archive** asks the app
  instead, which may want each one approved, and leaves out sessions in a worktree.
- **See a session's questions on its card.** When a session writes an HTML
  review page with question blocks (`<div class="q" data-q="Q1" data-to="me">`
  and an `<h3>`), the card shows **? N questions** and a **Questions** tab
  listing them; answer on the page, and **✓ mark answered** closes it.
- **Search** titles, files, media, commits; press **Enter** to also search
  **what was said** in every conversation.

## Privacy

Everything stays on your machine. The board **reads** Claude Code's own session
records and transcripts, never writes them, and keeps its index, snapshot and a
text-only copy of each conversation (for search) in `cache/`, which git ignores.
Nothing is sent anywhere.

## Requirements

- Claude Code **desktop app** on **Windows** (it opens files with Explorer and
  reads the app's session records under `%APPDATA%\Claude`).
- **Python 3** with the `py` launcher (standard library only).

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-board --marketplace kmdan/claude-session-board
```

From a shell:

```
claude plugin install session-board --marketplace kmdan/claude-session-board
```

In the desktop app: click **+** next to the prompt box, then **Plugins**,
**Add marketplace** with `kmdan/claude-session-board`, then **Add plugin**.

The board opens by itself in each new session; `/board` or the **▦ Sessions**
button above the prompt reopens it.

## Your own project names

A project is the folder a session runs in, coloured from its name. To shorten
or recolour some, put a `projects.json` beside the plugin (git ignores it):

```json
{ "my-very-long-repo-name": { "label": "repo", "color": "#3a7bd5" } }
```

## Usage log

The board notes what you do on it, one line per action: which button opened a
session, views, orders, project chips, tabs, folds, "show more", marks,
searches. Each session writes its own `cache/usage-<day>-<session>.jsonl`
(git ignores `cache/`; nothing is sent anywhere). To see what is used and what
is not:

```
py -3 scripts/usage_report.py --days 14
```

## Development

The board is a Claude Code mod, in `hooks/`:

- `register.tsx`: the hooks and the board's frame (the top line, search, tabs)
- `views.tsx`: the sections and views; `cards.tsx`: a session's card and line
- `draw.ts`: what one drawing reads and works out, and the colours
- `state.ts`: the shared values and the index in memory (only this file touches the atoms)
- `indexing.ts`: the indexer, the timed checks, search, opening the pane
- `actions.ts`: what the buttons do
- `board.ts`: the pure logic

`scripts/sessionindex.py` builds the index.

```
claude plugin validate .
claude plugin test .
```
