#!/bin/bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
python3 - "$ROOT" <<'TEST'
import importlib.util, pathlib, plistlib, sys, tempfile
spec = importlib.util.spec_from_file_location("validator", pathlib.Path(sys.argv[1]) / "scripts/validate-launchagents.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
with tempfile.TemporaryDirectory() as folder:
    root = pathlib.Path(folder)
    valid = {"Label": "example.agent", "ProgramArguments": ["/bin/echo", "hello"]}
    target = root / "agent.plist"
    target.write_bytes(plistlib.dumps(valid))
    assert not module.validate(root)
    target.write_bytes(plistlib.dumps(valid).replace(b"<plist", b"<!-- invalid -- comment -->\n<plist", 1))
    assert module.validate(root), "strict XML must reject double hyphens in comments"
    target.write_bytes(plistlib.dumps(valid))
    (root / "duplicate.plist").write_bytes(plistlib.dumps(valid))
    assert module.validate(root), "duplicate labels must fail"
    (root / "duplicate.plist").unlink()
    for patch in ({"ProgramArguments": []}, {"ProgramArguments": ["relative"]}, {"StandardOutPath": "relative"}):
        target.write_bytes(plistlib.dumps({**valid, **patch}))
        assert module.validate(root), patch
print("LaunchAgent contracts passed")
TEST
