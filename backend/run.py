"""Start the API server.

Locally (`python run.py`) it listens on 0.0.0.0:8000 with auto-reload, so
phones and laptops on the same network can reach it.

In production set PORT (the systemd unit in README.md does), which switches
auto-reload off. HTTPS ends at the reverse proxy (nginx), so its proxy headers
are trusted: without them every request looks like plain http and the
/files/... URLs handed to the browser would be http://, which an https
frontend blocks as mixed content.
"""

import os

import uvicorn


# Which peers may set X-Forwarded-For / X-Forwarded-Proto.
#
# This is a security control, not a convenience: app/utils/rate_limit.py keys
# every auth throttle on request.client.host, so whoever is trusted to set the
# header decides what the login limiter counts. With "*" any caller could send
# a different X-Forwarded-For on each request and get a fresh budget every
# time -- unlimited password guessing against one account, because the
# per-email rule is keyed on "{ip}|{email}" too.
#
# The default covers the addresses a reverse proxy actually speaks from
# (nginx on the same machine, or one on the private network), so the
# deployment keeps working while a request arriving straight from the
# internet is no longer believed. Set FORWARDED_ALLOW_IPS to narrow it
# further to the proxy's exact address.
DEFAULT_FORWARDED_ALLOW_IPS = "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"


if __name__ == "__main__":
    on_platform = "PORT" in os.environ
    uvicorn.run(
        "app.main:app",
        host="0.0.0.0",
        port=int(os.environ.get("PORT", "8000")),
        reload=os.environ.get("RELOAD", "false" if on_platform else "true").lower() == "true",
        proxy_headers=True,
        forwarded_allow_ips=os.environ.get(
            "FORWARDED_ALLOW_IPS", DEFAULT_FORWARDED_ALLOW_IPS
        ),
    )
