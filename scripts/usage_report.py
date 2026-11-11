"""Summarises the board's usage log (cache/usage-*.jsonl), to see what is used and what is not.

    py -3 scripts/usage_report.py [cache folder] [--days N]

Prints counts only: how sessions are opened (from which button), which views,
orders, project chips, tabs and folds are used, what is searched for, and which
parts of the board were never touched in the period. The log stays on this
machine; the board writes it, this reads it, nothing sends it anywhere.
"""
import collections
import glob
import json
import os
import statistics
import sys
import time


def main() -> None:
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    folder = args[0] if args else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'cache')
    days = 30
    if '--days' in sys.argv:
        days = int(sys.argv[sys.argv.index('--days') + 1])
    since = (time.time() - days * 86400) * 1000

    rows = []
    for path in sorted(glob.glob(os.path.join(folder, 'usage-*.jsonl'))):
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get('t', 0) >= since:
                    rows.append(r)
    if not rows:
        print(f'no usage logged in the last {days} days under {folder}')
        return
    rows.sort(key=lambda r: r['t'])
    first, last = rows[0]['t'], rows[-1]['t']
    span = max(1, round((last - first) / 86400000))
    print(f'{len(rows)} actions over {span} day(s), {time.strftime("%Y-%m-%d", time.localtime(first / 1000))}'
          f' to {time.strftime("%Y-%m-%d", time.localtime(last / 1000))}')

    def show(title: str, counter: collections.Counter, limit: int = 12) -> None:
        if not counter:
            return
        print(f'\n{title}')
        for k, n in counter.most_common(limit):
            print(f'  {n:5}  {k}')

    what = collections.Counter(r['what'] for r in rows)
    show('actions', what, 30)

    opens = [r for r in rows if r['what'] == 'open']
    show('sessions opened from', collections.Counter(r.get('via', '?') for r in opens))
    if opens:
        sub = sum(1 for r in opens if r.get('sub'))
        unseen = sum(1 for r in opens if r.get('unseen'))
        asking = sum(1 for r in opens if r.get('status') in ('blocked', 'review_ready'))
        ages = [r['ageMin'] for r in opens if isinstance(r.get('ageMin'), (int, float))]
        print(f'  of {len(opens)} opens: {sub} subsessions, {unseen} unseen, {asking} asking you')
        if ages:
            print(f'  minutes since the opened session last moved: median {statistics.median(ages):.0f},'
                  f' over a day {sum(1 for a in ages if a > 1440)}')
        show('opened per project', collections.Counter(r.get('project') or '?' for r in opens))

    ui = [r for r in rows if r['what'] == 'ui']
    for key in ('view', 'boardBy', 'project', 'tab'):
        show(f'switched {key} to', collections.Counter(str(r.get('to') or '(none)') for r in ui if r.get('key') == key))
    unfolds = sum(1 for r in ui if r.get('key') == 'open' and r.get('to'))
    if unfolds:
        print(f'\ncards unfolded: {unfolds}')
    show('sections and subsessions unfolded', collections.Counter(r['key'] for r in rows if r['what'] == 'fold' and r.get('shown')))
    show('"show more" pressed in', collections.Counter(r['key'] for r in rows if r['what'] == 'more'))
    show('marks set (mark, from where)', collections.Counter(f"{r.get('mark')} ({r.get('via')})" for r in rows if r['what'] == 'mark'))
    searches = [r.get('q', '') for r in rows if r['what'] in ('search', 'search-said') and r.get('q')]
    show('searched for', collections.Counter(searches), 15)

    features = {
        'Todos view': any(r.get('key') == 'view' and r.get('to') == 'todos' for r in ui),
        'Media view': any(r.get('key') == 'view' and r.get('to') == 'media' for r in ui),
        'Graph view': any(r.get('key') == 'view' and r.get('to') == 'graph' for r in ui),
        'By state order': any(r.get('key') == 'boardBy' and r.get('to') == 'state' for r in ui),
        'project chips': any(r.get('key') == 'project' and r.get('to') for r in ui),
        'search': bool(searches),
        'full-text search (Enter)': what['search-said'] > 0,
        'back / forward trail': any(str(r.get('via', '')).startswith('trail') for r in opens),
        'quick done / park on lines': any(r['what'] == 'mark' and r.get('via') == 'line' for r in rows),
        'todos': what['todo'] > 0,
        'mark answered': what['answered'] > 0,
        'Refresh': what['refresh'] > 0,
    }
    unused = [k for k, used in features.items() if not used]
    print('\nnot used in this period: ' + (', '.join(unused) if unused else 'nothing, everything was used'))


if __name__ == '__main__':
    main()
