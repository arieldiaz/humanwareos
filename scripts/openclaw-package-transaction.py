#!/usr/bin/env python3
"""Stage and atomically swap the OpenClaw core package without touching state."""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import uuid
from pathlib import Path


def exists(path):
    return path.exists() or path.is_symlink()


def package_version(core):
    metadata = json.loads((core / "package.json").read_text())
    if metadata.get("name") != "openclaw" or not isinstance(metadata.get("version"), str):
        raise RuntimeError("package is not OpenClaw")
    if not (core / "openclaw.mjs").is_file():
        raise RuntimeError("OpenClaw executable is missing")
    return metadata["version"]


def validate(core, expected=None):
    if core.is_symlink() or not core.is_dir():
        raise RuntimeError("OpenClaw package must be a real directory")
    version = package_version(core)
    if expected and version != expected:
        raise RuntimeError(f"expected OpenClaw {expected}, found {version}")
    root = core.resolve()
    metadata = json.loads((core / "package.json").read_text())
    optional = metadata.get("optionalDependencies", {})
    for name in metadata.get("dependencies", {}):
        if name not in optional and not (core / "node_modules" / name / "package.json").is_file():
            raise RuntimeError(f"staged OpenClaw is missing dependency {name}")
    for directory, directories, files in os.walk(core, followlinks=False):
        for name in directories + files:
            candidate = Path(directory) / name
            if candidate.is_symlink() and not candidate.resolve(strict=True).is_relative_to(root):
                raise RuntimeError("staged OpenClaw contains an external symlink")
    return version


def write_json(path, value):
    temporary = path.with_name(f".{path.name}.{uuid.uuid4().hex}")
    temporary.write_text(json.dumps(value, indent=2) + "\n")
    temporary.chmod(0o600)
    os.replace(temporary, path)


def stage(transaction, version, npm):
    if not re.fullmatch(r"\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?", version):
        raise RuntimeError("an exact OpenClaw version is required")
    marker = transaction / "stage.json"
    core = transaction / "staged/node_modules/openclaw"
    if marker.is_file():
        validate(core, version)
        return
    if exists(transaction / "staged"):
        raise RuntimeError("incomplete staging exists; use a fresh transaction")
    transaction.mkdir(parents=True, exist_ok=True, mode=0o700)
    log = transaction / "stage-npm.log"
    with log.open("x") as stream:
        result = subprocess.run([
            npm, "--prefix", str(transaction / "staged"), "install", "--ignore-scripts",
            "--install-strategy=nested", "--no-audit", "--no-fund", "--save-exact",
            "--cache", str(transaction / "npm-cache"), f"openclaw@{version}",
        ], stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode:
        raise RuntimeError(f"npm staging failed with exit {result.returncode}; see {log}")
    validate(core, version)
    write_json(marker, {"version": version, "package": str(core)})


def install(transaction, target):
    marker = json.loads((transaction / "stage.json").read_text())
    source = transaction / "staged/node_modules/openclaw"
    version = validate(source, marker["version"])
    previous = validate(target)
    retained = transaction / "retained/openclaw"
    if exists(retained):
        raise RuntimeError("a previous package is already retained")
    retained.parent.mkdir(parents=True, mode=0o700)
    temporary = target.parent / f".openclaw-{uuid.uuid4().hex}"
    shutil.copytree(source, temporary, symlinks=True)
    os.replace(target, retained)
    try:
        os.replace(temporary, target)
    except Exception:
        os.replace(retained, target)
        raise
    write_json(transaction / "installed.json", {"version": version, "previousVersion": previous, "target": str(target)})


def restore(transaction, target):
    retained = transaction / "retained/openclaw"
    if not exists(retained):
        raise RuntimeError("no retained OpenClaw package is available")
    failed = transaction / f"failed/openclaw-{uuid.uuid4().hex}"
    failed.parent.mkdir(parents=True, mode=0o700)
    if exists(target):
        os.replace(target, failed)
    os.replace(retained, target)
    write_json(transaction / "restored.json", {"version": validate(target), "failedPackage": str(failed)})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("operation", choices=("stage", "install", "restore"))
    parser.add_argument("--transaction", type=Path, required=True)
    parser.add_argument("--version")
    parser.add_argument("--target", type=Path, default=Path("/opt/homebrew/lib/node_modules/openclaw"))
    parser.add_argument("--npm", default="/opt/homebrew/bin/npm")
    args = parser.parse_args()
    os.umask(0o077)
    try:
        if not args.transaction.is_absolute() or not args.target.is_absolute():
            raise RuntimeError("transaction and target paths must be absolute")
        if args.operation == "stage":
            if not args.version:
                raise RuntimeError("stage requires --version")
            stage(args.transaction, args.version, args.npm)
        elif args.operation == "install":
            install(args.transaction, args.target)
        else:
            restore(args.transaction, args.target)
        print(f"OpenClaw package {args.operation} complete: {args.transaction}")
        return 0
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.SubprocessError, RuntimeError) as error:
        print(f"OpenClaw package {args.operation} failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
