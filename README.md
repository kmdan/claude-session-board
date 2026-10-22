# Session Board for Claude Code

A pane beside the chat in the Claude Code desktop app that keeps **all your
sessions** in one calm place, across every project. Made for people who run a
lot of sessions at once and lose track of them, ADHD brains included.

## What it shows

- **Here**: the session you are in, pinned at the top.
- **Needs you**: sessions that finished and are waiting on you, for their first day.
  Older ones fold into **Still waiting on you**, so the top list stays short.
- **Working**, **This week**, **Good enough**, and folded **Earlier**, **Done**
  and a **Parking lot** for anything a month quiet or archived.
- Every card: its status line, what it needs from you, and one tab at a time
  for its **media** (movies, images, HTML pages and published artifacts it made),
  **files** it wrote, **related** sessions and your **notes**.
- **Subsessions** show as live rows under their parent and open in place.
- **Related sessions** to the one you are in get a warmer border, the closer
  the relation; a card that just moved or changed state glows and fades.

## What you can do

- Mark a session **Good enough**, **Done**, **Park** or **Working**. Nothing is
  archived or deleted; the marks are the board's own.
- **Open** a session, open a file or show it in Explorer.
- Keep **todos** on a session, Todoist-style: type `check the cache @ops fri`
  and `@ops` becomes a label and `fri` the due day (`today`, `tomorrow`, a
  weekday, `3d` or `2026-11-04`). Tick them off; send one as the session's next
  **prompt**, or ask that session to start a **subsession** for it.
- The **Todos** view lists every open todo by **Overdue / Today / Upcoming /
  No date**, with label chips to filter. Its **Inbox** takes todos that belong
  to no session yet, and **→ new session** turns one into a session.
- **Answer a session's questions on its card.** When a session writes an HTML
  review page with question blocks (`<div class="q" data-q="Q1" data-to="me">`,
  an `<h3>`, radio options, the recommended one marked `<span class="rec">`, a
  `<textarea>`), the card shows **❓ N questions** and a **Questions** tab: pick
  an option per question, add notes and free text, and **Send** puts the
  answers into that session as `Q1 [me]: … | note: …`. The page itself stays
  one click away for its movies, stills and pasted screenshots.
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

## Development

The board is a Claude Code mod: `hooks/register.tsx` draws it, `hooks/board.ts`
holds the pure logic, `scripts/sessionindex.py` builds the index.

```
claude plugin validate .
claude plugin test .
```
