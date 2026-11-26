#!/usr/bin/env python3
"""Render one launchd job per service in a manifest, each started by the service app.

Usage: render-jobs.py --manifest FILE --app FILE --runtime DIR --data-root DIR
                      [--check-paths] OUTPUT_DIR

Writes OUTPUT_DIR/<labelPrefix>.<name>.plist for every service and prints each
label on its own line in manifest order. Nothing is written unless the whole
manifest is valid. --check-paths also requires every placeholder path in a
command to exist and the program to be executable, for use on the host just
before install.
"""
import argparse
import json
import os
import plistlib
import re
import sys

NAME = re.compile(r"^[a-z][a-z0-9-]*$")
LABEL_PREFIX = re.compile(r"^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$")
PLACEHOLDER = re.compile(r"\{[A-Za-z]+\}")
SERVICE_KEYS = {"name", "source", "replaces", "command", "trigger", "environment", "workingDirectory",
                "throttleSeconds", "processType", "lowPriority", "watchPaths", "logs"}
CALENDAR_KEYS = {"Minute", "Hour", "Day", "Weekday", "Month"}
PROCESS_TYPES = {"Background", "Standard", "Adaptive", "Interactive"}


class ManifestError(ValueError):
    pass


def require(condition, message):
    if not condition:
        raise ManifestError(message)


def absolute(value, where):
    require(isinstance(value, str) and value.startswith("/") and not PLACEHOLDER.search(value),
            f"{where} must resolve to an absolute path")
    return value


def substitute(value, values, where):
    require(isinstance(value, str), f"{where} must be a string")
    result = value.replace("{runtime}", values["runtime"]).replace("{dataRoot}", values["dataRoot"])
    require(not PLACEHOLDER.search(result), f"{where} has an unknown placeholder: {value}")
    return result


def calendar_entry(entry, where):
    require(isinstance(entry, dict) and entry and set(entry) <= CALENDAR_KEYS,
            f"{where} keys must be among {sorted(CALENDAR_KEYS)}")
    for key, value in entry.items():
        require(isinstance(value, int) and not isinstance(value, bool) and value >= 0, f"{where}.{key} must be an integer")
    return dict(entry)


def trigger_keys(trigger, where):
    require(isinstance(trigger, dict) and len(trigger) == 1,
            f"{where} needs exactly one of keepAlive, everySeconds, calendar")
    (kind, value), = trigger.items()
    if kind == "keepAlive":
        require(value is True, f"{where}.keepAlive must be true")
        return {"KeepAlive": True, "RunAtLoad": True}
    if kind == "everySeconds":
        require(isinstance(value, int) and not isinstance(value, bool) and value > 0,
                f"{where}.everySeconds must be a positive integer")
        return {"StartInterval": value, "RunAtLoad": True}
    if kind == "calendar":
        if isinstance(value, list):
            require(value, f"{where}.calendar must not be empty")
            entries = [calendar_entry(item, f"{where}.calendar[{index}]") for index, item in enumerate(value)]
            return {"StartCalendarInterval": entries, "RunAtLoad": False}
        return {"StartCalendarInterval": calendar_entry(value, f"{where}.calendar"), "RunAtLoad": False}
    raise ManifestError(f"{where} needs exactly one of keepAlive, everySeconds, calendar")


def load_app(app):
    require(isinstance(app, dict), "app setting must be an object")
    for key in ("name", "bundleIdentifier", "path"):
        require(isinstance(app.get(key), str) and app[key], f"app setting needs {key}")
    require(app["path"].startswith("/") and app["path"].endswith(".app"), "app path must be an absolute .app path")
    require("/" not in app["name"], "app name must not contain /")
    return os.path.join(app["path"], "Contents", "MacOS", app["name"]), app["bundleIdentifier"]


def render(manifest, app, runtime, data_root):
    """Return [(label, job, declared command)] for a valid manifest or raise ManifestError."""
    values = {"runtime": absolute(runtime, "--runtime").rstrip("/") or "/",
              "dataRoot": absolute(data_root, "--data-root").rstrip("/") or "/"}
    launcher, bundle_id = load_app(app)
    require(isinstance(manifest, dict) and manifest.get("schemaVersion") == 1, "manifest schemaVersion must be 1")
    require(set(manifest) <= {"schemaVersion", "labelPrefix", "services"}, "manifest has unknown keys")
    prefix = manifest.get("labelPrefix")
    require(isinstance(prefix, str) and LABEL_PREFIX.match(prefix), "labelPrefix must be reverse-DNS, like com.example")
    services = manifest.get("services")
    require(isinstance(services, list) and services, "manifest needs a nonempty services list")
    jobs, names, replaced = [], set(), set()
    for index, service in enumerate(services):
        require(isinstance(service, dict), f"services[{index}] must be an object")
        name = service.get("name")
        require(isinstance(name, str) and NAME.match(name), f"services[{index}].name must match {NAME.pattern}")
        where = f"service {name}"
        require(name not in names, f"{where} is declared twice")
        names.add(name)
        unknown = set(service) - SERVICE_KEYS
        require(not unknown, f"{where} has unknown keys: {sorted(unknown)}")
        source = service.get("source")
        require(source is None or (isinstance(source, str) and source and not source.startswith("/")
                                   and ".." not in source.split("/")), f"{where}.source must be a relative path")
        require(isinstance(service.get("replaces", []), list), f"{where}.replaces must be a list")
        for old in service.get("replaces", []):
            require(isinstance(old, str) and LABEL_PREFIX.match(old) and old not in replaced,
                    f"{where}.replaces must list distinct launchd labels")
            replaced.add(old)
        command = service.get("command")
        require(isinstance(command, list) and command, f"{where}.command must be a nonempty list")
        command = [substitute(arg, values, f"{where}.command[{i}]") for i, arg in enumerate(command)]
        absolute(command[0], f"{where}.command[0]")
        label = f"{prefix}.{name}"
        job = {
            "Label": label,
            "ProgramArguments": [launcher, "run", name, "--"] + command,
            "AssociatedBundleIdentifiers": [bundle_id],
        }
        # Unset means the macOS default, so a job keeps the priority it had before the manifest.
        if "processType" in service:
            require(service["processType"] in PROCESS_TYPES, f"{where}.processType must be one of {sorted(PROCESS_TYPES)}")
            job["ProcessType"] = service["processType"]
        job.update(trigger_keys(service.get("trigger"), f"{where}.trigger"))
        environment = service.get("environment")
        if environment is not None:
            require(isinstance(environment, dict) and all(isinstance(k, str) and k for k in environment),
                    f"{where}.environment must map names to strings")
            job["EnvironmentVariables"] = {k: substitute(v, values, f"{where}.environment.{k}") for k, v in environment.items()}
        if "workingDirectory" in service:
            job["WorkingDirectory"] = absolute(substitute(service["workingDirectory"], values, f"{where}.workingDirectory"),
                                               f"{where}.workingDirectory")
        if "throttleSeconds" in service:
            throttle = service["throttleSeconds"]
            require(isinstance(throttle, int) and not isinstance(throttle, bool) and throttle > 0,
                    f"{where}.throttleSeconds must be a positive integer")
            job["ThrottleInterval"] = throttle
        if "lowPriority" in service:
            require(isinstance(service["lowPriority"], bool), f"{where}.lowPriority must be a boolean")
            if service["lowPriority"]:
                job.update({"Nice": 10, "LowPriorityIO": True})
        if "watchPaths" in service:
            paths = service["watchPaths"]
            require(isinstance(paths, list) and paths, f"{where}.watchPaths must be a nonempty list")
            job["WatchPaths"] = [absolute(substitute(p, values, f"{where}.watchPaths"), f"{where}.watchPaths") for p in paths]
        if "logs" in service:
            logs = service["logs"]
            require(isinstance(logs, dict) and set(logs) == {"stdout", "stderr"}, f"{where}.logs needs stdout and stderr")
            job["StandardOutPath"] = absolute(substitute(logs["stdout"], values, f"{where}.logs.stdout"), f"{where}.logs.stdout")
            job["StandardErrorPath"] = absolute(substitute(logs["stderr"], values, f"{where}.logs.stderr"), f"{where}.logs.stderr")
        jobs.append((label, job, service.get("command")))
    clash = replaced & {label for label, _, _ in jobs}
    require(not clash, f"a service replaces a label the manifest installs: {sorted(clash)}")
    return jobs


def check_paths(jobs):
    """Require placeholder paths to exist and each program to be executable."""
    for label, job, raw in jobs:
        command = job["ProgramArguments"][4:]
        require(os.path.isfile(command[0]) and os.access(command[0], os.X_OK), f"{label}: {command[0]} is not executable")
        for original, resolved in zip(raw, command):
            if PLACEHOLDER.search(original):
                require(os.path.exists(resolved), f"{label}: {resolved} does not exist")


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--app", required=True)
    parser.add_argument("--runtime", required=True)
    parser.add_argument("--data-root", required=True)
    parser.add_argument("--check-paths", action="store_true")
    parser.add_argument("output")
    args = parser.parse_args(argv)
    try:
        with open(args.manifest, encoding="utf-8") as stream:
            manifest = json.load(stream)
        with open(args.app, encoding="utf-8") as stream:
            app = json.load(stream)
        jobs = render(manifest, app, args.runtime, args.data_root)
        if args.check_paths:
            check_paths(jobs)
        require(os.path.isdir(args.output), f"output folder does not exist: {args.output}")
    except (OSError, ValueError) as error:
        print(f"render-jobs: {error}", file=sys.stderr)
        return 1
    for label, job, _ in jobs:
        with open(os.path.join(args.output, f"{label}.plist"), "wb") as stream:
            plistlib.dump(job, stream, sort_keys=True)
        print(label)
    return 0


if __name__ == "__main__":
    sys.exit(main())
