import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).resolve().with_name("adopt-job.py")
COMMAND = ["/bin/sh", "/state/env-wrapper.sh", "/state/gateway.env", "/usr/bin/node", "/pkg/dist/index.js",
           "gateway", "--port", "18789"]
JOB = {
    "Label": "org.example.gateway", "Comment": "Example Gateway", "ProgramArguments": COMMAND,
    "KeepAlive": True, "RunAtLoad": True, "ProcessType": "Interactive", "ExitTimeOut": 330, "Umask": 63,
    "ThrottleInterval": 10, "WorkingDirectory": "/state", "StandardInPath": "/dev/null",
    "StandardOutPath": "/logs/gateway.log", "StandardErrorPath": "/logs/gateway.log",
}
# launchctl stand-in: one job, loaded while $STATE/loaded exists; every call is logged.
FAKE_LAUNCHCTL = """#!/bin/sh
S="$FAKE_STATE"
echo "$*" >> "$S/calls"
case "$1" in
  print) [ -f "$S/loaded" ] || exit 113; printf 'state = running\\nprogram = %s\\npid = %s\\n' "$(cat "$S/program")" "${FAKE_PID:-4242}" ;;
  bootout) rm -f "$S/loaded" ;;
  bootstrap) [ ! -f "$S/fail-bootstrap" ] || exit 5
    printf %s "$(/usr/bin/plutil -extract ProgramArguments.0 raw -o - "$3")" > "$S/program"; touch "$S/loaded" ;;
  *) exit 2 ;;
esac
"""


class AdoptJobTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.app_dir = self.root / "Example Services.app"
        self.launcher = self.app_dir / "Contents/MacOS/Example Services"
        self.launcher.parent.mkdir(parents=True)
        self.launcher.write_text("#!/bin/sh\n")
        self.launcher.chmod(0o755)
        self.app = self.root / "app.json"
        self.app.write_text(json.dumps({"schemaVersion": 1, "name": "Example Services",
                                        "bundleIdentifier": "org.example.services", "path": str(self.app_dir)}))
        self.job = self.root / "org.example.gateway.plist"
        self.write_job(JOB)
        self.state = self.root / "launchd"
        self.state.mkdir()
        (self.state / "program").write_text(COMMAND[0])
        (self.state / "loaded").touch()
        fake = self.root / "launchctl"
        fake.write_text(FAKE_LAUNCHCTL)
        fake.chmod(0o755)
        self.env = dict(os.environ, LAUNCHCTL=str(fake), FAKE_STATE=str(self.state))
        self.env.pop("XPC_SERVICE_NAME", None)
        self.health = self.root / "health"
        self.health.write_text(f'#!/bin/sh\necho checked >> "{self.root}/health-calls"\n[ ! -f "{self.root}/unhealthy" ]\n')
        self.health.chmod(0o755)

    def tearDown(self):
        self.temp.cleanup()

    def write_job(self, job, fmt=plistlib.FMT_XML):
        with self.job.open("wb") as stream:
            plistlib.dump(job, stream, fmt=fmt)
        self.job.chmod(0o644)

    def run_script(self, *arguments, env=None):
        return subprocess.run([sys.executable, str(SCRIPT), *arguments], capture_output=True, text=True,
                              env=env or self.env)

    def wrap(self, name="openclaw-gateway"):
        return self.run_script("wrap", "--job", str(self.job), "--app", str(self.app), "--name", name)

    def apply(self, *extra):
        report = self.root / "report/report.json"
        result = self.run_script("apply", "--job", str(self.job), "--app", str(self.app), "--name", "openclaw-gateway",
                                 "--report", str(report), *extra, "--", str(self.health))
        return result, json.loads(report.read_text())

    def loaded(self):
        with self.job.open("rb") as stream:
            return plistlib.load(stream)

    def calls(self):
        path = self.state / "calls"
        return [line.split()[0] for line in path.read_text().splitlines()] if path.exists() else []

    def test_wrap_prefixes_the_launcher_and_preserves_every_other_key(self):
        result = self.wrap()
        self.assertEqual(result.returncode, 0, result.stderr)
        job = self.loaded()
        self.assertEqual(job["ProgramArguments"], [str(self.launcher), "run", "openclaw-gateway", "--", *COMMAND])
        self.assertEqual(job["AssociatedBundleIdentifiers"], ["org.example.services"])
        self.assertEqual({k: v for k, v in job.items() if k not in ("ProgramArguments", "AssociatedBundleIdentifiers")},
                         {k: v for k, v in JOB.items() if k != "ProgramArguments"})
        self.assertEqual(self.job.stat().st_mode & 0o777, 0o644)

    def test_wrap_is_idempotent_and_byte_identical(self):
        self.wrap()
        before = self.job.read_bytes()
        stat = self.job.stat()
        result = self.wrap()
        self.assertEqual(result.stdout.strip(), "unchanged")
        self.assertEqual(self.job.read_bytes(), before)
        self.assertEqual(self.job.stat().st_ino, stat.st_ino)

    def test_wrap_keeps_a_binary_plist_binary(self):
        self.write_job(JOB, plistlib.FMT_BINARY)
        self.wrap()
        self.assertTrue(self.job.read_bytes().startswith(b"bplist"))

    def test_unwrap_restores_the_installer_form(self):
        self.wrap()
        result = self.run_script("unwrap", "--job", str(self.job), "--app", str(self.app))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(self.loaded(), JOB)
        self.assertEqual(self.run_script("unwrap", "--job", str(self.job), "--app", str(self.app)).stdout.strip(), "unchanged")

    def test_wrap_refuses_a_missing_launcher(self):
        self.launcher.unlink()
        before = self.job.read_bytes()
        result = self.wrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn("launcher is not executable", result.stderr)
        self.assertEqual(self.job.read_bytes(), before)

    def test_wrap_refuses_a_job_that_does_not_lint(self):
        self.job.write_text("<plist><dict><key>Label</key>")
        result = self.wrap()
        self.assertEqual(result.returncode, 1)
        self.assertIn("does not lint", result.stderr)

    def test_apply_wraps_reloads_and_checks_health(self):
        result, report = self.apply()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(report["result"], "applied")
        self.assertEqual(self.calls()[-3:], ["bootout", "print", "bootstrap"])
        self.assertEqual((self.state / "program").read_text(), str(self.launcher))
        self.assertEqual(plistlib.loads(Path(report["saved"]).read_bytes()), JOB)
        # A second run finds the job wrapped and loaded, and touches nothing.
        (self.state / "calls").unlink()
        result, report = self.apply()
        self.assertEqual(report["result"], "unchanged")
        self.assertNotIn("bootout", self.calls())

    def test_apply_restores_and_reloads_the_original_when_unhealthy(self):
        (self.root / "unhealthy").touch()
        original = self.job.read_bytes()
        result, report = self.apply("--timeout", "1")
        self.assertEqual(result.returncode, 1)
        self.assertEqual(report["result"], "restored")
        self.assertIn("no healthy answer", report["error"])
        self.assertEqual(self.job.read_bytes(), original)
        self.assertEqual(self.calls().count("bootstrap"), 2)
        self.assertTrue((self.state / "loaded").exists())
        self.assertEqual((self.state / "program").read_text(), COMMAND[0])

    def test_apply_restores_when_the_wrapped_job_will_not_load(self):
        original = self.job.read_bytes()
        fake = self.root / "launchctl"
        # The first bootstrap fails; the restore's bootstrap succeeds.
        fake.write_text(FAKE_LAUNCHCTL.replace('[ ! -f "$S/fail-bootstrap" ] || exit 5',
                                               'if [ ! -f "$S/failed" ]; then touch "$S/failed"; exit 5; fi'))
        env = dict(self.env)
        result = subprocess.run([sys.executable, "-c", (
            "import importlib.util,sys;"
            f"spec=importlib.util.spec_from_file_location('a','{SCRIPT}');m=importlib.util.module_from_spec(spec);"
            "spec.loader.exec_module(m);m.reload.__defaults__=(5,0);"
            f"sys.exit(m.apply('{self.job}','{self.app}','openclaw-gateway','{self.root}/report/report.json',['{self.health}'],5))")],
            capture_output=True, text=True, env=env)
        report = json.loads((self.root / "report/report.json").read_text())
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(report["result"], "restored")
        self.assertEqual(self.job.read_bytes(), original)
        self.assertTrue((self.state / "loaded").exists())

    def test_apply_refuses_inside_the_jobs_process_tree(self):
        env = dict(self.env, FAKE_PID=str(os.getpid()))
        before = self.job.read_bytes()
        result = self.run_script("apply", "--job", str(self.job), "--app", str(self.app), "--name", "openclaw-gateway",
                                 "--report", str(self.root / "r.json"), "--", str(self.health), env=env)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads((self.root / "r.json").read_text())["result"], "refused")
        self.assertEqual(self.job.read_bytes(), before)
        self.assertNotIn("bootout", self.calls())

    def test_launch_submits_a_one_shot_apply(self):
        reports = self.root / "reports"
        reports.mkdir()
        result = self.run_script("launch", "--job", str(self.job), "--app", str(self.app), "--name", "openclaw-gateway",
                                 "--report-dir", str(reports), "--", str(self.health), "status")
        self.assertEqual(result.returncode, 0, result.stderr)
        label = json.loads(result.stdout)["label"]
        self.assertTrue(label.startswith("com.humanwareos.cutover.gateway-app."))
        spec = plistlib.loads((reports / label / "job.plist").read_bytes())
        self.assertEqual(spec["KeepAlive"], False)
        self.assertEqual(spec["RunAtLoad"], True)
        self.assertEqual(spec["ProgramArguments"][2:4], ["apply", "--job"])
        self.assertEqual(spec["ProgramArguments"][-3:], ["--", str(self.health), "status"])
        self.assertIn(f"bootstrap gui/{os.getuid()} {reports / label / 'job.plist'}",
                      (self.state / "calls").read_text())
        self.assertEqual(self.loaded(), JOB)  # launch itself changes nothing


if __name__ == "__main__":
    unittest.main()
