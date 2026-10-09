import copy
from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
from types import SimpleNamespace
from unittest import mock
import unittest

module = importlib.util.spec_from_file_location('deploy_once', Path(__file__).resolve().parent.parent / 'scripts' / 'deploy-once.py')
once = importlib.util.module_from_spec(module)
module.loader.exec_module(once)


class SupervisorTests(unittest.TestCase):
    def setUp(self):
        self.label = once.PREFIX + 'a' * 32
        self.path = Path('/reports/job.plist')
        self.deploy = Path('/framework/scripts/openclaw-deploy.sh')
        self.spec = once.job_spec(self.label, self.deploy, '/framework', '/instance', '/approval', self.path.parent)
        self.output = f'gui/501/{self.label} = {{\n path = {self.path}\n pid = 123\n}}'

    def verify(self, spec=None, output=None, label=None):
        once.verify_supervisor(label or self.label, 123, output or self.output,
                               self.spec if spec is None else spec, self.path, self.deploy)

    def test_independent_one_shot(self):
        self.verify()

    def test_wrong_pid_or_plist(self):
        for output in (self.output.replace('123', '456'), self.output.replace('/reports/', '/elsewhere/')):
            with self.subTest(output=output), self.assertRaises(ValueError):
                self.verify(output=output)

    def test_repeating_or_substituted_job_rejected(self):
        changes = [('KeepAlive', True), ('KeepAlive', {'SuccessfulExit': False}),
                   ('StartInterval', 10), ('StartCalendarInterval', {'Minute': 0}),
                   ('WatchPaths', ['/tmp']), ('RunAtLoad', False),
                   ('Program', '/bin/sh'), ('Label', 'different')]
        for key, value in changes:
            spec = copy.deepcopy(self.spec)
            spec[key] = value
            with self.subTest(key=key, value=value), self.assertRaises(ValueError):
                self.verify(spec=spec)

    def test_foreign_supervisor(self):
        with self.assertRaises(ValueError):
            self.verify(label='com.apple.Terminal')

    def test_changed_entrypoint(self):
        spec = copy.deepcopy(self.spec)
        spec['ProgramArguments'][0] = '/another/deploy.sh'
        with self.assertRaises(ValueError):
            self.verify(spec=spec)

    def test_pinned_version_argument(self):
        spec = once.job_spec(self.label, self.deploy, '/framework', '/instance', '/approval', self.path.parent, '2026.9.8')
        self.assertEqual(spec['ProgramArguments'][-2:], ['--openclaw-version', '2026.9.8'])
        self.verify(spec=spec)
        spec['ProgramArguments'][6] = '--staged-package'
        with self.assertRaises(ValueError):
            self.verify(spec=spec)

    def test_missing_approval_argument(self):
        spec = copy.deepcopy(self.spec)
        spec['ProgramArguments'] = spec['ProgramArguments'][:4]
        with self.assertRaises(ValueError):
            self.verify(spec=spec)


class ApprovalTests(unittest.TestCase):
    def test_record_is_scoped_and_expires_in_thirty_minutes(self):
        now = datetime(2026, 10, 2, 12, 0, tzinfo=timezone.utc)
        record = once.approval_record('example-os', 'Operator', 'deploy', 'https://pr', 'session', 'thread', False, now)
        self.assertEqual((record['action'], record['decision'], record['instanceId']), ('gateway-restart', 'approve', 'example-os'))
        self.assertEqual((record['approvedAt'], record['expiresAt']), ('2026-10-02T12:00:00Z', '2026-10-02T12:30:00Z'))
        self.assertIs(record['allowActiveSessions'], False)
        self.assertRegex(record['approvalId'], r'^[A-Za-z0-9._-]+$')

    def test_wake_returns_to_exact_slack_thread(self):
        args = SimpleNamespace(agent='agent-a', channel='C1', thread='1.2')
        completed = subprocess.CompletedProcess([], 0, '{"job":{"id":"wake-1"}}', '')
        with mock.patch.object(once.subprocess, 'run', return_value=completed) as run:
            self.assertEqual(once.schedule_wake(args, 'approval-1', '/reports/job'), 'wake-1')
        command = run.call_args.args[0]
        self.assertEqual(command[command.index('--agent') + 1], 'agent-a')
        self.assertEqual(command[command.index('--to') + 1], 'channel:C1')
        self.assertNotIn('--thread-id', command, 'a Slack ts is not a Telegram topic id')
        self.assertEqual(command[command.index('--to') + 1], 'channel:C1')
        self.assertIn('--delete-after-run', command)

    def test_launch_removes_approval_and_wake_when_handoff_fails(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(framework='/framework', instance=directory, agent='agent-a', openclaw_version=None)
            (Path(directory) / 'humanware.instance.json').write_text(json.dumps(
                {'id': 'example-os', 'agents': ['agent-a'], 'paths': {'dataRoot': directory}}))
            approval = Path(directory) / 'approval.json'
            approval.write_text('{}')
            with mock.patch.object(once, 'write_approval', return_value=approval), \
                    mock.patch.object(once, 'schedule_wake', return_value='wake-1'), \
                    mock.patch.object(once, 'cancel_wake') as cancel, \
                    mock.patch.object(once, 'submit', side_effect=OSError('bootstrap failed')):
                with self.assertRaises(OSError):
                    once.launch(args)
            self.assertFalse(approval.exists())
            cancel.assert_called_once_with('wake-1')

    def test_launch_rejects_agent_outside_instance_manifest(self):
        with tempfile.TemporaryDirectory() as directory:
            args = SimpleNamespace(framework='/framework', instance=directory, agent='stranger', openclaw_version=None)
            (Path(directory) / 'humanware.instance.json').write_text(json.dumps(
                {'id': 'example-os', 'agents': ['agent-a'], 'paths': {'dataRoot': directory}}))
            with mock.patch.object(once, 'write_approval') as write:
                with self.assertRaises(ValueError):
                    once.launch(args)
            write.assert_not_called()

    def test_submit_requires_the_framework_that_owns_the_launcher(self):
        with tempfile.TemporaryDirectory() as directory:
            approval = Path(directory) / 'approval.json'
            approval.write_text('{}')
            with self.assertRaises(ValueError):
                once.submit(directory, directory, approval)


if __name__ == '__main__':
    unittest.main()
