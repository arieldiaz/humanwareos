"""Metadata-only activity envelope and rebuildable, date-partitioned SQLite index.

This observes decisions made elsewhere. It never evaluates permissions, reads
referenced payloads, promotes memory, or treats model text as provenance.
"""
from __future__ import annotations

import argparse
from collections import defaultdict
from contextlib import closing
from datetime import datetime, timezone
from decimal import Decimal
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import tempfile

KINDS = (
    'action.tool', 'action.write', 'action.send', 'action.approval', 'action.schedule',
    'context.selected', 'context.assembled', 'model.invoked', 'usage.cost',
    'memory.retrieved', 'memory.proposed', 'memory.promoted', 'memory.superseded',
    'memory.suppressed', 'memory.deleted',
)
AUTHORITY_RESULTS = ('not_required', 'human_message', 'standing_grant', 'delegated', 'denied', 'unknown')
REFERENCE_TYPES = ('event', 'human_message', 'grant', 'delegation', 'context', 'memory_claim', 'raw')
TOKEN = re.compile(r'^[A-Za-z0-9_./:@+\-]{1,256}$')


def identifier(value, default=None):
    if isinstance(value, str) and TOKEN.fullmatch(value) and '..' not in value.split('/'):
        return value
    return default


def reference(value):
    if not isinstance(value, dict) or value.get('type') not in REFERENCE_TYPES:
        return None
    ref_id = identifier(value.get('id'))
    if not ref_id:
        return None
    result = {'type': value['type'], 'id': ref_id}
    if value.get('type') == 'raw':
        result['localOnly'] = True
    return result


def refs(values):
    return [ref for value in values[:100] if (ref := reference(value))] if isinstance(values, list) else []


def timestamp(value):
    parsed = datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('Activity timestamp must have a timezone')
    return parsed.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')


def cost_metadata(value, event_id):
    value = value if isinstance(value, dict) else {}
    status = value.get('status', 'unavailable')
    if status not in ('exact', 'estimated', 'unavailable'):
        raise ValueError('Invalid cost status')
    result = {'status': status, 'usageId': identifier(value.get('usageId'), event_id)}
    tokens = value.get('tokens', {})
    result['tokens'] = {key: number for key, number in tokens.items()
                        if key in ('input', 'output', 'cacheRead', 'cacheWrite', 'total')
                        and type(number) is int and number >= 0} if isinstance(tokens, dict) else {}
    if status != 'unavailable':
        amount = value.get('amount')
        currency = value.get('currency')
        basis = reference(value.get('basisRef'))
        if type(amount) not in (int, float) or not math.isfinite(amount) or amount < 0:
            raise ValueError('Known cost needs a finite nonnegative amount')
        if not isinstance(currency, str) or not re.fullmatch('[A-Z]{3}', currency) or not basis:
            raise ValueError('Known cost needs currency and provider/rate evidence')
        result.update(amount=amount, currency=currency, basisRef=basis)
    return result


def event(*, event_id, ts, session_id, kind, actor, source_ref, run_id=None,
          trace_id=None, parent_ids=(), authority=None, target=None,
          reversibility='reversible', outcome='unknown', reason_code='unavailable',
          policy=None, entered_context=None, source_refs=(), memory=None, cost=None,
          tool=None, channel=None):
    """Host/adapter emit helper. Inputs are observed metadata, never model reports.

    Required IDs fail closed. Optional free text is omitted rather than redacted.
    All fields are constructed here; arbitrary details cannot cross this boundary.
    """
    if kind not in KINDS:
        raise ValueError('Unsupported activity kind')
    if not identifier(event_id) or not identifier(session_id) or not reference(source_ref):
        raise ValueError('Activity requires stable event/session/source identifiers')
    actor = actor if isinstance(actor, dict) else {}
    authority = authority if isinstance(authority, dict) else {}
    result = authority.get('result', 'unknown')
    if result not in AUTHORITY_RESULTS:
        raise ValueError('Invalid authority result')
    auth_ref = reference(authority.get('ref'))
    if result in ('human_message', 'standing_grant', 'delegated'):
        expected = {'human_message': 'human_message', 'standing_grant': 'grant', 'delegated': 'delegation'}[result]
        if not auth_ref or auth_ref['type'] != expected:
            raise ValueError('Authority result requires its typed reference')
    policy = policy if isinstance(policy, dict) else {}
    policy_result = policy.get('result', 'unknown')
    if policy_result not in ('allowed', 'denied', 'not_required', 'unknown'):
        raise ValueError('Invalid policy result')
    policy_id, version = identifier(policy.get('id')), identifier(policy.get('version'))
    if policy_result != 'unknown' and not (policy_id and version):
        raise ValueError('Evaluated policy requires identity and version')
    if result == 'denied' and policy_result != 'denied':
        raise ValueError('Denied authority needs denied policy evidence')
    if reversibility not in ('reversible', 'outward', 'irreversible', 'unknown'):
        raise ValueError('Invalid reversibility')
    if outcome not in ('requested', 'succeeded', 'failed', 'denied', 'unknown'):
        raise ValueError('Invalid outcome')
    record = {
        'schemaVersion': 3, 'id': event_id, 'traceId': identifier(trace_id, session_id),
        'logicalSessionId': session_id, 'runId': identifier(run_id), 'ts': timestamp(ts),
        'source': 'adapter', 'kind': kind, 'summary': kind.replace('.', ' '), 'details': {},
        'level': 'normal' if reversibility in ('outward', 'irreversible') else 'verbose',
        'actor': {'identity': identifier(actor.get('identity'), 'unknown'),
                  'profileId': identifier(actor.get('profileId'), 'unknown')},
        'agent': identifier(actor.get('identity'), 'unknown'),
        'profileId': identifier(actor.get('profileId'), 'unknown'),
        'authority': {'result': result, 'ref': auth_ref},
        'policy': {'id': policy_id, 'version': version, 'result': policy_result},
        'sourceRef': reference(source_ref), 'sourceRefs': refs(list(source_refs)),
        'parentIds': sorted(set(filter(None, (identifier(v) for v in parent_ids)))),
        'reasonCode': identifier(reason_code, 'unavailable'),
        'enteredContext': entered_context if type(entered_context) is bool else None,
        'reversibility': reversibility, 'outcome': outcome,
        'channel': identifier(channel), 'tool': identifier(tool),
    }
    if isinstance(target, dict) and target.get('type') in ('path', 'channel', 'host', 'repository', 'schedule'):
        target_id = identifier(target.get('id'))
        if target_id:
            record['target'] = {'type': target['type'], 'id': target_id}
    if kind.startswith('memory.'):
        if not isinstance(memory, dict) or not identifier(memory.get('claimId')):
            raise ValueError('Memory events require stable claimId, never prose matching')
        introduced = identifier(memory.get('introducedBy'))
        if kind in ('memory.promoted', 'memory.superseded', 'memory.suppressed', 'memory.deleted') and not introduced:
            raise ValueError('Memory mutation requires introducedBy event ID')
        if not identifier(memory.get('visibility')) or not isinstance(memory.get('projections'), list):
            raise ValueError('Memory requires visibility and explicit projection membership')
        record['memory'] = {
            'claimId': memory['claimId'], 'introducedBy': introduced,
            'supersedes': sorted(set(filter(None, (identifier(v) for v in memory.get('supersedes', []))))),
            'visibility': identifier(memory.get('visibility'), 'unknown'),
            'projections': sorted(set(filter(None, (identifier(v) for v in memory.get('projections', []))))),
        }
    if kind == 'usage.cost':
        record['cost'] = cost_metadata(cost, event_id)
    return record


def append_events(events_root, additions):
    """Append idempotently under a per-partition writer lock; never rewrite evidence."""
    partitions = defaultdict(list)
    for row in additions:
        partitions[timestamp(row['ts'])[:10]].append(row)
    root = Path(events_root)
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    for day, rows in partitions.items():
        path = root / f'{day}.jsonl'
        fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_APPEND, 0o600)
        with os.fdopen(fd, 'a+', encoding='utf-8') as handle:
            fcntl.flock(handle, fcntl.LOCK_EX)
            handle.seek(0)
            existing = {}
            for line in handle:
                if line.strip():
                    previous = json.loads(line)
                    existing[previous['id']] = previous
            for row in rows:
                if row['id'] in existing:
                    if existing[row['id']] != row:
                        raise ValueError('Conflicting stable event ID')
                    continue
                handle.write(canonical_json(row) + '\n')
                existing[row['id']] = row
            handle.flush()
            os.fsync(handle.fileno())


def emit(data_root, **fields):
    """For trusted host producers; memory mutations stay in the memory ledger."""
    row = event(**fields)
    area = 'memory' if row['kind'].startswith('memory.') else 'sessions'
    append_events(Path(data_root) / 'evidence' / area / 'events', [row])
    return row


def project(record):
    """Re-allowlist even persisted events. Legacy details/summary never escape."""
    kind = record.get('kind')
    if kind not in KINDS:
        return None
    return event(event_id=record.get('id'), ts=record.get('ts'),
                 session_id=record.get('logicalSessionId'), kind=kind,
                 actor=record.get('actor'), source_ref=record.get('sourceRef'),
                 run_id=record.get('runId'), trace_id=record.get('traceId'),
                 parent_ids=record.get('parentIds', []), authority=record.get('authority'),
                 target=record.get('target'), reversibility=record.get('reversibility', 'unknown'),
                 outcome=record.get('outcome', 'unknown'), reason_code=record.get('reasonCode'),
                 policy=record.get('policy'), entered_context=record.get('enteredContext'),
                 source_refs=record.get('sourceRefs', []), memory=record.get('memory'),
                 cost=record.get('cost'), tool=record.get('tool'), channel=record.get('channel'))


def evidence_records(data_root, areas=('sessions', 'memory')):
    for area in areas:
        root = Path(data_root) / 'evidence' / area / 'events'
        for path in sorted(root.rglob('*')):
            if path.suffix not in ('.json', '.jsonl') or not path.is_file():
                continue
            with path.open(encoding='utf-8') as handle:
                if path.suffix == '.json':
                    yield json.load(handle)
                else:
                    for line in handle:
                        if line.strip():
                            yield json.loads(line)


def canonical_json(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False)


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    descriptor, temp = tempfile.mkstemp(dir=path.parent, prefix='.activity-')
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
            handle.write(canonical_json(value))
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def read_model(records):
    unique = {}
    skipped = 0
    for record in records:
        if not isinstance(record, dict):
            raise ValueError('Evidence event must be an object')
        projected = project(record)
        if projected is None:
            skipped += 1
            continue
        key = projected['id']
        if key in unique and unique[key] != projected:
            raise ValueError('Conflicting stable activity event ID')
        unique[key] = projected
    events = sorted(unique.values(), key=lambda e: (e['ts'], e['id']))
    lineage = {}
    spend = {}
    # Corrections remain append-only, but only the latest report per invocation
    # contributes to totals. All original source events stay queryable.
    latest_usage = {}
    usage_day = {}
    for row in events:
        if row['kind'] == 'usage.cost':
            usage_key = (row['actor']['identity'], row['cost']['usageId'])
            latest_usage[usage_key] = row['id']
            usage_day.setdefault(usage_key, row['ts'][:10])
    for row in events:
        if row['kind'] in ('memory.promoted', 'memory.superseded', 'memory.suppressed', 'memory.deleted'):
            claim = row['memory']
            previous = lineage.get(claim['claimId'])
            if previous and previous['introducedBy'] != claim['introducedBy']:
                raise ValueError('Stable memory claim changed its introduction')
            # Retrieval/proposal do not alter membership; mutations carry snapshots.
            introduction = unique.get(claim['introducedBy'], {})
            lineage[claim['claimId']] = dict(claim, eventId=row['id'],
                                            sessionId=introduction.get('logicalSessionId'),
                                            mutationSessionId=row['logicalSessionId'],
                                            sourceRefs=row['sourceRefs'], state='current' if row['kind'] in ('memory.promoted', 'memory.superseded') else row['kind'].split('.')[1])
            if row['kind'] in ('memory.promoted', 'memory.superseded'):
                for previous in claim['supersedes']:
                    if previous in lineage:
                        lineage[previous].update(state='superseded', projections=[])
            if row['kind'] in ('memory.suppressed', 'memory.deleted'):
                lineage[claim['claimId']]['projections'] = []
        if row['kind'] == 'usage.cost':
            cost = row['cost']
            if latest_usage[(row['actor']['identity'], cost['usageId'])] != row['id']:
                continue
            key = (usage_day[(row['actor']['identity'], cost['usageId'])], row['actor']['identity'], row['actor']['profileId'], cost.get('currency'))
            group = spend.setdefault(key, {'day': key[0], 'identity': key[1], 'profileId': key[2],
                                          'currency': key[3], 'exact': Decimal(0), 'estimated': Decimal(0),
                                          'unavailable': 0, 'eventIds': []})
            if cost['status'] == 'unavailable':
                group['unavailable'] += 1
            else:
                group[cost['status']] += Decimal(str(cost['amount']))
            group['eventIds'].append(row['id'])
    totals = [dict(value, exact=float(value['exact']), estimated=float(value['estimated'])) for value in spend.values()]
    return events, {'lineage': list(lineage.values()), 'spend': totals, 'unindexedEvents': skipped}


def rebuild(data_root, records=None):
    """Build one SQLite store with day-keyed partitions and disposable web exports.

    No input is modified. Bad evidence leaves the last published generation intact.
    Day files are content-addressed so old manifests remain internally consistent.
    """
    events, metadata = read_model(evidence_records(data_root) if records is None else records)
    root = Path(data_root) / 'generated' / 'indexes' / 'activity'
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=root, prefix='.index-')
    os.close(fd)
    try:
        with closing(sqlite3.connect(temporary)) as db:
            db.executescript('''
                CREATE TABLE events (day TEXT NOT NULL, id TEXT NOT NULL UNIQUE, ts TEXT NOT NULL,
                  identity TEXT NOT NULL, profile TEXT NOT NULL, session TEXT NOT NULL, run TEXT,
                  kind TEXT NOT NULL, target TEXT, event_json TEXT NOT NULL, PRIMARY KEY(day,id)) WITHOUT ROWID;
                CREATE INDEX actor_time ON events(identity,ts);
                CREATE INDEX session_run ON events(session,run,ts);
                CREATE INDEX target_time ON events(target,ts);
                PRAGMA user_version=1;
            ''')
            db.executemany('INSERT INTO events VALUES (?,?,?,?,?,?,?,?,?,?)', [
                (e['ts'][:10], e['id'], e['ts'], e['actor']['identity'], e['actor']['profileId'],
                 e['logicalSessionId'], e['runId'], e['kind'], (e.get('target') or {}).get('id'), canonical_json(e)) for e in events])
            db.commit()
        partitions = defaultdict(list)
        for row in events:
            partitions[row['ts'][:10]].append(row)
        days = []
        for day, rows in partitions.items():
            digest = hashlib.sha256(canonical_json(rows).encode()).hexdigest()
            filename = f'days/{day}-{digest}.json'
            atomic_json(root / filename, rows)
            days.append({'day': day, 'file': filename, 'count': len(rows)})
        manifest = dict(metadata, schemaVersion=1, generatedAt=datetime.now(timezone.utc).isoformat(),
                        days=days, eventCount=len(events))
        os.replace(temporary, root / 'index.sqlite')
        atomic_json(root / 'current.json', manifest)
        return manifest
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-root', required=True)
    args = parser.parse_args()
    report = rebuild(args.data_root)
    print(canonical_json({'events': report['eventCount'], 'unindexedEvents': report['unindexedEvents']}))
