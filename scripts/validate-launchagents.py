"""Strict, read-only LaunchAgent validation before runtime publication."""
import pathlib
import plistlib
import sys


def validate(root):
    labels = set()
    failures = []
    for path in sorted(pathlib.Path(root).rglob("*.plist")):
        try:
            with path.open("rb") as stream:
                agent = plistlib.load(stream)
            label = agent.get("Label")
            if not isinstance(label, str) or not label or label in labels:
                raise ValueError("missing or duplicate Label")
            labels.add(label)
            args = agent.get("ProgramArguments")
            program = agent.get("Program")
            if args is not None and (not isinstance(args, list) or not args or
                                     any(not isinstance(a, str) for a in args)):
                raise ValueError("ProgramArguments must be a nonempty string array")
            executable = program if program is not None else (args[0] if args else None)
            if not isinstance(executable, str) or not executable.startswith("/"):
                raise ValueError("executable must be an absolute path")
            for key in ("StandardOutPath", "StandardErrorPath", "WorkingDirectory"):
                if key in agent and (not isinstance(agent[key], str) or not agent[key].startswith("/")):
                    raise ValueError(f"{key} must be an absolute path")
        except Exception as error:
            failures.append(f"{path}: {error}")
    return failures


if __name__ == "__main__":
    if len(sys.argv) != 2 or not pathlib.Path(sys.argv[1]).is_dir():
        sys.exit("Usage: validate-launchagents.py SERVICES_DIRECTORY")
    errors = validate(sys.argv[1])
    for error in errors:
        print(error, file=sys.stderr)
    sys.exit(bool(errors))
