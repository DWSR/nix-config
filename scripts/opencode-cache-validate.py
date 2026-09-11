#!/usr/bin/env python3
"""Read-only, aggregate OpenCode prompt-cache diagnostics; no provider calls.

Measured rows are completed with nonnegative input/read/write and a positive sum.
zero_read_req_pct = 100 * count(cache.read == 0) / measured requests.
uncached_token_pct = 100 * sum(input + cache.write) / sum(input + cache.read + cache.write).
Input excludes both cache fields. Informational statuses exit 0; errors exit 2.
"""

import argparse
from collections import deque
from contextlib import closing
from datetime import datetime, timedelta, timezone
import json
import math
import os
from pathlib import Path
import sqlite3
import time


MESSAGES = """
SELECT m.id, m.session_id, m.time_created AS created,
       json_extract(m.data, '$.time.completed') AS completed,
       json_extract(m.data, '$.providerID') AS provider,
       json_extract(m.data, '$.modelID') AS model,
       json_extract(m.data, '$.agent') AS agent,
       json_extract(m.data, '$.tokens.input') AS input,
       json_extract(m.data, '$.tokens.cache.read') AS cache_read,
       json_extract(m.data, '$.tokens.cache.write') AS cache_write
FROM session AS s
CROSS JOIN message AS m INDEXED BY message_session_time_created_id_idx
WHERE s.time_updated >= ? AND m.session_id = s.id AND m.time_created < ?
  AND json_extract(m.data, '$.role') = 'assistant'
ORDER BY s.id, m.time_created, m.id
LIMIT 100001
"""
FILE_TOOL = """
SELECT EXISTS (
  SELECT 1 FROM part INDEXED BY part_message_id_id_idx
  WHERE message_id = ? AND json_extract(data, '$.type') = 'tool'
    AND json_extract(data, '$.tool') IN ('read', 'write', 'edit', 'glob', 'grep')
)
"""
GROUPS = ('totals', 'warm_file_associated', 'warm_no_recent_file')
TOKENS = ('input', 'cache_read', 'cache_write')
COHORT = (
    'Exclude first 3 assistant rows per session. Current and preceding 2 rows must '
    'be completed, measured, same provider/model/agent, and not compaction. '
    'Current creation minus previous completion must be 0..300000 ms. '
    'File association means read/write/edit/glob/grep in either preceding row; '
    'no_recent_file does not mean no file tools ever. Split by current creation; '
    'history may cross the window/split boundary. Status uses both warm cohorts '
    'in the latest period; informational only, not causal proof.'
)


def timestamp(value):
    try:
        result = datetime.fromisoformat(value)
        if result.utcoffset() is not None:
            return result.astimezone(timezone.utc)
    except ValueError:
        pass
    raise argparse.ArgumentTypeError('use an ISO timestamp with timezone, e.g. 2026-09-10T19:52:00Z')


def measured(row):
    values = [row[key] for key in TOKENS]
    return (all(isinstance(v, (int, float)) and math.isfinite(v) and v >= 0 for v in values)
            and sum(values) > 0 and isinstance(row['completed'], (int, float))
            and row['completed'] >= row['created'])


def summarize(rows, args, warm):
    count = len(rows)
    sums = [sum(row[key] for row in rows) for key in TOKENS]
    zero = sum(row['cache_read'] == 0 for row in rows)
    result = dict(samples=count, zero_read_requests=zero,
                  measured_sessions=len({row['session_id'] for row in rows}),
                  input_tokens=sums[0], cache_read_tokens=sums[1], cache_write_tokens=sums[2],
                  zero_read_req_pct=round(100 * zero / count, 3) if count else None,
                  uncached_token_pct=round(100 * (sums[0] + sums[2]) / sum(sums), 3) if count else None)
    if warm:
        result['status'] = ('insufficient_data' if count < args.min_samples else
                            'within_target' if 100 * zero / count <= args.max_zero_pct else 'above_target')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__, epilog=COHORT)
    window = parser.add_mutually_exclusive_group()
    window.add_argument('--since', type=timestamp, help='inclusive ISO timestamp with timezone')
    window.add_argument('--hours', type=float, default=2, help='lookback hours (default: 2)')
    parser.add_argument('--split-at', type=timestamp, help='ISO before/after boundary with timezone')
    default_db = Path(os.environ.get('XDG_DATA_HOME') or Path.home() / '.local/share') / 'opencode/opencode.db'
    parser.add_argument('--db', default=os.environ.get('OPENCODE_DB') or str(default_db),
                        help='DB path (default: OPENCODE_DB, then XDG_DATA_HOME/opencode/opencode.db)')
    parser.add_argument('--provider', default='openai', help='provider ID (default: openai)')
    parser.add_argument('--model', help='optional exact model ID')
    parser.add_argument('--session', action='append', help='exact session ID (repeatable; default: all sessions)')
    parser.add_argument('--min-samples', type=int, default=100, help='samples per warm cohort (default: 100; minimum: 20)')
    parser.add_argument('--max-zero-pct', type=float, default=5, help='informational zero-read target (default: 5%%)')
    parser.add_argument('--json', action='store_true', help='emit aggregate JSON')
    args = parser.parse_args()
    if not math.isfinite(args.hours) or args.hours <= 0:
        parser.error('--hours must be positive and finite')
    if args.min_samples < 20 or not 0 <= args.max_zero_pct <= 100:
        parser.error('--min-samples must be >= 20 and --max-zero-pct must be in 0..100')
    until = datetime.now(timezone.utc)
    try:
        since = args.since or until - timedelta(hours=args.hours)
    except OverflowError:
        parser.error('--hours is too large')
    if since >= until:
        parser.error('--since must be earlier than now')
    if args.split_at and not since <= args.split_at <= until:
        parser.error('--split-at must be inside the selected window')
    start_ms, end_ms = int(since.timestamp() * 1000), int(until.timestamp() * 1000)
    split_ms = int(args.split_at.timestamp() * 1000) if args.split_at else None
    periods = {name: dict(assistant_rows=0, **{g: [] for g in GROUPS})
               for name in (('before', 'after') if args.split_at else ('all',))}
    try:
        uri = Path(args.db).expanduser().resolve().as_uri() + '?mode=ro'
        with closing(sqlite3.connect(uri, uri=True, timeout=5)) as db:
            db.row_factory = sqlite3.Row
            db.execute('PRAGMA query_only = ON')
            db.execute('PRAGMA temp_store = MEMORY')
            deadline = time.monotonic() + 30
            db.set_progress_handler(lambda: time.monotonic() > deadline, 10000)
            db.execute('BEGIN')
            # Keep actual assistant order, including unmeasured/other-provider rows.
            rows = db.execute(MESSAGES, (start_ms, end_ms)).fetchall()
            if len(rows) > 100000:
                raise ValueError('assistant history exceeds 100000 rows; narrow the window')
            history, file_cache = deque(maxlen=3), {}
            session, ordinal = None, 0
            for row in rows:
                if time.monotonic() > deadline:
                    raise ValueError('read budget exceeded; narrow the window')
                if row['session_id'] != session:
                    session, ordinal = row['session_id'], 0
                    history.clear()
                ordinal += 1
                history.append(row)
                if (row['created'] < start_ms or row['provider'] != args.provider
                        or (args.session and row['session_id'] not in args.session)
                        or (args.model and row['model'] != args.model)):
                    continue
                period = periods['all' if split_ms is None else 'before' if row['created'] < split_ms else 'after']
                period['assistant_rows'] += 1
                if not measured(row):
                    continue
                period['totals'].append(row)
                if ordinal <= 3 or not all(row[k] for k in ('provider', 'model', 'agent')):
                    continue
                if row['agent'] == 'compaction' or not all(
                    measured(r) and all(r[k] == row[k] for k in ('provider', 'model', 'agent')) for r in history
                ):
                    continue
                if not 0 <= row['created'] - history[-2]['completed'] <= 300000:
                    continue
                previous = list(history)[:-1]
                for prior in previous:
                    if prior['id'] not in file_cache:
                        file_cache[prior['id']] = db.execute(FILE_TOOL, (prior['id'],)).fetchone()[0]
                group = 'warm_file_associated' if any(file_cache[r['id']] for r in previous) else 'warm_no_recent_file'
                period[group].append(row)
    except (OSError, sqlite3.Error, ValueError) as error:
        parser.exit(2, f'opencode-cache-validate: {error} (read-only query; 30s limit; no partial report)\n')
    for period in periods.values():
        for group in GROUPS:
            period[group] = summarize(period[group], args, group != 'totals')
        period['unmeasured_rows'] = period['assistant_rows'] - period['totals']['samples']
    latest = 'after' if args.split_at else 'all'
    statuses = [periods[latest][g]['status'] for g in GROUPS[1:]]
    status = ('insufficient_data' if 'insufficient_data' in statuses else
              'above_target' if 'above_target' in statuses else 'within_target')
    report = dict(status=status, since=since.isoformat(), until=until.isoformat(),
                  split_at=args.split_at.isoformat() if args.split_at else None,
                  provider=args.provider, model=args.model, session_filter=args.session, min_samples=args.min_samples,
                  max_zero_pct=args.max_zero_pct, judgment_period=latest,
                  assistant_history_rows=len(rows), cohort=COHORT, periods=periods)
    if args.json:
        print(json.dumps(report, indent=2, allow_nan=False))
    else:
        print(f'{status}: {report["since"]} .. {report["until"]} (exclusive)')
        print(f'provider={args.provider} model={args.model or "all"} split_at={report["split_at"]}')
        print(f'session_filter={args.session or "all"}')
        print(f'Target: zero_read_req_pct <= {args.max_zero_pct}%; minimum {args.min_samples}/warm cohort ({latest}).')
        for name, period in periods.items():
            print(f'{name}: assistant_rows={period["assistant_rows"]} unmeasured_rows={period["unmeasured_rows"]}')
            for group in GROUPS:
                print(f'  {group}: {json.dumps(period[group])}')
        print(COHORT)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
