from __future__ import annotations

import os
import re
import subprocess
import sys
import unittest

# Provide the settings the app needs even when no .env is present.
os.environ.setdefault("JWT_SECRET_KEY", "unit-test-secret-key-0123456789")
os.environ.setdefault("FRONTEND_URL", "http://localhost:5173")

from app.config import LAN_CORS_ORIGIN_REGEX, Settings  # noqa: E402
from app.database import _uses_tls  # noqa: E402


def settings_for(**overrides) -> Settings:
    values = {
        "jwt_secret_key": "unit-test-secret-key-0123456789",
        "frontend_url": "https://campus.example.edu",
        "smtp_from_email": "noreply@srhu.edu.in",
        "_env_file": None,
    }
    values.update(overrides)
    return Settings(**values)


class SettingsTests(unittest.TestCase):
    def test_smtp_needs_a_host(self) -> None:
        self.assertEqual(settings_for().smtp_missing_variables, ["SMTP_HOST"])
        self.assertEqual(settings_for(smtp_host="smtp.gmail.com").smtp_missing_variables, [])

    def test_no_cors_regex_by_default(self) -> None:
        """A deployment admits only the origins it was configured with.

        The localhost / private-LAN pattern used to be the built-in default,
        so every production deployment also trusted any page served from a
        private address. It is now opt-in as LAN_CORS_ORIGIN_REGEX.
        """
        self.assertIsNone(settings_for().cors_origin_regex)
        self.assertEqual(settings_for(cors_origin_regex="").cors_origin_regex, "")
        self.assertTrue(settings_for(cors_origin_regex=LAN_CORS_ORIGIN_REGEX).cors_origin_regex)

    def test_lan_cors_regex_admits_only_local_and_private_ranges(self) -> None:
        pattern = re.compile(LAN_CORS_ORIGIN_REGEX)
        allowed = [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://10.0.0.5:5173",
            "http://172.16.1.229:5173",
            "http://172.31.255.255",
            "https://192.168.1.20:5173",
            "http://100.64.0.1:5173",
            "http://100.127.255.254",
        ]
        refused = [
            "http://100.63.0.1:5173",
            "http://100.128.0.1:5173",
            "http://100.1.2.3",
            "http://172.32.0.1:5173",
            "http://172.15.0.1",
            "http://11.0.0.1",
            "http://10.0.0.256",
            "http://10.0.0.5.evil.com",
            "http://localhost.evil.com",
            "https://evil.com",
        ]
        for origin in allowed:
            with self.subTest(origin=origin):
                self.assertTrue(pattern.fullmatch(origin))
        for origin in refused:
            with self.subTest(origin=origin):
                self.assertIsNone(pattern.fullmatch(origin))

    def test_plain_http_frontend_is_flagged_unless_local(self) -> None:
        self.assertTrue(settings_for(frontend_url="http://172.16.1.229:5173").frontend_url_is_insecure)
        self.assertFalse(settings_for(frontend_url="http://localhost:5173").frontend_url_is_insecure)
        self.assertFalse(settings_for(frontend_url="http://127.0.0.1:5173").frontend_url_is_insecure)
        self.assertFalse(settings_for().frontend_url_is_insecure)

    def test_session_defaults(self) -> None:
        values = settings_for()
        self.assertEqual(values.session_max_age_days, 30)
        self.assertEqual(values.access_token_expire_minutes, 60 * 24 * 7)
        self.assertEqual(values.session_idle_minutes, 30)
        self.assertTrue(values.rate_limit_enabled)


class HealthTests(unittest.TestCase):
    def test_health_reveals_only_a_status(self) -> None:
        from unittest.mock import patch

        from fastapi.testclient import TestClient

        from app.main import app

        client = TestClient(app)
        with patch("app.main.ping", return_value=False):
            degraded = client.get("/health")
        self.assertEqual(degraded.status_code, 200)
        self.assertEqual(degraded.json(), {"status": "degraded"})

        with patch("app.main.ping", return_value=True), patch.multiple(
            "app.main.settings", smtp_host="smtp.example.com", smtp_from_email="n@example.com"
        ):
            healthy = client.get("/health")
        self.assertEqual(healthy.json(), {"status": "ok"})


class MongoImportTests(unittest.TestCase):
    def test_import_does_not_resolve_srv_dns(self) -> None:
        """B-19: an unresolvable mongodb+srv URI must not break importing the app."""
        env = {
            **os.environ,
            "MONGODB_URI": "mongodb+srv://nonexistent.invalid/",
            "JWT_SECRET_KEY": "unit-test-secret-key-0123456789",
            "FRONTEND_URL": "http://localhost:5173",
        }
        backend = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        result = subprocess.run(
            [
                sys.executable,
                "-c",
                "from app.config import settings; "
                "assert settings.mongodb_uri == 'mongodb+srv://nonexistent.invalid/', settings.mongodb_uri; "
                "import app.database, app.main; print('imported')",
            ],
            cwd=backend,
            env=env,
            capture_output=True,
            text=True,
            timeout=60,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("imported", result.stdout)


class MongoTlsTests(unittest.TestCase):
    def test_atlas_and_explicit_tls_use_certifi(self) -> None:
        self.assertTrue(_uses_tls("mongodb+srv://u:p@cluster0.abcd.mongodb.net/?retryWrites=true"))
        self.assertTrue(_uses_tls("mongodb://host:27017/?tls=true"))

    def test_plain_connections_do_not(self) -> None:
        self.assertFalse(_uses_tls("mongodb://localhost:27017"))
        self.assertFalse(_uses_tls("mongodb://mongo:pw@mongodb.internal:27017"))


if __name__ == "__main__":
    unittest.main()
