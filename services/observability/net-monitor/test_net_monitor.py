#!/usr/bin/env python3
"""Synthetic fixtures for the net-monitor sampler parsing and security rollup."""
import importlib.util
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path


def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


sampler = load("sample_traffic", "sample-traffic.py")
builder = load("build_security_data", "build-security-data.py")


class SamplerTests(unittest.TestCase):
    def test_split_hostport_ipv4_and_ipv6(self):
        self.assertEqual(sampler.split_hostport("10.0.0.2:5000->203.0.113.9:443"), ("203.0.113.9", "443"))
        self.assertEqual(sampler.split_hostport("[fe80::1]:5000->[2001:db8::1]:443"), ("2001:db8::1", "443"))
        self.assertIsNone(sampler.split_hostport("*:22"))

    def test_local_peers_are_noise(self):
        for ip in ("127.0.0.1", "192.168.1.5", "fe80::1", "not-an-ip"):
            self.assertTrue(sampler.is_local(ip), ip)
        self.assertFalse(sampler.is_local("8.8.8.8"))

    def test_tag_prefers_dns_then_known_networks(self):
        self.assertEqual(sampler.tag("api.github.com", "203.0.113.9"), "GitHub")
        self.assertEqual(sampler.tag(None, "17.1.2.3"), "Apple")
        self.assertEqual(sampler.tag(None, "203.0.113.9"), "unknown")


class BuilderTests(unittest.TestCase):
    def test_findings_grouped_by_id_with_high_severity_kept(self):
        audit = {"findings": [
            {"id": "unexpected-public-listener", "severity": "high", "evidence": {"endpoint": f"*:{p}", "process": "svc"}}
            for p in range(10)
        ] + [{"id": "firewall-disabled", "severity": "critical"}]}
        rows = {r["title"]: r for r in builder.audit_findings(audit)}
        listener = rows[builder.AUDIT_TITLES["unexpected-public-listener"]]
        self.assertEqual(listener["count"], 10)
        self.assertIn("+2 more", listener["detail"])
        self.assertEqual(rows[builder.AUDIT_TITLES["firewall-disabled"]]["severity"], "high")

    def test_first_seen_suppressed_until_baseline(self):
        now = datetime.now(timezone.utc)
        samples = [{"_ts": now - timedelta(hours=1), "connCount": 1, "connections": [
            {"process": "curl", "ip": "203.0.113.9", "host": "example.net", "owner": "unknown"}]}]
        index = builder.build_first_seen_index(samples)
        early = builder.build_window(samples, 24, 1, index, span_hours=1)
        self.assertEqual(early["first_seen"], [])
        self.assertEqual(early["baseline_pending_hours"], builder.BASELINE_HOURS - 1)
        later = builder.build_window(samples, 24, 1, index, span_hours=builder.BASELINE_HOURS)
        self.assertEqual([r["host"] for r in later["first_seen"]], ["example.net"])

    def test_audit_diff_reports_new_launch_items(self):
        before = {"launch_items": [{"label": "a"}], "listeners": []}
        after = {"launch_items": [{"label": "a"}, {"label": "b"}], "listeners": []}
        self.assertEqual(builder.audit_diff(after, before), {"launch_items": {"added": ["b"], "removed": []}})

    def test_credential_posture_distinguishes_current_stale_and_unavailable(self):
        now = datetime(2026, 10, 29, 12, tzinfo=timezone.utc)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "credentials.json"
            path.write_text(json.dumps({
                "generatedAt": "2026-10-29T10:00:00+00:00",
                "staleAfterHours": 26,
                "summary": {"status": "healthy"},
            }))
            self.assertEqual(builder.latest_credential_posture(path, now)["state"], "current")
            later = now + timedelta(hours=30)
            self.assertEqual(builder.latest_credential_posture(path, later)["state"], "stale")
            self.assertEqual(
                builder.latest_credential_posture(Path(directory) / "missing.json", now)["state"],
                "unavailable")


class SecuritySurfaceTests(unittest.TestCase):
    def test_credentials_view_and_light_theme_are_present(self):
        surface = (Path(__file__).parents[2] / ".." / "surfaces" / "domain" /
                   "security" / "index.html").resolve().read_text()
        self.assertIn('data-view="credentials"', surface)
        self.assertIn("renderCredentials", surface)
        self.assertIn("prefers-color-scheme:light", surface)
        self.assertNotIn("credential.value", surface)


if __name__ == "__main__":
    unittest.main()
