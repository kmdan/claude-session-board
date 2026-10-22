/** A movie, image or html page a session mentioned that is on disk now. */
export type Media = { p: string; k: 'movie' | 'image' | 'page' | 'file'; t: number }

/** A page the session published. */
export type Art = { url: string; title: string; t: number }

/** One session as the indexer reports it (scripts/sessionindex.py). */
export type Sess = {
  id: string
  /** the transcript's name: what `$.session.id()` answers inside that session */
  cli: string
  title: string
  cwd: string
  project: string
  archived: boolean
  created: number
  last: number
  /** the app's own post-turn verdict: completed | blocked | review_ready | null */
  appStatus: string | null
  detail: string
  needs: string
  parent: string | null
  branch: string
  transcript: string
  files: string[]
  fileCount: number
  commits: string[]
  media: Media[]
  artifacts: Art[]
  /** filled from the app's live session list; false when that list was unreachable */
  running: boolean
}

export type Index = {
  sessions: Sess[]
  /** epoch ms of the last successful index */
  at: number
  /** what the last refresh said: counts, or why it failed */
  note: string
  isLoading: boolean
}

/** A state the person set by hand; it wins over the automatic one. */
export type Mark = 'working' | 'good' | 'done' | 'parked'

export type Marks = Record<string, { mark: Mark; at: number }>

/** A quick note on a session; `sent` says where it went, if anywhere. */
export type Note = { id: string; text: string; at: number; sent?: 'prompt' | 'subsession' }

export type Notes = Record<string, Note[]>

export type Ui = {
  query: string
  /** project filter; '' = all */
  project: string
  /** the card shown open, '' = none */
  open: string
  /** per section, how many cards are shown */
  limits: Record<string, number>
  /** sections shown expanded beyond the default */
  shown: Record<string, boolean>
  /** board = the sections; media = everything made, newest first; focus = one session and its relatives */
  view: 'board' | 'media' | 'focus'
  focus: string
  /** the one detail tab open on the open card ('' = none): one at a time keeps an open card short */
  tab: '' | 'media' | 'files' | 'related' | 'notes'
}

/** A full-text search over the conversations: one hit per matching session. */
export type TextHit = { cli: string; count: number; snip: string }

export type FullText = {
  query: string
  hits: TextHit[]
  isLoading: boolean
  /** what the last search said: how many conversations it read, how long, or why it failed */
  note: string
}

/** Sessions that just moved or changed state, and how bright their glow still is (3 = brightest). */
export type Moved = Record<string, number>

declare module 'claude-code' {
  interface PluginState {
    'session-board': {
      index: Index; ui: Ui; marks: Marks; notes: Notes; fullText: FullText; moved: Moved
    }
  }
}
