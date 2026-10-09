#!/usr/bin/env python3
"""Hand an approved cutover to an independent, non-restarting launchd job.

Instance values come from the instance's humanware.instance.json (`id`,
`paths.dataRoot`, `agents`); the launchd domain is the invoking user's; the
Slack channel and thread are arguments.
"""
import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import plistlib
import re
import shutil
import subprocess
import sys
import uuid

PREFIX = 'com.humanwareos.cutover.'
OPENCLAW = os.environ.get('OPENCLAW_BIN') or shutil.which('openclaw') or '/opt/homebrew/bin/openclaw'
DEPLOY = Path(__file__).resolve().with_name('openclaw-deploy.sh')


def load_manifest(instance):
    return json.loads((Path(instance) / 'humanware.instance.json').read_text())


def job_spec(label, deploy, framework, instance, approval, directory, version=None):
    version_arguments = ['--openclaw-version', version] if version else []
    return {
        'Label': label,
        'ProgramArguments': [str(deploy), '--apply', str(framework), str(instance),
                             '--approval-file', str(approval), *version_arguments],
        'RunAtLoad': True,
        'KeepAlive': False,
        'ProcessType': 'Background',
        'StandardOutPath': str(directory / 'stdout.log'),
        'StandardErrorPath': str(directory / 'stderr.log'),
    }


def verify_supervisor(label, pid, output, spec, plist_path, deploy):
    if not re.fullmatch(re.escape(PREFIX) + r'[0-9a-f]{32}', label):
        raise ValueError('not a managed one-shot cutover')
    fields = dict(re.findall(r'^\s*(path|pid) = (.*?)\s*$', output, re.M))
    if fields.get('pid') != str(pid) or fields.get('path') != str(plist_path):
        raise ValueError('launchd does not own this deployment PID and plist')
    arguments = spec.get('ProgramArguments', [])
    if (len(arguments) not in (6, 8) or arguments[0] != str(deploy) or arguments[1] != '--apply'
            or arguments[4] != '--approval-file' or arguments[6:7] not in ([], ['--openclaw-version'])):
        raise ValueError('unexpected deployment command')
    version = arguments[7] if len(arguments) == 8 else None
    expected = job_spec(label, deploy, arguments[2], arguments[3], arguments[5], plist_path.parent, version)
    if spec != expected or spec.get('KeepAlive') is not False or spec.get('RunAtLoad') is not True:
        raise ValueError('cutover job must run once without timers or keepalive')


def check(pid, label):
    if not label:
        return
    if not re.fullmatch(re.escape(PREFIX) + r'[0-9a-f]{32}', label):
        raise ValueError('unrecognized supervisor; launchctl submit creates an inferred keepalive service. Use deploy-once.py launch')
    result = subprocess.run(['/bin/launchctl', 'print', f'gui/{os.getuid()}/{label}'],
                            capture_output=True, text=True, check=True)
    paths = re.findall(r'^\s*path = (.*?)\s*$', result.stdout, re.M)
    if len(paths) != 1:
        raise ValueError('launchd job has no unique plist path')
    path = Path(paths[0])
    if not path.is_absolute() or path.is_symlink():
        raise ValueError('invalid job plist path')
    with path.open('rb') as stream:
        spec = plistlib.load(stream)
    verify_supervisor(label, pid, result.stdout, spec, path, DEPLOY)


def approval_record(instance_id, approved_by, reason, pull_request, session, thread, allow_active, now):
    stamp = lambda moment: moment.strftime('%Y-%m-%dT%H:%M:%SZ')
    return {
        'schemaVersion': 1,
        'approvalId': f"{now.strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:12]}",
        'decision': 'approve',
        'action': 'gateway-restart',
        'instanceId': instance_id,
        'approvedBy': approved_by,
        'reason': reason,
        'allowActiveSessions': allow_active,
        'provenance': {'initiatingSession': session, 'initiatingThread': thread, 'pullRequest': pull_request},
        'approvedAt': stamp(now),
        'expiresAt': stamp(now + timedelta(minutes=30)),
    }


def write_approval(manifest, args):
    thread = f'slack:{args.channel}:{args.thread}'
    record = approval_record(manifest['id'], args.approved_by, args.reason, args.pr, args.session, thread,
                             args.allow_active_sessions, datetime.now(timezone.utc))
    if not all(record[key] for key in ('approvedBy', 'reason')) or not all(record['provenance'].values()):
        raise ValueError('approver, reason, PR, session and thread are required')
    path = Path(manifest['paths']['dataRoot']) / 'operations/control/restart-approvals/pending' / f"{record['approvalId']}.json"
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as stream:
        json.dump(record, stream, indent=2)
    return path


def submit(framework, instance, approval, version=None, label=None):
    framework, instance, approval = (Path(value).resolve(strict=True) for value in (framework, instance, approval))
    deploy = DEPLOY
    if framework != deploy.parent.parent:
        raise ValueError('run the launcher from the framework checkout being deployed')
    data = Path(load_manifest(instance)['paths']['dataRoot'])
    label = label or PREFIX + uuid.uuid4().hex
    directory = data / 'generated/reports/cutover-jobs' / label
    directory.mkdir(parents=True, mode=0o700)
    path = directory / 'job.plist'
    with path.open('xb') as stream:
        plistlib.dump(job_spec(label, deploy, framework, instance, approval, directory, version), stream)
    path.chmod(0o600)
    subprocess.run(['/bin/launchctl', 'bootstrap', f'gui/{os.getuid()}', str(path)], check=True)
    return {'label': label, 'report': str(directory), 'state': 'submitted'}


def schedule_wake(args, approval_id, report):
    prompt = (
        f'Verify Humanware cutover {approval_id} using {report}. '
        'Read the cutover logs and active runtime manifest, then report success or the precise failure in this conversation. '
        'Do not start, retry, or restart anything. If the cutover is still running, schedule one new check 15 minutes later '
        'in this same conversation before ending.'
    )
    result = subprocess.run([
        OPENCLAW, 'automations', 'add', '--name', f'Cutover check {approval_id}', '--at', '30m',
        '--agent', args.agent, '--session', 'isolated', '--message', prompt, '--announce',
        '--channel', 'slack', '--account', args.agent, '--to', f'channel:{args.channel}',
        # The CLI accepts only integer Telegram topic ids here; a Slack thread ts is
        # kept in the approval provenance and the check posts to the channel.
        *(['--thread-id', args.thread] if args.thread.isdigit() else []),
        '--delete-after-run', '--json',
    ], capture_output=True, text=True, check=True)
    payload = json.loads(result.stdout)
    job = payload.get('job', payload)
    job_id = job.get('id') if isinstance(job, dict) else None
    if not job_id:
        raise ValueError('durable cutover wake returned no job ID')
    return job_id


def cancel_wake(job_id):
    subprocess.run([OPENCLAW, 'automations', 'rm', job_id, '--json'],
                   capture_output=True, text=True, check=True)


def launch(args):
    instance = Path(args.instance).resolve(strict=True)
    manifest = load_manifest(instance)
    if args.agent not in manifest.get('agents', []):
        raise ValueError(f"--agent must be one of the instance agents: {', '.join(manifest.get('agents', []))}")
    approval = write_approval(manifest, args)
    label = PREFIX + uuid.uuid4().hex
    report = Path(manifest['paths']['dataRoot']) / 'generated/reports/cutover-jobs' / label
    wake = None
    try:
        wake = schedule_wake(args, approval.stem, report)
        result = submit(args.framework, instance, approval, args.openclaw_version, label)
    except Exception as error:
        if wake:
            try:
                cancel_wake(wake)
            except (ValueError, OSError, subprocess.CalledProcessError) as cleanup_error:
                approval.unlink(missing_ok=True)
                raise ValueError(f'{error}; also failed to cancel durable wake {wake}: {cleanup_error}') from error
        approval.unlink(missing_ok=True)
        raise
    result['wake'] = wake
    print(json.dumps(result))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    launch_command = commands.add_parser(
        'launch', help="record the current human approval and start an independent one-shot cutover")
    launch_command.add_argument('framework')
    launch_command.add_argument('instance')
    launch_command.add_argument('--approved-by', required=True)
    launch_command.add_argument('--reason', required=True)
    launch_command.add_argument('--pr', required=True)
    launch_command.add_argument('--agent', required=True, help='an agent id from the instance manifest')
    launch_command.add_argument('--channel', required=True)
    launch_command.add_argument('--session', required=True)
    launch_command.add_argument('--thread', required=True)
    launch_command.add_argument('--allow-active-sessions', action='store_true')
    launch_command.add_argument('--openclaw-version')
    verify = commands.add_parser('check')
    verify.add_argument('pid', type=int)
    verify.add_argument('supervisor')
    args = parser.parse_args()
    try:
        if args.command == 'launch':
            launch(args)
        else:
            check(args.pid, args.supervisor)
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print(f'Cutover refused: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())
