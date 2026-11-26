#!/usr/bin/env python3
"""Start a launchd job that another installer writes through the service app.

Usage:
  adopt-job.py wrap   --job FILE --app FILE --name NAME
  adopt-job.py unwrap --job FILE --app FILE
  adopt-job.py apply  --job FILE --app FILE --name NAME --report FILE [--timeout S] -- HEALTH...
  adopt-job.py launch --job FILE --app FILE --name NAME --report-dir DIR [--timeout S] -- HEALTH...

wrap rewrites the job in place so ProgramArguments becomes
[<launcher>, "run", NAME, "--", ...original] and AssociatedBundleIdentifiers is
the app's bundle identifier; every other key is kept and a job already wrapped
is left byte-identical. unwrap is the inverse, for an installer that must read
its own form back. apply wraps the job and reloads it in launchd, waits for
HEALTH to exit 0, and otherwise restores and reloads the saved original; it
refuses to run inside the job's own process tree. launch hands apply to a
one-shot launchd job so it can run from inside that tree.
"""
import argparse
import json
import os
import plistlib
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import uuid

LAUNCHCTL = os.environ.get("LAUNCHCTL", "/bin/launchctl")
PLUTIL = "/usr/bin/plutil"
ONE_SHOT_PREFIX = "com.humanwareos.cutover.gateway-app."  # the cutover's prune boots finished ones out


class AdoptError(Exception):
    pass


def load_app(path):
    with open(path, encoding="utf-8") as stream:
        app = json.load(stream)
    for key in ("name", "bundleIdentifier", "path"):
        if not isinstance(app.get(key), str) or not app[key]:
            raise AdoptError(f"app setting needs {key}")
    return os.path.join(app["path"], "Contents", "MacOS", app["name"]), app["bundleIdentifier"]


def read_job(path):
    lint = subprocess.run([PLUTIL, "-lint", "-s", path], capture_output=True, text=True)
    if lint.returncode != 0:
        raise AdoptError(f"{path} does not lint: {(lint.stdout + lint.stderr).strip()}")
    with open(path, "rb") as stream:
        data = stream.read()
    fmt = plistlib.FMT_BINARY if data.startswith(b"bplist") else plistlib.FMT_XML
    job = plistlib.loads(data)
    arguments = job.get("ProgramArguments")
    if not isinstance(job.get("Label"), str) or not isinstance(arguments, list) or not arguments \
            or not all(isinstance(arg, str) for arg in arguments):
        raise AdoptError(f"{path} needs a Label and a nonempty ProgramArguments list")
    return job, fmt


def write_job(path, job, fmt):
    """Replace the file atomically, keeping its permission bits."""
    mode = os.stat(path).st_mode & 0o7777
    descriptor, temporary = tempfile.mkstemp(dir=os.path.dirname(os.path.abspath(path)), prefix=".adopt-")
    try:
        with os.fdopen(descriptor, "wb") as stream:
            plistlib.dump(job, stream, fmt=fmt, sort_keys=False)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def inner_command(arguments, launcher):
    """The original command when the job already runs through this launcher."""
    if len(arguments) > 4 and arguments[0] == launcher and arguments[1] == "run" and arguments[3] == "--":
        return arguments[4:]
    return arguments


def wrap(job_path, app_path, name):
    """Wrap the job in place; return True when the file changed."""
    if not re.fullmatch(r"[a-z][a-z0-9-]*", name or ""):
        raise AdoptError("service name must match [a-z][a-z0-9-]*")
    launcher, bundle_id = load_app(app_path)
    if not (os.path.isfile(launcher) and os.access(launcher, os.X_OK)):
        raise AdoptError(f"launcher is not executable: {launcher}")
    job, fmt = read_job(job_path)
    arguments = [launcher, "run", name, "--"] + inner_command(job["ProgramArguments"], launcher)
    if job["ProgramArguments"] == arguments and job.get("AssociatedBundleIdentifiers") == [bundle_id]:
        return False
    job["ProgramArguments"] = arguments
    job["AssociatedBundleIdentifiers"] = [bundle_id]
    write_job(job_path, job, fmt)
    return True


def unwrap(job_path, app_path):
    """Restore the installer's own command; return True when the file changed."""
    launcher, bundle_id = load_app(app_path)
    job, fmt = read_job(job_path)
    arguments = inner_command(job["ProgramArguments"], launcher)
    if arguments == job["ProgramArguments"]:
        return False
    job["ProgramArguments"] = arguments
    if job.get("AssociatedBundleIdentifiers") == [bundle_id]:
        del job["AssociatedBundleIdentifiers"]
    write_job(job_path, job, fmt)
    return True


def launchctl(*arguments, timeout=60):
    return subprocess.run([LAUNCHCTL, *arguments], capture_output=True, text=True, timeout=timeout)


def loaded_field(target, field):
    result = launchctl("print", target)
    if result.returncode != 0:
        return None
    match = re.search(rf"^\s*{field} = (.*?)\s*$", result.stdout, re.M)
    return match.group(1) if match else ""


def inside_tree(label, target):
    if os.environ.get("XPC_SERVICE_NAME") == label:
        return True
    pid = loaded_field(target, "pid")
    if not pid or not pid.isdigit():
        return False
    current = os.getpid()
    while current > 1:
        if current == int(pid):
            return True
        parent = subprocess.run(["/bin/ps", "-o", "ppid=", "-p", str(current)], capture_output=True, text=True).stdout.strip()
        if not parent.isdigit():
            return False
        current = int(parent)
    return False


def reload(target, domain, job_path, stop_seconds=360, load_seconds=60):
    """Boot the job out and back in from job_path; True once launchd has it loaded.

    Stopping waits out a draining job (the gateway's ExitTimeOut is 330 s) before loading."""
    deadline = time.monotonic() + stop_seconds
    try:
        launchctl("bootout", target, timeout=stop_seconds)
    except subprocess.TimeoutExpired:
        pass
    while loaded_field(target, "state") is not None and time.monotonic() < deadline:
        time.sleep(0.5)
    deadline = time.monotonic() + load_seconds
    while True:
        if launchctl("bootstrap", domain, job_path).returncode == 0 or loaded_field(target, "state") is not None:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(1)


def healthy(command, deadline):
    while True:
        remaining = deadline - time.monotonic()
        try:
            if subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                              timeout=max(1, remaining)).returncode == 0:
                return True
        except (OSError, subprocess.TimeoutExpired):
            pass
        if time.monotonic() + 5 > deadline:
            return False
        time.sleep(5)


def write_report(path, report):
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    temporary = f"{path}.tmp"
    with open(temporary, "w", encoding="utf-8") as stream:
        json.dump(report, stream, indent=2)
        stream.write("\n")
    os.replace(temporary, path)


def apply(job_path, app_path, name, report_path, health, timeout):
    """Wrap and reload the job; on any failure restore the original and reload it."""
    report = {"job": job_path, "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "steps": []}
    step = report["steps"].append
    try:
        launcher, _ = load_app(app_path)
        job, _ = read_job(job_path)
        domain = f"gui/{os.getuid()}"
        target = f"{domain}/{job['Label']}"
        if inside_tree(job["Label"], target):
            raise AdoptError(f"refusing to reload {job['Label']} from inside its own process tree; use launch")
        saved = os.path.join(os.path.dirname(os.path.abspath(report_path)), "job.before.plist")
        os.makedirs(os.path.dirname(saved), exist_ok=True)
        shutil.copy2(job_path, saved)
        report["saved"] = saved
        changed = wrap(job_path, app_path, name)
        step("wrapped" if changed else "already wrapped")
        if not changed and loaded_field(target, "program") == launcher:
            report["result"] = "unchanged"
            return 0
    except (AdoptError, OSError, ValueError, subprocess.SubprocessError) as error:
        report.update(result="refused", error=str(error))
        return 1
    finally:
        if "result" in report:
            write_report(report_path, report)

    def interrupted(signum, _frame):
        raise AdoptError(f"interrupted by signal {signum}")

    for signum in (signal.SIGTERM, signal.SIGHUP, signal.SIGINT):
        signal.signal(signum, interrupted)
    try:
        if not reload(target, domain, job_path):
            raise AdoptError("launchd did not load the wrapped job")
        step("reloaded")
        if not healthy(health, time.monotonic() + timeout):
            raise AdoptError(f"no healthy answer within {timeout} seconds")
        step("healthy")
        report["result"] = "applied"
        return 0
    except BaseException as error:  # restore on every failure, including a signal
        report["error"] = str(error) or type(error).__name__
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        signal.signal(signal.SIGHUP, signal.SIG_IGN)
        shutil.copy2(saved, job_path)
        step("restored original")
        if reload(target, domain, job_path):
            step("reloaded original")
            report["result"] = "restored"
        else:
            report["result"] = "failed"
            report["critical"] = f"{job['Label']} is not loaded; run: launchctl bootstrap {domain} {job_path}"
        return 1
    finally:
        report["finishedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
        write_report(report_path, report)


def launch(job_path, app_path, name, report_dir, health, timeout):
    """Submit apply as a one-shot launchd job outside the caller's process tree."""
    load_app(app_path)
    read_job(job_path)
    label = ONE_SHOT_PREFIX + uuid.uuid4().hex
    directory = os.path.join(report_dir, label)
    os.makedirs(directory, mode=0o700)
    spec = {
        "Label": label,
        "ProgramArguments": ["/usr/bin/python3", os.path.abspath(__file__), "apply", "--job", os.path.abspath(job_path),
                             "--app", os.path.abspath(app_path), "--name", name,
                             "--report", os.path.join(directory, "report.json"), "--timeout", str(timeout), "--", *health],
        "EnvironmentVariables": {"PATH": os.environ.get("PATH", "/usr/bin:/bin:/usr/sbin:/sbin")},
        "RunAtLoad": True,
        "KeepAlive": False,
        "ProcessType": "Background",
        "StandardOutPath": os.path.join(directory, "stdout.log"),
        "StandardErrorPath": os.path.join(directory, "stderr.log"),
    }
    path = os.path.join(directory, "job.plist")
    with open(path, "xb") as stream:
        plistlib.dump(spec, stream)
    os.chmod(path, 0o600)
    result = launchctl("bootstrap", f"gui/{os.getuid()}", path)
    if result.returncode != 0:
        raise AdoptError(f"launchctl bootstrap failed: {(result.stderr or result.stdout).strip()}")
    print(json.dumps({"label": label, "report": os.path.join(directory, "report.json")}))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)
    for command in ("wrap", "unwrap", "apply", "launch"):
        sub = commands.add_parser(command)
        sub.add_argument("--job", required=True)
        sub.add_argument("--app", required=True)
        if command != "unwrap":
            sub.add_argument("--name", required=True)
        if command in ("apply", "launch"):
            sub.add_argument("--report" if command == "apply" else "--report-dir", required=True)
            sub.add_argument("--timeout", type=int, default=120)
            sub.add_argument("health", nargs="+")
    args = parser.parse_args(argv)
    try:
        if args.command == "wrap":
            print("wrapped" if wrap(args.job, args.app, args.name) else "unchanged")
        elif args.command == "unwrap":
            print("unwrapped" if unwrap(args.job, args.app) else "unchanged")
        elif args.command == "apply":
            status = apply(args.job, args.app, args.name, args.report, args.health, args.timeout)
            with open(args.report, encoding="utf-8") as stream:
                print(json.load(stream)["result"])
            return status
        else:
            return launch(args.job, args.app, args.name, args.report_dir, args.health, args.timeout)
    except (AdoptError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"adopt-job: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
