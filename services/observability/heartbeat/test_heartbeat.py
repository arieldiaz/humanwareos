import importlib.util
import json
import os
import pathlib
import shutil
import tempfile
import unittest
from datetime import timedelta
from unittest import mock


# The module reads its instance config and data root at import time.
os.environ["HEARTBEAT_CONFIG"] = str(
    pathlib.Path(__file__).with_name("config.example.json"))
os.environ["HUMANWARE_DATA_ROOT"] = tempfile.mkdtemp()
MODULE_PATH = pathlib.Path(__file__).with_name("heartbeat.py")
SPEC = importlib.util.spec_from_file_location("heartbeat", MODULE_PATH)
heartbeat = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(heartbeat)


class DispatchVerificationTests(unittest.TestCase):
    def test_missing_activity_with_healthy_canaries_does_not_escalate(self):
        with mock.patch.object(heartbeat, "check_canary", return_value=None):
            self.assertIsNone(
                heartbeat.verify_dispatch_suspicion("missing activity"))

    def test_one_healthy_canary_does_not_escalate(self):
        with mock.patch.object(
                heartbeat, "check_canary",
                side_effect=["agent-a failed", None]):
            self.assertIsNone(
                heartbeat.verify_dispatch_suspicion("missing activity"))

    def test_both_failed_canaries_corroborate_suspicion(self):
        with mock.patch.object(
                heartbeat, "check_canary",
                side_effect=["agent-a failed", "agent-b failed"]):
            result = heartbeat.verify_dispatch_suspicion("missing activity")
        self.assertIn("both agent canaries failed", result)


class RemediationTests(unittest.TestCase):
    def state(self):
        return {"checks": {}, "run": 0, "restarts": []}

    def test_successful_verified_restart_is_silent(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_budget_left", return_value=1), \
                mock.patch.object(heartbeat, "active_agent_runs", return_value=0), \
                mock.patch.object(heartbeat, "restart_gateway", return_value=True):
            self.assertEqual(
                heartbeat.process(state, "gateway", "gateway down"), [])
            self.assertEqual(
                heartbeat.process(state, "gateway", "gateway down"), [])
        self.assertEqual(state["checks"]["gateway"]["fails"], 0)
        self.assertFalse(state["checks"]["gateway"]["alerting"])

    def test_missing_launchd_service_is_bootstrapped(self):
        completed = mock.Mock(returncode=0)
        with mock.patch.object(
                heartbeat, "gateway_service_registered", return_value=False), \
                mock.patch.object(
                    heartbeat.subprocess, "run", return_value=completed) as run:
            self.assertTrue(heartbeat.start_gateway_service())
        run.assert_called_once_with(
            ["launchctl", "bootstrap", heartbeat.GATEWAY_DOMAIN,
             heartbeat.GATEWAY_PLIST],
            capture_output=True, text=True, timeout=60)

    def test_registered_launchd_service_is_kickstarted(self):
        completed = mock.Mock(returncode=0)
        with mock.patch.object(
                heartbeat, "gateway_service_registered", return_value=True), \
                mock.patch.object(
                    heartbeat.subprocess, "run", return_value=completed) as run:
            self.assertTrue(heartbeat.start_gateway_service())
        run.assert_called_once_with(
            ["launchctl", "kickstart", "-k", heartbeat.GATEWAY_SERVICE],
            capture_output=True, text=True, timeout=60)

    def test_weak_dispatch_signal_can_never_restart(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_gateway") as restart:
            heartbeat.process(state, "slack-dispatch", "missing activity")
            messages = heartbeat.process(
                state, "slack-dispatch", "missing activity")
        restart.assert_not_called()
        self.assertTrue(messages)

    def test_verified_runtime_requires_two_failures_before_restart(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_budget_left", return_value=1), \
                mock.patch.object(heartbeat, "active_agent_runs", return_value=0), \
                mock.patch.object(heartbeat, "restart_gateway",
                                  return_value=True) as restart:
            heartbeat.process(
                state, "verified-runtime", "both canaries failed")
            restart.assert_not_called()
            heartbeat.process(
                state, "verified-runtime", "both canaries failed")
            restart.assert_called_once()


class RestartDeferralTests(unittest.TestCase):
    def state(self):
        return {"checks": {}, "run": 0, "restarts": []}

    def fail_twice(self, state):
        heartbeat.process(state, "gateway", "gateway down")
        return heartbeat.process(state, "gateway", "gateway down")

    def test_active_runs_defer_restart_with_message(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_budget_left", return_value=1), \
                mock.patch.object(heartbeat, "active_agent_runs", return_value=2), \
                mock.patch.object(heartbeat, "restart_gateway") as restart:
            messages = self.fail_twice(state)
        restart.assert_not_called()
        self.assertEqual(messages[0].severity, heartbeat.NOTICE)
        self.assertIn("deferring", messages[0].tried)
        self.assertEqual(state["checks"]["gateway"]["deferrals"], 1)

    def test_deferral_does_not_start_realert_throttle(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_budget_left", return_value=1), \
                mock.patch.object(heartbeat, "active_agent_runs", return_value=1), \
                mock.patch.object(heartbeat, "restart_gateway"):
            self.fail_twice(state)
        self.assertIsNone(state["checks"]["gateway"]["alerted_at"])

    def test_restart_refused_after_max_deferrals_with_active_runs(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_budget_left", return_value=1), \
                mock.patch.object(heartbeat, "active_agent_runs", return_value=1), \
                mock.patch.object(heartbeat, "restart_gateway") as restart:
            self.fail_twice(state)                                # defer 1/2
            heartbeat.process(state, "gateway", "gateway down")   # defer 2/2
            restart.assert_not_called()
            messages = heartbeat.process(
                state, "gateway", "gateway down")                 # escalate
            restart.assert_not_called()
        self.assertEqual(messages[0].severity, heartbeat.PAGE)
        self.assertIn("refusing to restart", messages[0].tried)
        self.assertIsNotNone(state["checks"]["gateway"]["alerted_at"])

    def test_restart_proceeds_when_active_runs_clear(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_budget_left", return_value=1), \
                mock.patch.object(
                    heartbeat, "active_agent_runs", side_effect=[1, 1, 0]), \
                mock.patch.object(
                    heartbeat, "restart_gateway",
                    return_value=True) as restart:
            self.fail_twice(state)                                # defer 1/2
            heartbeat.process(state, "gateway", "gateway down")   # defer 2/2
            heartbeat.process(state, "gateway", "gateway down")   # now quiet
            restart.assert_called_once()

    def test_recovery_resets_deferrals(self):
        state = self.state()
        with mock.patch.object(heartbeat, "restart_budget_left", return_value=1), \
                mock.patch.object(heartbeat, "active_agent_runs", return_value=1), \
                mock.patch.object(heartbeat, "restart_gateway"):
            self.fail_twice(state)
        heartbeat.process(state, "gateway", None)
        self.assertEqual(state["checks"]["gateway"]["deferrals"], 0)


class SilentKillScanTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        patcher = mock.patch.object(heartbeat, "LOG_DIR", self.tmp)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.path = pathlib.Path(self.tmp) / (
            f"openclaw-{heartbeat.now():%Y-%m-%d}.log")

    def state(self):
        return {"checks": {}, "run": 0, "restarts": []}

    def write(self, *lines, append=True):
        with open(self.path, "a" if append else "w") as f:
            for line in lines:
                f.write(line + "\n")

    def test_first_run_baselines_without_counting_history(self):
        self.write('{"message":"stalled session: sessionId=x"}')
        state = self.state()
        self.assertEqual(heartbeat.scan_silent_kills(state), {})

    def test_new_lines_counted_by_category_then_offset_advances(self):
        self.write("boot line")
        state = self.state()
        heartbeat.scan_silent_kills(state)  # baseline
        self.write(
            '{"message":"stalled session: sessionId=x"}',
            'visible channel turn dispatched with no queued reply payloads: x',
            'marked interrupted main session failed: y '
            '(transcript tail is not resumable)',
            '{"message":"stalled session: sessionId=z"}')
        self.assertEqual(
            heartbeat.scan_silent_kills(state),
            {"stalled-run": 2, "dropped-reply": 1, "dead-transcript": 1})
        self.assertEqual(heartbeat.scan_silent_kills(state), {})

    def test_truncation_resets_offset(self):
        self.write("a" * 500)
        state = self.state()
        heartbeat.scan_silent_kills(state)  # baseline at EOF
        self.write('{"message":"stalled session: after truncate"}',
                    append=False)
        self.assertEqual(
            heartbeat.scan_silent_kills(state), {"stalled-run": 1})

    def test_alerts_throttled_and_counts_accumulate(self):
        state = self.state()
        msgs = heartbeat.process_silent_kills(state, {"dropped-reply": 1})
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0].severity, heartbeat.NOTICE)
        self.assertIn("1× dropped-reply", msgs[0].summary)
        # Within the throttle window: no message, counts accumulate.
        self.assertEqual(
            heartbeat.process_silent_kills(state, {"dropped-reply": 2}), [])
        # Expire the throttle: accumulated counts flush in one message.
        state["checks"]["silent-kill"]["alerted_at"] = (
            heartbeat.now() - timedelta(minutes=heartbeat.REALERT_MIN + 1)
        ).isoformat()
        msgs = heartbeat.process_silent_kills(state, {"stalled-run": 1})
        self.assertEqual(len(msgs), 1)
        self.assertIn("2× dropped-reply", msgs[0].summary)
        self.assertIn("1× stalled-run", msgs[0].summary)

    def test_no_events_no_message(self):
        self.assertEqual(heartbeat.process_silent_kills(self.state(), {}), [])

    def test_day_rollover_drains_yesterdays_tail(self):
        yesterday = pathlib.Path(self.tmp) / "openclaw-1999-12-31.log"
        yesterday.write_text(
            'boot\n{"message":"stalled session: late-night loss"}\n')
        state = self.state()
        state["logscan"] = {"path": str(yesterday), "offset": 5}
        self.write("today boot line")
        counts = heartbeat.scan_silent_kills(state)
        self.assertEqual(counts.get("stalled-run"), 1)
        self.assertEqual(state["logscan"]["path"], str(self.path))


class RollupTests(unittest.TestCase):
    """The rollup is the record; Slack is only a notification surface."""

    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp)
        self.path = str(pathlib.Path(self.tmp) / "rollup.jsonl")
        patcher = mock.patch.object(heartbeat, "ROLLUP_PATH", self.path)
        patcher.start()
        self.addCleanup(patcher.stop)

    def lines(self):
        with open(self.path) as f:
            return [json.loads(line) for line in f]

    def test_first_strike_is_recorded_even_though_nothing_is_sent(self):
        state = {"checks": {}, "run": 0, "restarts": []}
        with mock.patch.object(heartbeat, "restart_gateway"):
            alerts = heartbeat.observe(state, "provider", "3 provider errors")
        self.assertEqual(alerts, [])
        entry = self.lines()[0]
        self.assertEqual(entry["kind"], "observation")
        self.assertEqual(entry["strike"], 1)

    def test_healthy_check_writes_nothing(self):
        heartbeat.observe({"checks": {}, "run": 0, "restarts": []},
                          "provider", None)
        self.assertFalse(pathlib.Path(self.path).exists())

    def test_rotation_caps_the_file(self):
        with mock.patch.object(heartbeat, "ROLLUP_MAX_BYTES", 200):
            for i in range(20):
                heartbeat.record("observation", "gateway", f"failure {i}")
        self.assertTrue(pathlib.Path(self.path + ".1").exists())
        self.assertLess(pathlib.Path(self.path).stat().st_size, 400)


class SeverityRoutingTests(unittest.TestCase):
    """The incident protocol: every surfaced alert stays in #ops."""

    def state(self):
        return {"checks": {}, "run": 0, "restarts": [], "incidents": {}}

    def setUp(self):
        for name in ("record", "slack_post"):
            patcher = mock.patch.object(heartbeat, name)
            setattr(self, name, patcher.start())
            self.addCleanup(patcher.stop)
        self.slack_post.return_value = "1785000000.000100"
        token = mock.patch.object(heartbeat, "slack_token", return_value="fake-slack-token")
        token.start()
        self.addCleanup(token.stop)

    def test_silent_alert_is_logged_but_never_sent(self):
        state = self.state()
        alert = heartbeat.Alert(heartbeat.SILENT, "gateway", "self-healed")
        self.assertIsNone(heartbeat.deliver(state, alert))
        self.record.assert_called_once()
        self.assertEqual(self.record.call_args.kwargs["delivery"], "none")
        self.slack_post.assert_not_called()

    def test_undeliverable_notice_is_recorded_without_cross_channel_fallback(self):
        self.slack_post.return_value = None  # Slack refuses the post
        label = heartbeat.deliver(
            self.state(), heartbeat.Alert(heartbeat.NOTICE, "gateway", "down"))
        self.assertIsNone(label)
        self.assertEqual(self.record.call_count, 2)

    def test_notice_opens_one_thread_and_replies_into_it(self):
        state = self.state()
        heartbeat.deliver(
            state, heartbeat.Alert(heartbeat.NOTICE, "silent-kill", "3× stalled"))
        self.assertEqual(self.slack_post.call_count, 1)  # thread root only
        self.assertIn("silent-kill", state["incidents"])
        heartbeat.deliver(
            state, heartbeat.Alert(heartbeat.NOTICE, "silent-kill", "1× more"))
        self.assertEqual(self.slack_post.call_count, 2)  # reply, not a new root
        self.assertEqual(
            self.slack_post.call_args.kwargs["thread_ts"], "1785000000.000100")

    def test_page_posts_the_full_contract_to_the_incident_thread(self):
        state = self.state()
        heartbeat.deliver(state, heartbeat.Alert(
            heartbeat.PAGE, "gateway", "gateway port not listening",
            tried="auto-restart, which did not help",
            action="launchctl kickstart -k gui/UID/ai.openclaw.gateway"))
        text = self.slack_post.call_args.args[2]
        self.assertIn("What failed: gateway port not listening", text)
        self.assertIn("Already tried: auto-restart", text)
        self.assertIn("Your action: launchctl kickstart", text)
        self.assertIn("If you wait: ", text)

    def test_recovery_without_an_open_incident_says_nothing(self):
        state = self.state()
        heartbeat.deliver(state, heartbeat.Alert(
            heartbeat.NOTICE, "gateway", "gateway recovered", resolves=True))
        self.slack_post.assert_not_called()

    def test_recovery_closes_the_incident_thread(self):
        state = self.state()
        heartbeat.deliver(
            state, heartbeat.Alert(heartbeat.NOTICE, "gateway", "gateway down"))
        heartbeat.deliver(state, heartbeat.Alert(
            heartbeat.NOTICE, "gateway", "gateway recovered", resolves=True))
        self.assertNotIn("gateway", state["incidents"])
        self.assertIn("✅", self.slack_post.call_args.args[2])

    def test_stale_incident_starts_a_new_thread(self):
        state = self.state()
        heartbeat.deliver(
            state, heartbeat.Alert(heartbeat.NOTICE, "gateway", "gateway down"))
        state["incidents"]["gateway"]["opened_at"] = (
            heartbeat.now() - timedelta(hours=heartbeat.INCIDENT_TTL_H + 1)
        ).isoformat()
        self.slack_post.return_value = "1785000999.000100"
        heartbeat.deliver(
            state, heartbeat.Alert(heartbeat.NOTICE, "gateway", "still down"))
        self.assertEqual(state["incidents"]["gateway"]["ts"], "1785000999.000100")

    def test_canary_is_a_notice_before_it_is_a_page(self):
        state = self.state()
        for _ in range(heartbeat.CANARY_PAGE_AFTER - 1):
            alerts = heartbeat.process(state, "canary-agent-a", "no OK")
            state["checks"]["canary-agent-a"]["alerted_at"] = None  # skip throttle
        self.assertEqual(alerts[0].severity, heartbeat.NOTICE)
        alerts = heartbeat.process(state, "canary-agent-a", "no OK")
        self.assertEqual(alerts[0].severity, heartbeat.PAGE)
        self.assertIn("--agent agent-a", alerts[0].action)


class InstanceConfigTests(unittest.TestCase):
    """Instance values come from config.json, never from the framework."""

    def test_example_config_drives_module_constants(self):
        self.assertEqual(heartbeat.INCIDENT_CHANNEL, "C0000000000")
        self.assertEqual(heartbeat.AGENTS, ["agent-a", "agent-b"])
        self.assertEqual(heartbeat.DOPPLER_PROJECTS,
                         ["example-agent-a", "example-agent-b"])
        self.assertEqual(heartbeat.GATEWAY_SERVICE,
                         f"gui/{os.getuid()}/ai.openclaw.gateway")
        self.assertIn("example-host", heartbeat.NEXT_STEPS["gateway"])
        self.assertIn("Agent-a and Agent-b", heartbeat.WAIT_COST["gateway"])

    def test_missing_required_keys_fail_closed(self):
        with tempfile.TemporaryDirectory() as folder:
            path = pathlib.Path(folder) / "config.json"
            path.write_text(json.dumps({"agents": ["a"]}))
            with mock.patch.dict(os.environ, {"HEARTBEAT_CONFIG": str(path)}):
                with self.assertRaises(SystemExit) as stop:
                    heartbeat.load_instance_config()
        self.assertIn("incidentChannel", str(stop.exception))
        self.assertIn("dopplerProjects", str(stop.exception))

    def test_config_resolves_from_runtime_root(self):
        with tempfile.TemporaryDirectory() as folder:
            config_dir = pathlib.Path(folder) / "config/services/observability/heartbeat"
            config_dir.mkdir(parents=True)
            (config_dir / "config.json").write_text(json.dumps(
                {"incidentChannel": "C1", "agents": ["a"], "dopplerProjects": ["p"]}))
            env = {"HUMANWARE_RUNTIME_ROOT": folder}
            with mock.patch.dict(os.environ, env):
                os.environ.pop("HEARTBEAT_CONFIG", None)
                self.assertEqual(
                    heartbeat.load_instance_config()["incidentChannel"], "C1")


if __name__ == "__main__":
    unittest.main()
