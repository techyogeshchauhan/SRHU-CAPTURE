"""Check whether this host can reach an SMTP server, and whether the credentials work.

Standalone by design: it reads SMTP_* straight from the environment and imports
nothing from ``app``, so it still runs when app.config cannot be imported. A
``backend/.env`` file, when present, fills in anything the environment lacks.
It never sends an email.

Run from the backend directory, on the server that sends the email:
    python scripts/smtp_diagnostic.py
"""

from __future__ import annotations

import errno
import os
import smtplib
import socket
import ssl

try:
    from dotenv import load_dotenv
except ImportError:  # the script must keep working without python-dotenv
    load_dotenv = None

if load_dotenv:
    load_dotenv(
        os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env"),
        override=False,
    )

# Ports worth probing: 587 STARTTLS submission, 465 implicit TLS, 25 relay.
# Hosts that block outbound mail usually block all three, and 25 almost always.
PROBE_PORTS = (587, 465, 25)
TCP_TIMEOUT = 10
SMTP_TIMEOUT = 20


def _env() -> dict[str, str]:
    return {
        "SMTP_HOST": os.environ.get("SMTP_HOST", ""),
        "SMTP_PORT": os.environ.get("SMTP_PORT", ""),
        "SMTP_USER": os.environ.get("SMTP_USER", ""),
        "SMTP_PASSWORD": os.environ.get("SMTP_PASSWORD", ""),
        "SMTP_FROM_EMAIL": os.environ.get("SMTP_FROM_EMAIL", ""),
    }


def _report_config(env: dict[str, str]) -> None:
    print("Configuration read from the environment:")
    print(f"  SMTP_HOST        {env['SMTP_HOST'] or '(not set)'}")
    print(f"  SMTP_PORT        {env['SMTP_PORT'] or '(not set)'}")
    # The username and sender are addresses this service already puts in every
    # From: header, so showing them helps spot a typo. The password never prints.
    print(f"  SMTP_USER        {env['SMTP_USER'] or '(not set)'}")
    print(f"  SMTP_FROM_EMAIL  {env['SMTP_FROM_EMAIL'] or '(not set)'}")
    password = env["SMTP_PASSWORD"]
    print(
        f"  SMTP_PASSWORD    {f'set, {len(password)} characters' if password else '(not set)'}"
    )
    print()


def _probe_tcp(host: str) -> dict[int, str]:
    """Open a bare TCP connection to each port to isolate network-level blocking."""
    print(f"Raw TCP reachability to {host} ({TCP_TIMEOUT}s timeout each):")
    results: dict[int, str] = {}

    for port in PROBE_PORTS:
        try:
            with socket.create_connection((host, port), timeout=TCP_TIMEOUT):
                results[port] = "open"
                print(f"  {port:<5} open")
        except socket.timeout:
            results[port] = "timeout"
            print(f"  {port:<5} TIMEOUT - consistent with the port being filtered")
        except ConnectionRefusedError as exc:
            results[port] = "refused"
            print(f"  {port:<5} refused - reachable, but nothing is listening ({exc.errno})")
        except OSError as exc:
            # ENETUNREACH/EHOSTUNREACH mean the host has no route for this traffic
            # at all, which is how providers null-route blocked SMTP egress.
            if exc.errno in (errno.ENETUNREACH, errno.EHOSTUNREACH):
                results[port] = "unroutable"
                print(f"  {port:<5} UNREACHABLE - no route for this traffic ({exc.errno})")
            else:
                results[port] = "error"
                print(f"  {port:<5} failed - {type(exc).__name__}: {exc}")

    print()
    return results


def _probe_smtp(host: str, port: int, user: str, password: str) -> tuple[str, int]:
    """Walk TCP, TLS and authentication on the configured port. Sends nothing."""
    print(f"Full SMTP handshake on port {port}:")
    context = ssl.create_default_context()
    stages = {"tcp": False, "tls": False, "auth": False}

    try:
        if port == 465:
            client = smtplib.SMTP_SSL(host, port, timeout=SMTP_TIMEOUT, context=context)
        else:
            client = smtplib.SMTP(host, port, timeout=SMTP_TIMEOUT)

        with client as smtp:
            stages["tcp"] = True
            # SMTP_SSL completes its TLS handshake while connecting.
            if port == 465:
                stages["tls"] = True
            print("  TCP connect      success")
            smtp.ehlo()

            if port != 465:
                smtp.starttls(context=context)
                smtp.ehlo()
                stages["tls"] = True
            print("  TLS handshake    success")

            if not user or not password:
                print("  Authentication   skipped - SMTP_USER or SMTP_PASSWORD not set")
                return "no_credentials", 0

            smtp.login(user, password)
            stages["auth"] = True
            print("  Authentication   success")
            print("  Send             skipped - this diagnostic never sends email")
            return "ok", 0

    except smtplib.SMTPAuthenticationError as exc:
        print(f"  Authentication   FAILED - SMTP code {exc.smtp_code}")
        return "auth_rejected", exc.smtp_code
    except (OSError, smtplib.SMTPException) as exc:
        stage = "TCP connect" if not stages["tcp"] else (
            "TLS handshake" if not stages["tls"] else "Authentication"
        )
        errno = getattr(exc, "errno", None)
        print(f"  {stage:<16} FAILED - {type(exc).__name__}: {exc}")
        if errno is not None:
            print(f"  OS errno         {errno}")
        if not stages["tcp"]:
            return "unreachable", errno or 0
        if not stages["tls"]:
            return "tls_failed", errno or 0
        return "auth_failed", errno or 0


def _verdict(outcome: str, tcp: dict[int, str], port: int) -> None:
    print()
    print("Verdict:")

    if outcome == "ok":
        print("  Outbound SMTP works from this host and the credentials are accepted.")
        print("  The backend can send mail directly; no provider block is in the way.")
        return

    if outcome == "auth_rejected":
        print("  The network path is fine - TCP and TLS both succeeded - but the server")
        print("  rejected the username or password. This is NOT a hosting port block.")
        print("  For Gmail, use a 16-character App Password, not the account password.")
        return

    if outcome == "unreachable":
        open_ports = [p for p, r in tcp.items() if r == "open"]
        timed_out = [p for p, r in tcp.items() if r == "timeout"]
        refused = [p for p, r in tcp.items() if r == "refused"]
        unroutable = [p for p, r in tcp.items() if r == "unroutable"]

        if open_ports:
            print(f"  Port {port} did not connect, but {open_ports} did. The block is")
            print(f"  specific to {port} rather than to SMTP generally - try another port.")
        elif unroutable and not timed_out:
            print("  Every SMTP port reported 'network unreachable'. The host has no")
            print("  route for outbound SMTP at all - the provider null-routes it. This")
            print("  is a network-level block, not a configuration problem, and no code")
            print("  change works around it. Ask for outbound SMTP to be allowed, or use a")
            print("  hosted mail API (SendGrid, Resend, Mailgun) in place of raw SMTP.")
        elif timed_out:
            print("  Every SMTP port timed out. A silent timeout is the signature of")
            print("  egress filtering by a firewall or the hosting provider.")
            print("  Ask for outbound SMTP to be allowed, or switch to a hosted mail API.")
        elif len(refused) == len(PROBE_PORTS):
            print("  Every port actively refused the connection. The network path is NOT")
            print("  filtered - a filtered port hangs instead of resetting. Nothing is")
            print("  listening there, so check SMTP_HOST for a typo or wrong hostname.")
        else:
            print("  No port connected, with mixed errors above. Read them individually:")
            print("  a timeout suggests filtering, a refusal suggests the wrong host.")
        return

    if outcome == "no_credentials":
        print("  The connection and TLS work, but no credentials were set to test.")
        return

    print(f"  Failed at stage: {outcome}. See the error above.")


def main() -> int:
    print("SMTP egress diagnostic - no email is sent by this script")
    print()

    env = _env()
    _report_config(env)

    host = env["SMTP_HOST"]
    if not host:
        print("Cannot continue: SMTP_HOST is not set in this environment.")
        return 2

    try:
        port = int(env["SMTP_PORT"] or 587)
    except ValueError:
        print(f"Cannot continue: SMTP_PORT is not a number ({env['SMTP_PORT']!r}).")
        return 2

    tcp = _probe_tcp(host)
    outcome, _ = _probe_smtp(host, port, env["SMTP_USER"], env["SMTP_PASSWORD"])
    _verdict(outcome, tcp, port)

    return 0 if outcome == "ok" else 1


if __name__ == "__main__":
    raise SystemExit(main())
