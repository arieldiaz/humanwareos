#!/usr/bin/env python3
import importlib.util
import json
import os
import pathlib
import tempfile
import unittest
from datetime import datetime, timezone
from unittest import mock


PATH = pathlib.Path(__file__).with_name("collector.py")
SPEC = importlib.util.spec_from_file_location("credential_posture", PATH)
collector = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(collector)


class Completed:
    def __init__(self, payload, returncode=0):
        self.returncode = returncode
        self.stdout = json.dumps(payload)
        self.stderr = ""


class CredentialPostureTests(unittest.TestCase):
    def config(self):
        return {
            "schemaVersion": 1,
            "doppler": {"bin": "doppler", "scopes": [
                {"project": "core", "configs": ["prd"]}
            ]},
            "checks": [],
            "staleAfterHours": 26,
        }

    def entry(self, budget=None):
        return {
            "id": "openrouter-core-prd",
            "provider": "openrouter",
            "doppler": {"project": "core", "config": "prd", "secret": "OPENROUTER_API_KEY"},
            "consumer": "runtime",
            "environment": "production",
            "owner": "operator",
            "status": "active",
            "budget": budget or {
                "kind": "hard_cap", "amountUsd": 25,
                "confirmedAt": "2026-10-20T00:00:00+00:00", "source": "provider-console"
            },
        }

    def test_doppler_discovery_uses_names_only_and_classifies_supported_providers(self):
        runner = mock.Mock(return_value=Completed({
            "OPENAI_API_KEY": "ignored-if-present",
            "STRIPE_SECRET_KEY": "ignored",
            "DOPPLER_PROJECT": "core",
        }))
        discoveries, sources = collector.discover_doppler(self.config(), runner=runner)
        command = runner.call_args.args[0]
        self.assertIn("--only-names", command)
        self.assertEqual(discoveries, [{
            "provider": "openai",
            "doppler": {"project": "core", "config": "prd", "secret": "OPENAI_API_KEY"},
        }])
        self.assertEqual(sources[0]["state"], "current")

    def test_unregistered_and_unbounded_credentials_are_high_findings(self):
        discoveries = [
            {"provider": "openrouter", "doppler": self.entry()["doppler"]},
            {"provider": "openai", "doppler": {
                "project": "core", "config": "prd", "secret": "OPENAI_API_KEY"}},
        ]
        register = {"schemaVersion": 1, "credentials": [
            self.entry({"kind": "alert_only", "confirmedAt": "2026-10-20T00:00:00+00:00"})]}
        snapshot = collector.build_snapshot(
            self.config(), register, discoveries,
            [{"project": "core", "config": "prd", "state": "current"}],
            [{"id": "openrouter-core-prd", "provider": "openrouter", "state": "verified"}],
            now=datetime(2026, 10, 29, tzinfo=timezone.utc))
        codes = {item["code"] for item in snapshot["findings"]}
        self.assertIn("unregistered-credential", codes)
        self.assertIn("unbounded-spend", codes)
        self.assertEqual(snapshot["summary"]["status"], "critical")

    def test_openrouter_limit_is_compared_with_register(self):
        entry = self.entry()
        snapshot = collector.build_snapshot(
            self.config(), {"schemaVersion": 1, "credentials": [entry]},
            [{"provider": "openrouter", "doppler": entry["doppler"]}],
            [{"project": "core", "config": "prd", "state": "current"}],
            [{"id": entry["id"], "provider": "openrouter", "state": "verified",
              "budget": {"kind": "hard_cap", "amountUsd": 50}}],
            now=datetime(2026, 10, 29, tzinfo=timezone.utc))
        self.assertIn("budget-drift", {item["code"] for item in snapshot["findings"]})

    def test_unavailable_doppler_scope_does_not_claim_secret_is_missing(self):
        entry = self.entry()
        snapshot = collector.build_snapshot(
            self.config(), {"schemaVersion": 1, "credentials": [entry]}, [],
            [{"project": "core", "config": "prd", "state": "unavailable", "error": "timeout"}],
            [], now=datetime(2026, 10, 29, tzinfo=timezone.utc))
        codes = {item["code"] for item in snapshot["findings"]}
        self.assertIn("doppler-scope-unavailable", codes)
        self.assertNotIn("missing-secret", codes)

    def test_prepaid_budget_with_unlimited_auto_recharge_is_not_bounded(self):
        self.assertFalse(collector.budget_is_bounded({
            "kind": "prepaid", "amountUsd": 20, "autoRecharge": True
        }))
        self.assertTrue(collector.budget_is_bounded({
            "kind": "prepaid", "amountUsd": 20, "autoRecharge": False
        }))
        self.assertTrue(collector.budget_is_bounded({
            "kind": "prepaid", "amountUsd": 20, "autoRecharge": True,
            "autoRechargeMonthlyMaxUsd": 50
        }))

    def test_provider_check_never_puts_credential_in_url(self):
        seen = {}

        class Response:
            status = 200
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def read(self): return b'{"models":[]}'

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["header"] = request.headers.get("X-goog-api-key")
            return Response()

        result = collector.check_provider(
            {"id": "gemini", "provider": "gemini", "credentialEnv": "GEMINI_API_KEY"},
            environ={"GEMINI_API_KEY": "secret-value"}, opener=opener)
        self.assertEqual(result["state"], "verified")
        self.assertNotIn("secret-value", seen["url"])
        self.assertEqual(seen["header"], "secret-value")

    def test_atomic_write_replaces_complete_document(self):
        with tempfile.TemporaryDirectory() as directory:
            path = os.path.join(directory, "status.json")
            collector.atomic_write(path, {"ok": True})
            self.assertEqual(json.loads(pathlib.Path(path).read_text()), {"ok": True})
            self.assertFalse(os.path.exists(path + ".tmp"))


if __name__ == "__main__":
    unittest.main()
