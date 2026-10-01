from contextlib import closing
import importlib.util
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / 'ops/session-console'))
import activity as A

spec = importlib.util.spec_from_file_location('builder', ROOT / 'ops/session-console/build-session-console.py')
B = importlib.util.module_from_spec(spec)
spec.loader.exec_module(B)


def fields(event_id='event-1', kind='action.tool', **updates):
    return dict(event_id=event_id, kind=kind, ts='2026-09-29T12:00:00Z',
                session_id='session-1', run_id='run-1', actor={'identity': 'liv', 'profileId': 'local'},
                source_ref={'type': 'raw', 'id': event_id}, **updates)


def sample_run(identity='liv', day='2026-09-29'):
    rows = []
    kinds = ['action.approval', 'context.selected', 'context.assembled', 'model.invoked',
             'action.tool', 'action.write', 'memory.proposed', 'memory.promoted', 'action.schedule',
             'action.send', 'usage.cost']
    for index, kind in enumerate(kinds):
        event_id = f'{identity}:{index}'
        args = fields(event_id, kind)
        args.update(ts=f'{day}T12:00:{index:02}Z', actor={'identity': identity, 'profileId': 'local'},
                    session_id=f'session-{identity}', run_id=f'run-{identity}',
                    authority={'result': 'human_message', 'ref': {'type': 'human_message', 'id': f'message-{identity}'}},
                    policy={'id': 'workspace', 'version': '1', 'result': 'allowed'},
                    parent_ids=[rows[-1]['id']] if rows else [], reason_code='task_scope',
                    source_refs=[{'type': 'context', 'id': 'context-1'}], entered_context=kind.startswith('context.'),
                    outcome='succeeded')
        if kind.startswith('memory.'):
            args['memory'] = {'claimId': f'claim-{identity}', 'introducedBy': f'{identity}:6',
                              'supersedes': [], 'visibility': identity, 'projections': ['current-memory']}
        if kind in ('action.write', 'action.send', 'action.schedule'):
            args.update(target={'type': 'path', 'id': 'working/result.md'}, reversibility='outward')
        if kind == 'usage.cost':
            args['cost'] = {'status': 'exact', 'amount': 0.0123, 'currency': 'USD',
                            'basisRef': {'type': 'event', 'id': 'provider-usage-1'}, 'tokens': {'input': 100, 'output': 20}}
        rows.append(A.event(**args))
    return rows


class ActivityTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def persist(self, rows, area='sessions'):
        A.append_events(self.root / 'evidence' / area / 'events', rows)

    def test_complete_causal_run_two_identities_multiday_rebuild(self):
        rows = sample_run() + sample_run('max', '2026-09-30')
        self.persist(rows)
        first = A.rebuild(self.root)
        db_path = self.root / 'generated/indexes/activity/index.sqlite'
        with closing(sqlite3.connect(db_path)) as db:
            before = list(db.iterdump())
            found = db.execute("SELECT count(*) FROM events WHERE day BETWEEN ? AND ? AND identity = ?", ('2026-09-29', '2026-09-30', 'liv')).fetchone()[0]
            self.assertEqual(found, 11)
            self.assertEqual(db.execute("SELECT count(*) FROM events WHERE target=?", ('working/result.md',)).fetchone()[0], 6)
        self.persist(rows)  # Replay never appends a second copy.
        second = A.rebuild(self.root)
        with closing(sqlite3.connect(db_path)) as db:
            self.assertEqual(before, list(db.iterdump()))
        self.assertEqual(first['days'], second['days'])
        self.assertEqual(second['eventCount'], 22)
        self.assertEqual(len(second['lineage']), 2)
        by_id = {row['id']: row for row in rows}
        current = by_id['liv:9']
        chain = []
        while True:
            chain.append(current['kind'])
            self.assertEqual(current['authority']['ref']['id'], 'message-liv')
            self.assertTrue(current['sourceRef']['localOnly'])
            if not current['parentIds']:
                break
            current = by_id[current['parentIds'][0]]
        self.assertIn('context.selected', chain)
        self.assertIn('model.invoked', chain)
        self.assertIn('memory.promoted', chain)
        # No log-level filtering in evidence or the store.
        self.assertTrue(any(row['level'] == 'verbose' for row in rows))

    def test_emit_memory_and_session_trace_share_one_envelope(self):
        rows = sample_run()
        for row in rows:
            self.persist([row], 'memory' if row['kind'].startswith('memory.') else 'sessions')
        result, count = B.build(str(self.root), str(self.root / 'absent-agents'))
        self.assertEqual(count, 0)
        events = result['sessions'][0]['events']
        self.assertEqual(len(events), 11)
        self.assertTrue(any(e['kind'] == 'memory.promoted' for e in events))
        emitted = A.emit(self.root, **fields('direct-host'))
        self.assertEqual(emitted['authority']['result'], 'unknown')
        self.assertEqual(A.rebuild(self.root)['eventCount'], 12)

    def test_payloads_excluded_at_all_projection_boundaries(self):
        marker = 'PRIVATE PAYLOAD not a credential but still Tier zero'
        rows = sample_run()
        for row in rows:
            row.update(summary=marker, details={'prompt': marker, 'output': marker}, arbitrary=marker)
            row['sourceRef']['body'] = marker
            row['actor']['prompt'] = marker
        self.persist(rows)
        self.persist([{'schemaVersion': 2, 'id': 'legacy', 'kind': 'tool.call', 'ts': '2026-09-29T10:00:00Z',
                       'logicalSessionId': 'session-liv', 'summary': marker, 'details': {'arguments': {'cmd': marker}, 'preview': marker}}])
        result, _ = B.build(str(self.root), str(self.root / 'absent'))
        self.assertNotIn(marker, json.dumps(result))
        for path in (self.root / 'generated/indexes/activity').rglob('*'):
            if path.is_file():
                self.assertNotIn(marker.encode(), path.read_bytes())
        for kind in ('prompt.submitted', 'context.compiled', 'thinking.summary', 'tool.call', 'tool.result'):
            record = {'type': kind, 'ts': '2026-09-29T12:00:00Z', 'seq': 1, 'sessionId': 's',
                      'data': {'prompt': marker, 'summary': marker, 'text': marker, 'output': marker,
                               'name': 'exec', 'arguments': {'command': marker}}}
            normalized = B.normalize(record, json.dumps(record), '/agents/liv/sessions/test.jsonl', 's')
            self.assertNotIn(marker, json.dumps(normalized))
        # URLs contribute only hostname, not credentials, path, query or fragment.
        record['data']['arguments'] = {'url': 'https://user:password@example.test/private?q=secret#body'}
        record['type'] = 'tool.call'
        normalized = B.normalize(record, json.dumps(record), '/agents/liv/sessions/test.jsonl', 's')
        self.assertEqual(normalized['target'], {'type': 'host', 'id': 'example.test'})

    def test_authority_results_and_policy_never_inferred(self):
        self.assertEqual(A.event(**fields())['authority']['result'], 'unknown')
        for result in A.AUTHORITY_RESULTS:
            args = fields()
            args['authority'] = {'result': result}
            if result in ('human_message', 'standing_grant', 'delegated'):
                with self.assertRaises(ValueError):
                    A.event(**args)
                args['authority']['ref'] = {'type': {'human_message':'human_message','standing_grant':'grant','delegated':'delegation'}[result], 'id': 'reference-1'}
            if result == 'denied':
                args['policy'] = {'id': 'policy', 'version': '2', 'result': 'denied'}
            self.assertEqual(A.event(**args)['authority']['result'], result)
        with self.assertRaises(ValueError):
            A.event(**fields(policy={'result': 'allowed'}))
        with self.assertRaises(ValueError):
            A.event(**fields(authority={'result': 'none'}))

    def test_memory_lineage_survives_rebuild_and_does_not_match_prose(self):
        memory = {'claimId': 'claim-1', 'introducedBy': 'intro-1', 'visibility': 'liv', 'projections': ['current-1'], 'supersedes': []}
        promote = A.event(**fields('promote', 'memory.promoted', memory=memory))
        replaced = dict(memory, claimId='claim-2', introducedBy='intro-2', supersedes=['claim-1'])
        args = fields('replace', 'memory.superseded', memory=replaced)
        args['ts'] = '2026-09-30T12:00:00Z'
        replace = A.event(**args)
        self.persist([promote, replace], 'memory')
        lineage = {m['claimId']: m for m in A.rebuild(self.root)['lineage']}
        self.assertEqual(lineage['claim-1']['projections'], [])
        self.assertEqual(lineage['claim-1']['state'], 'superseded')
        self.assertEqual(lineage['claim-2']['introducedBy'], 'intro-2')
        self.assertEqual(lineage['claim-2']['state'], 'current')
        conflicting = dict(replace, id='conflict', memory=dict(replace['memory'], introducedBy='different'))
        with self.assertRaises(ValueError):
            A.read_model([replace, conflicting])
        args = fields('delete', 'memory.deleted', memory=replaced)
        args['ts'] = '2026-10-01T00:00:00Z'
        self.persist([A.event(**args)], 'memory')
        self.assertEqual(A.rebuild(self.root)['lineage'][1]['projections'], [])
        self.assertIsNone(A.rebuild(self.root)['lineage'][1]['sessionId'])  # Missing introduction is not inferred.
        complete = A.read_model(sample_run())[1]['lineage'][0]
        self.assertEqual(complete['sessionId'], 'session-liv')
        with self.assertRaises(ValueError):
            A.event(**fields(kind='memory.promoted', memory={'text': 'some prose'}))
        self.assertEqual(A.read_model([{'fact': 'some prose'}])[1]['unindexedEvents'], 1)

    def test_cost_exact_estimated_missing_zero_and_currency(self):
        rows = []
        for i, cost in enumerate([
            {'status':'exact','amount':0,'currency':'USD'},
            {'status':'estimated','amount':0.1,'currency':'USD'},
            {'status':'exact','amount':0.2,'currency':'USD'},
            {'status':'exact','amount':1,'currency':'EUR'},
            {'status':'unavailable'},
        ]):
            if cost['status'] != 'unavailable':
                cost['basisRef'] = {'type':'event','id':f'usage-{i}'}
            cost['tokens'] = {'input': 20}
            rows.append(A.event(**fields(f'cost-{i}', 'usage.cost', cost=cost)))
        _, meta = A.read_model(rows + rows)
        usd = next(s for s in meta['spend'] if s['currency'] == 'USD')
        self.assertEqual((usd['exact'], usd['estimated']), (0.2, 0.1))
        missing = next(s for s in meta['spend'] if s['currency'] is None)
        self.assertEqual(missing['unavailable'], 1)
        self.assertNotIn('amount', rows[-1]['cost'])
        for amount in (-1, float('nan'), float('inf'), True):
            with self.assertRaises(ValueError):
                A.event(**fields(kind='usage.cost', cost={'status':'exact','amount':amount,'currency':'USD','basisRef':{'type':'event','id':'usage'}}))

    def test_later_provider_report_replaces_estimate_without_double_counting(self):
        reports = []
        for i, status in enumerate(('unavailable', 'estimated', 'exact')):
            cost = {'usageId': 'invocation-1', 'status': status}
            if status != 'unavailable':
                cost.update(amount=0.25 if status == 'exact' else 0.3, currency='USD',
                            basisRef={'type': 'event', 'id': f'provider-{i}'})
            args = fields(f'report-{i}', 'usage.cost', cost=cost)
            args['ts'] = f'2026-09-{28+i}T12:00:00Z'
            reports.append(A.event(**args))
        events, meta = A.read_model(reports)
        self.assertEqual(len(events), 3)
        self.assertEqual(len(meta['spend']), 1)
        self.assertEqual(meta['spend'][0]['eventIds'], ['report-2'])
        self.assertEqual(meta['spend'][0]['estimated'], 0)
        self.assertEqual(meta['spend'][0]['exact'], 0.25)
        self.assertEqual(meta['spend'][0]['day'], '2026-09-28')

    def test_invalid_evidence_does_not_publish_and_conflicting_id_fails(self):
        self.persist(sample_run())
        A.rebuild(self.root)
        root = self.root / 'generated/indexes/activity'
        before = (root/'current.json').read_bytes()
        db_before = (root/'index.sqlite').read_bytes()
        rows = sample_run()
        rows[0]['outcome'] = 'denied'
        with self.assertRaises(ValueError):
            A.rebuild(self.root, sample_run() + rows)
        path = self.root / 'evidence/memory/events/bad.json'
        path.parent.mkdir(parents=True)
        path.write_text('{bad')
        with self.assertRaises(json.JSONDecodeError):
            A.rebuild(self.root)
        self.assertEqual(before, (root/'current.json').read_bytes())
        self.assertEqual(db_before, (root/'index.sqlite').read_bytes())

    def test_tool_result_needs_observed_success_and_read_is_not_send(self):
        for tool, action in (('message', 'read'), ('cron', 'list')):
            record = {'type': 'tool.call', 'seq': 1, 'sessionId': 's', 'ts': '2026-09-29T00:00:00Z',
                      'data': {'name': tool, 'arguments': {'action': action}}}
            row = B.normalize(record, json.dumps(record), '/agents/liv/sessions/s.jsonl', 's')
            self.assertEqual(row['kind'], 'action.tool')
        record['type'] = 'tool.result'
        record['data'] = {'name': 'write', 'output': 'done'}
        row = B.normalize(record, json.dumps(record), '/agents/liv/sessions/s.jsonl', 's')
        self.assertEqual(row['outcome'], 'unknown')
        record['data']['success'] = True
        row = B.normalize(record, json.dumps(record), '/agents/liv/sessions/s.jsonl', 's')
        self.assertEqual(row['outcome'], 'succeeded')

    def test_partial_trajectory_line_resumes_without_losing_event(self):
        sessions = self.root / 'agents/liv/sessions'
        sessions.mkdir(parents=True)
        path = sessions / 's.trajectory.jsonl'
        row = json.dumps({'type': 'tool.call', 'seq': 1, 'sessionId':'s', 'ts':'2026-09-29T00:00:00Z','data':{'name':'write'}})
        path.write_text(row[:20])
        data = self.root / 'data'
        self.assertEqual(B.build(str(data), str(self.root/'agents'))[1], 0)
        with path.open('a') as handle:
            handle.write(row[20:] + '\n')
        self.assertEqual(B.build(str(data), str(self.root/'agents'))[1], 1)
        self.assertEqual(B.build(str(data), str(self.root/'agents'))[1], 0)

    def test_schema_validates_emitted_events_and_rejects_incomplete_metadata(self):
        schema = json.loads((ROOT/'schemas/session-event.schema.json').read_text())
        Draft202012Validator.check_schema(schema)
        validator = Draft202012Validator(schema, format_checker=FormatChecker())
        for row in sample_run():
            validator.validate(row)
        for change in ({'authority': {'result': 'none', 'ref': None}},
                       {'sourceRef': {'type': 'raw', 'id': 'source'}},
                       {'policy': {'id': None, 'version': None, 'result': 'allowed'}},
                       {'details': {'prompt': 'private text'}}):
            row = dict(sample_run()[0], **change)
            self.assertTrue(list(validator.iter_errors(row)))
        row = sample_run()[-1]
        row['cost'] = {'status': 'unavailable', 'amount': 0, 'tokens': {}}
        self.assertTrue(list(validator.iter_errors(row)))

    def test_contract_kinds_and_legacy_versions_are_explicit(self):
        schema = json.loads((ROOT/'schemas/session-event.schema.json').read_text())
        self.assertEqual(schema['oneOf'][0]['properties']['schemaVersion']['enum'], [1,2])
        self.assertEqual(schema['oneOf'][1]['properties']['kind']['enum'], list(A.KINDS))
        self.assertFalse(schema['oneOf'][1]['additionalProperties'])


if __name__ == '__main__':
    unittest.main()
