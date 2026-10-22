"""Session Board indexer: one JSON line describing every Claude Code desktop session.

Reads only. Sources, all local:
  %APPDATA%/Claude/claude-code-sessions/*/*/local_*.json  -- the app's per-session record
  ~/.claude/projects/*/<cliSessionId>.jsonl              -- the transcript (files, commits)

Transcripts are large (GBs in all), so each one's scan is cached by size+mtime in
the cache file given as argv[1]; a re-run only reads transcripts that changed.

Output on stdout: {"sessions": [...], "scanned": n, "cached": n, "missing": n, "ms": n}
"missing" = sessions whose transcript was not found, so their file list is EMPTY
because it was never scanned, not because they wrote nothing.

Each scan also keeps the conversation alone (the person's prompts and Claude's
replies; no tool calls, results or injected reminders) in <cache dir>/text/<id>.txt,
about 1% of the transcript, so a full-text search reads that instead:

  sessionindex.py --search <cache dir>     (the query on stdin, words AND-ed)
  -> {"hits": [{"cli", "count", "snip"}], "files": n, "ms": n}

A session's HTML pages that follow the review-page shape (one `<div class="q"
data-q="Q1" data-to="...">` per question, an <h3>, radio <input value="...">
options, "my pick" marked with <span class="rec">) are read for their questions,
so the board can show and answer them: "questions": [{p, t, title, qs: [...]}].
"""
import calendar
import glob
import html.parser
import json
import os
import re
import sys
import time

WRITE_RE = re.compile(
    r'"name":"(?:Write|Edit|MultiEdit|NotebookEdit)","input":\{"(?:file_path|notebook_path)":"((?:[^"\\]|\\.)*)"'
)
# "[main 60655f9] msg" from git commit, or "60655f9 msg" from a git log --oneline after it
COMMIT_RE = re.compile(r"\[[\w./-]+(?: \(root-commit\))? ([0-9a-f]{7,12})\] |(?:\\n|\"text\":\")([0-9a-f]{7,12}) ")
MAX_FILES = 60
# bump when scan_transcript records something new: cached scans of an older version are redone
SCAN_VERSION = 5
# any drive-letter path to a movie, image or html page, anywhere in the row (JSON-escaped)
MEDIA_RE = re.compile(
    # bounded: unbounded, every path in a long row was walked to the row's end (20 s -> 239 s)
    r"[A-Za-z]:(?:\\\\|/)[^\"<>|*?\r\n]{0,240}?\.(?:mov|mp4|webm|avi|mkv|gif|png|jpe?g|exr|tiff?|webp|html?)(?![\w.])",
    re.I,
)
# cheap pre-check: most rows mention no media at all, and MEDIA_RE is the slow part of a scan
MEDIA_HINT = re.compile(r"\.(?:mov|mp4|webm|avi|mkv|gif|png|jpe?g|exr|tiff?|webp|html?)(?![\w.])", re.I)
MEDIA_KIND = {
    "mov": "movie", "mp4": "movie", "webm": "movie", "avi": "movie", "mkv": "movie", "gif": "movie",
    "png": "image", "jpg": "image", "jpeg": "image", "exr": "image", "tif": "image", "tiff": "image", "webp": "image",
    "html": "page", "htm": "page",
}
# Claude's own temp: pasted screenshots and tool-result spills, not something a session made
SKIP_MEDIA = ("\\appdata\\local\\temp\\claude\\",)
MAX_MEDIA = 40


def read_json(path):
    with open(path, "rb") as f:
        return json.loads(f.read().decode("utf-8"))


def conversation_text(line):
    """The words a row says, if it is the person's prompt or Claude's reply; else ''."""
    if '"type":"user"' not in line and '"type":"assistant"' not in line:
        return ""
    try:
        row = json.loads(line)
    except ValueError:
        return ""
    if row.get("isMeta") or row.get("type") not in ("user", "assistant"):
        return ""
    content = (row.get("message") or {}).get("content")
    parts = [content] if isinstance(content, str) else [
        b.get("text", "") for b in (content or []) if isinstance(b, dict) and b.get("type") == "text"
    ]
    said = [p for p in parts if p and not p.lstrip().startswith(("<system-reminder>", "<command-", "<local-command"))]
    if not said:
        return ""
    who = "U" if row["type"] == "user" else "A"
    return f"{who}: " + " ".join(" ".join(said).split()) + "\n"


# the review page's Copy answers (and the board's Send) start "Answers from <page title>:" and a
# line break; a title may hold colons itself ("Rig intake: open questions"), so the line break ends it
ANSWERS_RE = re.compile(r"Answers from (.+?):[ \t]*\r?\n")


def answered_title(text, line):
    """A person's message that answers a review page: (page title, ms) or None."""
    if not text.startswith("U: ") or "Answers from " not in text:
        return None
    try:
        row = json.loads(line)
    except ValueError:
        return None
    content = (row.get("message") or {}).get("content")
    raw = content if isinstance(content, str) else "\n".join(
        b.get("text", "") for b in (content or []) if isinstance(b, dict) and b.get("type") == "text")
    m = ANSWERS_RE.search(raw)
    if not m:
        return None
    try:
        # the transcript's stamps are UTC ("...Z")
        at = calendar.timegm(time.strptime((row.get("timestamp") or "")[:19], "%Y-%m-%dT%H:%M:%S")) * 1000
    except (ValueError, TypeError):
        at = 0
    return m.group(1).strip(), at


def scan_transcript(path, text_path):
    files = {}
    commits = []
    media = {}  # lower-cased path -> path as first seen, in order of last mention
    said = []
    answers = []  # review pages answered in the chat: [{title, at}]
    after_commit = False  # the result row that follows a "git commit" call
    with open(path, "rb") as f:
        for raw in f:
            line = raw.decode("utf-8", "replace")
            text = conversation_text(line)
            if text:
                said.append(text)
                hit = answered_title(text, line)
                if hit:
                    answers.append({"title": hit[0], "at": hit[1]})
            if MEDIA_HINT.search(line):
                for m in MEDIA_RE.finditer(line):
                    p = m.group(0).replace("\\\\", "\\").replace("/", "\\")
                    low = p.lower()
                    if any(s in low for s in SKIP_MEDIA):
                        continue
                    media.pop(low, None)
                    media[low] = p
            if '"input":{"' in line:
                for m in WRITE_RE.finditer(line):
                    try:
                        p = json.loads('"' + m.group(1) + '"')
                    except ValueError:
                        continue
                    files[p] = files.get(p, 0) + 1
                if "git commit" in line or "git -C" in line and " commit " in line:
                    after_commit = True
                    continue
            if after_commit and "tool_result" in line:
                after_commit = False
                for m in COMMIT_RE.finditer(line):
                    h = m.group(1) or m.group(2)
                    if h not in commits:
                        commits.append(h)
    os.makedirs(os.path.dirname(text_path), exist_ok=True)
    with open(text_path, "wb") as f:
        f.write("".join(said).encode("utf-8"))
    top = sorted(files.items(), key=lambda kv: -kv[1])[:MAX_FILES]
    return {
        "files": [p for p, _ in top], "fileCount": len(files), "commits": commits[-12:],
        # newest mention first; existence is checked on every run, not cached
        "mediaSeen": list(reversed(list(media.values())))[:200],
        # only pages this session WROTE can be its question pages: a page it merely
        # mentioned (a shared template, another session's page) asks nothing of it
        "pagesWritten": [p for p in files if p.lower().endswith((".html", ".htm"))],
        "answers": answers[-50:],
        "v": SCAN_VERSION,
    }


def search(cache_dir, query):
    """Sessions whose conversation holds every word of the query, most mentions first."""
    t0 = time.time()
    words = [w for w in query.lower().split() if w]
    hits = []
    text_dir = os.path.join(cache_dir, "text")
    names = os.listdir(text_dir) if os.path.isdir(text_dir) and words else []
    for name in names:
        with open(os.path.join(text_dir, name), "rb") as f:
            text = f.read().decode("utf-8", "replace")
        low = text.lower()
        counts = [low.count(w) for w in words]
        if min(counts) == 0:
            continue
        # the snippet sits on the query's rarest word in this conversation
        rare = words[counts.index(min(counts))]
        at = low.find(rare)
        start = max(0, at - 70)
        snip = ("…" if start else "") + text[start:at + len(rare) + 90].replace("\n", " ") + "…"
        hits.append({"cli": name[:-4], "count": sum(counts), "snip": snip})
    hits.sort(key=lambda h: -h["count"])
    return {"hits": hits[:40], "files": len(names), "ms": int((time.time() - t0) * 1000)}


def existing_media(paths):
    """The mentioned media that are on disk now, newest file first: {p, k, t}."""
    out = []
    for p in paths:
        try:
            st = os.stat(p)
        except OSError:
            continue
        ext = p.rsplit(".", 1)[-1].lower()
        out.append({"p": p, "k": MEDIA_KIND.get(ext, "file"), "t": int(st.st_mtime * 1000)})
        if len(out) >= MAX_MEDIA:
            break
    out.sort(key=lambda m: -m["t"])
    return out


class QuestionReader(html.parser.HTMLParser):
    """The review-page questions: each .q block's id, recipient, question and options."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.title = ""
        self.qs = []
        self._q = None          # the question being read
        self._depth = 0         # div depth inside it
        self._in = None         # "title" | "h3" | "label" | "rec"
        self._opt = None

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        cls = (a.get("class") or "").split()
        if tag == "title":
            self._in = "title"
        elif tag == "div" and "q" in cls and a.get("data-q") and self._q is None:
            self._q = {"q": a["data-q"], "to": a.get("data-to") or "me", "title": "", "opts": [], "notes": False}
            self._depth = 1
        elif self._q is not None:
            if tag == "div":
                self._depth += 1
            elif tag == "h3":
                self._in = "h3"
            elif tag == "label":
                self._opt = {"label": "", "value": "", "rec": False}
                self._in = "label"
            elif tag == "input" and a.get("type") == "radio" and self._opt is not None:
                self._opt["value"] = a.get("value") or ""
            elif tag == "span" and "rec" in cls and self._opt is not None:
                self._opt["rec"] = True
                self._in = "rec"
            elif tag == "textarea":
                self._q["notes"] = True

    def handle_endtag(self, tag):
        if tag == "title":
            self._in = None
        elif self._q is None:
            return
        elif tag == "h3":
            self._in = None
        elif tag == "span" and self._in == "rec":
            self._in = "label"
        elif tag == "label" and self._opt is not None:
            self._opt["label"] = " ".join(self._opt["label"].split())
            if self._opt["value"] or self._opt["label"]:
                self._q["opts"].append(self._opt)
            self._opt = None
            self._in = None
        elif tag == "div":
            self._depth -= 1
            if self._depth == 0:
                self._q["title"] = " ".join(self._q["title"].split())
                self.qs.append(self._q)
                self._q = None

    def handle_data(self, data):
        if self._in == "title":
            self.title += data
        elif self._in == "h3" and self._q is not None:
            self._q["title"] += data
        elif self._in == "label" and self._opt is not None:
            self._opt["label"] += data


def page_questions(path):
    """The questions a review page asks (its free "General" block left out), or []."""
    try:
        if os.path.getsize(path) > 2_000_000:
            return "", []
        with open(path, "rb") as f:
            text = f.read().decode("utf-8", "replace")
    except OSError:
        return "", []
    if 'class="q"' not in text:
        return "", []
    reader = QuestionReader()
    try:
        reader.feed(text)
    except Exception:  # a broken page asks nothing the board can read
        return "", []
    qs = [q for q in reader.qs if q["q"].lower() != "general" and (q["opts"] or q["notes"])]
    return " ".join(reader.title.split()), qs


def project_of(cwd):
    p = cwd.replace("/", "\\").rstrip("\\")
    low = p.lower()
    i = low.find("\\.claude\\worktrees\\")
    if i >= 0:
        p = p[:i]
    return os.path.basename(p) or p


def meta_paths():
    appdata = os.environ.get("APPDATA", "")
    return glob.glob(os.path.join(appdata, "Claude", "claude-code-sessions", "*", "*", "local_*.json"))


def meta_fields(m):
    """What the app's own session record says: everything here changes as a session runs."""
    pts = m.get("postTurnSummary") or {}
    wrap = m.get("turnWrapUp") or {}
    return {
        "id": m.get("sessionId"),
        "title": m.get("title") or "Untitled session",
        "archived": bool(m.get("isArchived")),
        "last": m.get("lastActivityAt") or 0,
        # when YOU last touched it: looked at it, or wrote in it
        "touched": max(m.get("lastFocusedAt") or 0, m.get("latestUserFrameAt") or 0),
        "appStatus": pts.get("status_category"),
        "detail": pts.get("status_detail") or wrap.get("description") or "",
        "needs": pts.get("needs_action") or "",
    }


def quick(since_ms):
    """
    The app records changed since `since_ms`, their fields alone: cheap enough to
    run every few seconds (no transcript is read), so a session that just
    finished shows on the board before the next full index.
    """
    rows = []
    for mp in meta_paths():
        try:
            if os.stat(mp).st_mtime * 1000 < since_ms:
                continue
            rows.append(meta_fields(read_json(mp)))
        except (OSError, ValueError):
            continue
    return rows


def main():
    t0 = time.time()
    if sys.argv[1] == "--search":
        query = sys.stdin.buffer.read().decode("utf-8")
        sys.stdout.buffer.write(json.dumps(search(sys.argv[2], query), ensure_ascii=True).encode("ascii"))
        return
    if sys.argv[1] == "--quick":
        rows = quick(float(sys.argv[2]))
        sys.stdout.buffer.write(json.dumps({"rows": rows, "ms": int((time.time() - t0) * 1000)}, ensure_ascii=True).encode("ascii"))
        return
    cache_path = sys.argv[1]
    text_dir = os.path.join(os.path.dirname(cache_path), "text")
    try:
        cache = read_json(cache_path)
    except (OSError, ValueError):
        cache = {}

    metas = meta_paths()

    projects = os.path.join(os.path.expanduser("~"), ".claude", "projects")
    transcripts = {}
    if os.path.isdir(projects):
        for d in os.scandir(projects):
            if d.is_dir():
                for f in os.scandir(d.path):
                    if f.name.endswith(".jsonl"):
                        transcripts[f.name[:-6]] = f.path

    out = []
    scanned = cached = missing = 0
    new_cache = {}
    for mp in metas:
        try:
            m = read_json(mp)
        except (OSError, ValueError):
            continue
        cli = m.get("cliSessionId") or ""
        tp = transcripts.get(cli)
        info = {"files": [], "fileCount": 0, "commits": [], "mediaSeen": []}
        if tp:
            st = os.stat(tp)
            key = f"{st.st_size}:{int(st.st_mtime)}"
            hit = cache.get(tp)
            text_path = os.path.join(text_dir, f"{cli}.txt")
            if hit and hit.get("key") == key and hit["info"].get("v") == SCAN_VERSION and os.path.exists(text_path):
                info = hit["info"]
                cached += 1
            else:
                info = scan_transcript(tp, text_path)
                scanned += 1
            new_cache[tp] = {"key": key, "info": info}
        else:
            missing += 1
        info = dict(info)
        media = existing_media(info.pop("mediaSeen", []))
        written = {p.lower() for p in info.pop("pagesWritten", [])}
        info.pop("v", None)
        questions = []
        for page in (m_ for m_ in media if m_["k"] == "page"):
            # its own pages only, and never a template (a page to copy asks nobody)
            if page["p"].lower() not in written or "template" in os.path.basename(page["p"]).lower():
                continue
            title, qs = page_questions(page["p"])
            if qs:
                questions.append({"p": page["p"], "t": page["t"], "title": title or os.path.basename(page["p"]), "qs": qs})
        arts = [
            {"url": a.get("url", ""), "title": a.get("title") or "artifact", "t": a.get("updatedAt") or 0}
            for a in (m.get("publishedArtifacts") or []) if a.get("url")
        ]
        sp = m.get("spawnedFrom") or {}
        out.append({
            **meta_fields(m),
            "cli": cli,  # what $.session.id() answers inside that session
            "cwd": m.get("cwd") or "",
            "project": project_of(m.get("originCwd") or m.get("cwd") or ""),
            "created": m.get("createdAt") or 0,
            "parent": sp.get("sessionId"),
            "branch": m.get("branch") or "",
            "transcript": tp or "",
            "media": media,
            "artifacts": arts,
            "questions": questions,
            **info,
        })

    # several sessions may index at once: each writes its own tmp, the replace is atomic
    tmp = f"{cache_path}.{os.getpid()}.tmp"
    os.makedirs(os.path.dirname(cache_path), exist_ok=True)
    with open(tmp, "wb") as f:
        f.write(json.dumps(new_cache).encode("utf-8"))
    os.replace(tmp, cache_path)

    sys.stdout.buffer.write(json.dumps({
        "sessions": out, "scanned": scanned, "cached": cached, "missing": missing,
        "ms": int((time.time() - t0) * 1000),
    }, ensure_ascii=True).encode("ascii"))


if __name__ == "__main__":
    main()
