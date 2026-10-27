/** A movie, image or html page a session mentioned that is on disk now. */
export type Media = { p: string; k: 'movie' | 'image' | 'page' | 'file'; t: number }

/** A page the session published. */
export type Art = { url: string; title: string; t: number }

/** One question of a review page: its id (Q1), who the answer is for, the options. */
export type Question = {
  q: string
  to: string
  title: string
  /** `value` is the full answer text the page copies; `rec` marks the session's own pick */
  opts: { label: string; value: string; rec: boolean }[]
  notes: boolean
}

/** A review page a session wrote that asks questions: its path, mtime, title, questions. */
export type QPage = { p: string; t: number; title: string; qs: Question[] }

/**
 * Pages answered (from the board, or pasted into any session's chat): path ->
 * when, and the questions' signature then. A session often rewrites its page
 * after the answers (marking what was decided), so only NEW QUESTIONS ask
 * again; an entry without a signature (older boards) stays answered.
 */
export type Answered = Record<string, { at: number; t: number; sig?: string }>

/** What is picked or written on a page before it is sent, by `${page}#${q}` ('#general' for the free text). */
export type Drafts = Record<string, { pick?: string; note?: string }>

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
  /** when YOU last touched it (looked at it or wrote in it); 0 = never recorded */
  touched: number
  /** when you last wrote in it; looking at it does not count (missing in older indexes) */
  replied?: number
  /** when its transcript was last written: a working session keeps writing, a waiting one stops */
  written: number
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
  questions: QPage[]
  /** review pages the person answered in this session's chat ("Answers from <title>:"), by page title */
  answers: { title: string; at: number }[]
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

/** What of the index sits in shared state: everything but the sessions, plus a version that redraws. */
export type IndexMeta = Omit<Index, 'sessions'> & { version: number }

/** A state the person set by hand; it wins over the automatic one. */
export type Mark = 'working' | 'good' | 'done' | 'parked'

export type Marks = Record<string, { mark: Mark; at: number }>

/**
 * A todo (a quick note) on a session, or in the Inbox when it has none yet.
 * `sent` says where it went, if anywhere; `session` is the session a todo
 * from the Inbox started.
 */
export type Note = {
  id: string
  text: string
  at: number
  sent?: 'prompt' | 'subsession' | 'session'
  done?: boolean
  labels?: string[]
  /** due day, `YYYY-MM-DD` */
  due?: string
  session?: string
}

/** Todos by session id; the Inbox's are under INBOX. */
export type Notes = Record<string, Note[]>

export type Ui = {
  query: string
  /** how often the search box was cleared by its ✕: its key, so the app draws a fresh empty box */
  cleared?: number
  /** project filter; '' = all */
  project: string
  /** the card shown open, '' = none */
  open: string
  /** per section, how many cards are shown */
  limits: Record<string, number>
  /** sections shown expanded beyond the default */
  shown: Record<string, boolean>
  /**
   * board = the sections; todos = every todo by due day; media = everything
   * made, newest first; focus = one session and its relatives; graph = the
   * recent sessions as dots, related ones close together
   */
  view: 'board' | 'todos' | 'media' | 'focus' | 'graph'
  /** label filter of the Todos view; '' = all */
  label: string
  focus: string
  /** the view a focus was opened from, so "back" returns there */
  from?: 'graph'
  /** the one detail tab open on the open card, one at a time keeps an open card short:
   *  '' = automatic (Questions while some are open), 'none' = closed by hand */
  tab: '' | 'none' | 'questions' | 'media' | 'files' | 'related' | 'notes'
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
      index: IndexMeta; ui: Ui; marks: Marks; notes: Notes; fullText: FullText; moved: Moved
      /** the session an "open" was just pressed for, while the app switches to it; '' = none */
      opening: string
      answered: Answered
      drafts: Drafts
      seen: Record<string, number>
    }
  }
}
