import copy
import importlib.util
import json
import os
import plistlib
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
SCRIPT = HERE / "render-jobs.py"
spec = importlib.util.spec_from_file_location("render_jobs", SCRIPT)
render_jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(render_jobs)

APP = {"schemaVersion": 1, "name": "Example Services", "bundleIdentifier": "org.example.services",
       "path": "/Applications/Example Services.app", "signingIdentity": "Developer ID Application: Example"}
LAUNCHER = "/Applications/Example Services.app/Contents/MacOS/Example Services"
MANIFEST = {
    "schemaVersion": 1,
    "labelPrefix": "org.example",
    "services": [
        {"name": "web", "source": "caddy", "replaces": ["org.old.caddy"],
         "command": ["/bin/sh", "{runtime}/config/services/caddy/run.sh"],
         "trigger": {"keepAlive": True}, "throttleSeconds": 60,
         "logs": {"stdout": "/var/log/web.log", "stderr": "/var/log/web.err.log"}},
        {"name": "sync", "command": ["/bin/sh", "{runtime}/sync.sh"], "trigger": {"everySeconds": 300},
         "environment": {"DATA": "{dataRoot}", "PATH": "/usr/bin:/bin"}, "workingDirectory": "{dataRoot}",
         "watchPaths": ["{dataRoot}/events.jsonl"], "processType": "Standard"},
        {"name": "backup", "command": ["{dataRoot}/backup.sh"], "trigger": {"calendar": {"Hour": 2, "Minute": 15}},
         "lowPriority": True},
    ],
}


def render(manifest=MANIFEST, app=APP):
    return render_jobs.render(manifest, app, "/rt/current", "/data")


class RenderTests(unittest.TestCase):
    def test_every_job_is_started_by_the_app_launcher_under_one_label_scheme(self):
        jobs = {label: job for label, job, _ in render()}
        self.assertEqual(list(jobs), ["org.example.web", "org.example.sync", "org.example.backup"])
        web = jobs["org.example.web"]
        self.assertEqual(web["ProgramArguments"],
                         [LAUNCHER, "run", "web", "--", "/bin/sh", "/rt/current/config/services/caddy/run.sh"])
        self.assertEqual(web["AssociatedBundleIdentifiers"], ["org.example.services"])
        self.assertEqual(web["ProcessType"], "Background")
        self.assertEqual((web["KeepAlive"], web["RunAtLoad"], web["ThrottleInterval"]), (True, True, 60))
        self.assertEqual((web["StandardOutPath"], web["StandardErrorPath"]), ("/var/log/web.log", "/var/log/web.err.log"))
        self.assertNotIn("replaces", web)
        self.assertNotIn("source", web)

    def test_placeholders_triggers_and_options_render(self):
        jobs = {label: job for label, job, _ in render()}
        sync, backup = jobs["org.example.sync"], jobs["org.example.backup"]
        self.assertEqual((sync["StartInterval"], sync["RunAtLoad"]), (300, True))
        self.assertEqual(sync["EnvironmentVariables"], {"DATA": "/data", "PATH": "/usr/bin:/bin"})
        self.assertEqual(sync["WorkingDirectory"], "/data")
        self.assertEqual(sync["WatchPaths"], ["/data/events.jsonl"])
        self.assertEqual(sync["ProcessType"], "Standard")
        self.assertEqual(backup["ProgramArguments"][4:], ["/data/backup.sh"])
        self.assertEqual((backup["StartCalendarInterval"], backup["RunAtLoad"]), ({"Hour": 2, "Minute": 15}, False))
        self.assertEqual((backup["Nice"], backup["LowPriorityIO"]), (10, True))
        self.assertNotIn("StandardOutPath", backup)

    def test_invalid_manifests_are_rejected(self):
        def broken(change):
            manifest = copy.deepcopy(MANIFEST)
            change(manifest)
            return manifest

        cases = {
            "duplicate name": lambda m: m["services"].append(copy.deepcopy(m["services"][0])),
            "bad name": lambda m: m["services"][0].update(name="Web_1"),
            "no trigger": lambda m: m["services"][0].pop("trigger"),
            "two triggers": lambda m: m["services"][0].update(trigger={"keepAlive": True, "everySeconds": 5}),
            "false keepAlive": lambda m: m["services"][0].update(trigger={"keepAlive": False}),
            "zero interval": lambda m: m["services"][1].update(trigger={"everySeconds": 0}),
            "bad calendar key": lambda m: m["services"][2].update(trigger={"calendar": {"hour": 2}}),
            "relative program": lambda m: m["services"][0].update(command=["sh", "run.sh"]),
            "unknown placeholder": lambda m: m["services"][0].update(command=["{home}/run.sh"]),
            "relative log": lambda m: m["services"][0].update(logs={"stdout": "web.log", "stderr": "/e"}),
            "half logs": lambda m: m["services"][0].update(logs={"stdout": "/o"}),
            "unknown key": lambda m: m["services"][0].update(keepalive=True),
            "unknown process type": lambda m: m["services"][0].update(processType="Fast"),
            "schema": lambda m: m.update(schemaVersion=2),
            "label prefix": lambda m: m.update(labelPrefix="example"),
            "replaces itself": lambda m: m["services"][1].update(replaces=["org.example.web"]),
            "replaced twice": lambda m: m["services"][1].update(replaces=["org.old.caddy"]),
            "source escapes": lambda m: m["services"][0].update(source="../caddy"),
            "empty services": lambda m: m.update(services=[]),
        }
        for name, change in cases.items():
            with self.subTest(name), self.assertRaises(render_jobs.ManifestError):
                render(broken(change))
        for name, app in {"relative app": dict(APP, path="Example.app"), "no bundle id": dict(APP, bundleIdentifier="")}.items():
            with self.subTest(name), self.assertRaises(render_jobs.ManifestError):
                render(app=app)
        with self.assertRaises(render_jobs.ManifestError):
            render_jobs.render(MANIFEST, APP, "relative", "/data")

    def test_check_paths_requires_placeholder_paths_and_an_executable_program(self):
        with tempfile.TemporaryDirectory() as folder:
            script = Path(folder, "job.sh")
            script.write_text("#!/bin/sh\n")
            manifest = {"schemaVersion": 1, "labelPrefix": "org.example",
                        "services": [{"name": "job", "command": ["{dataRoot}/job.sh"], "trigger": {"keepAlive": True}}]}
            jobs = render_jobs.render(manifest, APP, "/rt", folder)
            with self.assertRaises(render_jobs.ManifestError):
                render_jobs.check_paths(jobs)
            script.chmod(0o755)
            render_jobs.check_paths(jobs)
            script.unlink()
            with self.assertRaises(render_jobs.ManifestError):
                render_jobs.check_paths(jobs)


class CommandLineTests(unittest.TestCase):
    def run_cli(self, folder, manifest):
        Path(folder, "services.json").write_text(json.dumps(manifest))
        Path(folder, "app.json").write_text(json.dumps(APP))
        output = Path(folder, "out")
        output.mkdir(exist_ok=True)
        return subprocess.run([sys.executable, str(SCRIPT), "--manifest", f"{folder}/services.json", "--app",
                               f"{folder}/app.json", "--runtime", "/rt/current", "--data-root", "/data", str(output)],
                              capture_output=True, text=True), output

    def test_writes_one_linted_plist_per_service_and_prints_labels_in_order(self):
        with tempfile.TemporaryDirectory() as folder:
            result, output = self.run_cli(folder, MANIFEST)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(result.stdout.split(), ["org.example.web", "org.example.sync", "org.example.backup"])
            self.assertEqual(sorted(os.listdir(output)), sorted(f"{label}.plist" for label in result.stdout.split()))
            for name in os.listdir(output):
                subprocess.run(["/usr/bin/plutil", "-lint", str(output / name)], check=True, capture_output=True)
                with open(output / name, "rb") as stream:
                    self.assertEqual(plistlib.load(stream)["Label"] + ".plist", name)

    def test_an_invalid_manifest_writes_nothing(self):
        with tempfile.TemporaryDirectory() as folder:
            manifest = copy.deepcopy(MANIFEST)
            manifest["services"][2]["trigger"] = {}
            result, output = self.run_cli(folder, manifest)
            self.assertEqual(result.returncode, 1)
            self.assertIn("service backup.trigger", result.stderr)
            self.assertEqual(os.listdir(output), [])


if __name__ == "__main__":
    unittest.main()
