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
"""
import glob
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


def scan_transcript(path, text_path):
    files = {}
    commits = []
    media = {}  # lower-cased path -> path as first seen, in order of last mention
    said = []
    after_commit = False  # the result row that follows a "git commit" call
    with open(path, "rb") as f:
        for raw in f:
            line = raw.decode("utf-8", "replace")
            text = conversation_text(line)
            if text:
                said.append(text)
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
        "hasText": True,
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


def project_of(cwd):
    p = cwd.replace("/", "\\").rstrip("\\")
    low = p.lower()
    i = low.find("\\.claude\\worktrees\\")
    if i >= 0:
        p = p[:i]
    return os.path.basename(p) or p


def main():
    t0 = time.time()
    if sys.argv[1] == "--search":
        query = sys.stdin.buffer.read().decode("utf-8")
        sys.stdout.buffer.write(json.dumps(search(sys.argv[2], query), ensure_ascii=True).encode("ascii"))
        return
    cache_path = sys.argv[1]
    text_dir = os.path.join(os.path.dirname(cache_path), "text")
    try:
        cache = read_json(cache_path)
    except (OSError, ValueError):
        cache = {}

    appdata = os.environ.get("APPDATA", "")
    metas = glob.glob(os.path.join(appdata, "Claude", "claude-code-sessions", "*", "*", "local_*.json"))

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
            if hit and hit.get("key") == key and hit["info"].get("hasText") and os.path.exists(text_path):
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
        arts = [
            {"url": a.get("url", ""), "title": a.get("title") or "artifact", "t": a.get("updatedAt") or 0}
            for a in (m.get("publishedArtifacts") or []) if a.get("url")
        ]
        pts = m.get("postTurnSummary") or {}
        sp = m.get("spawnedFrom") or {}
        wrap = m.get("turnWrapUp") or {}
        out.append({
            "id": m.get("sessionId"),
            "cli": cli,  # what $.session.id() answers inside that session
            "title": m.get("title") or "Untitled session",
            "cwd": m.get("cwd") or "",
            "project": project_of(m.get("originCwd") or m.get("cwd") or ""),
            "archived": bool(m.get("isArchived")),
            "created": m.get("createdAt") or 0,
            "last": m.get("lastActivityAt") or 0,
            "appStatus": pts.get("status_category"),
            "detail": pts.get("status_detail") or wrap.get("description") or "",
            "needs": pts.get("needs_action") or "",
            "parent": sp.get("sessionId"),
            "branch": m.get("branch") or "",
            "transcript": tp or "",
            "media": media,
            "artifacts": arts,
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
