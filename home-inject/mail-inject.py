#!/usr/bin/env python3
"""Cloud Mail merge-back injection endpoint (home side).

Listens on localhost only. The Cloudflare sync worker POSTs each original
message here once the home lab is reachable again, and this service drops
it into the right user's Dovecot mailbox, so it shows up in plMail like
ordinary mail.

  POST /inject   {"token": ..., "user": ..., "rawMime": ...}
  GET  /health  200 only when an injection path is available
  GET  /aliases  {"support@example.com": ["alias@example.com", ...], ...}
                every account's live aliases from plMail, keyed by the
                allowlist mailbox address. Same token, sent as
                `Authorization: Bearer <token>`. The backup asks for this
                every few hours so it knows where alias mail belongs.

Injection is done with the local sendmail (preferred): the raw message is
piped to sendmail unchanged, so every original header survives and Postfix
delivers it to Dovecot exactly as it would a message that arrived directly.
The only header added is the usual Received: line Postfix adds to everything.

Standard library only: no third-party packages, no pip install.

Configuration (environment, see mail-inject.env):
  MAIL_INJECT_TOKEN  required. Shared secret; must match the sync worker's
                     SYNC_TOKEN secret. Checked with a constant-time compare.
  MAIL_INJECT_USERS  required. Comma-separated allowlist of home inbox
                     addresses, e.g. you@bearermail.com,friend@bearermail.com
                     Only these users ever receive injected mail.
  SENDMAIL_BIN       host sendmail binary, default /usr/sbin/sendmail.
  MTA_CONTAINER      name of the Postfix (mta) container, used only when no
                     host sendmail exists: mail is piped in with
                     `docker exec -i <container> sendmail ...`.
  BIND_HOST          default 127.0.0.1 (do not expose this publicly).
  BIND_PORT          default 8765.
  MAX_BYTES          default 26214400 (25 MB). Larger messages get a 413.
  PLMAIL_DB_CONTAINER  plMail database container, default
                     plmail-mail-server-database-1. Used only by /aliases.
  PLMAIL_DB_USER     database user, default app. Used only by /aliases.
  PLMAIL_DB_NAME     database name, default app. Used only by /aliases.

The service never logs the token or any message content: one log line per
request with the user, size and result only.
"""

import hmac
import json
import os
import re
import shutil
import subprocess
import sys
from email.parser import BytesParser
from email.policy import default as default_policy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

BIND_HOST = os.environ.get("BIND_HOST", "127.0.0.1")
BIND_PORT = int(os.environ.get("BIND_PORT", "8765"))
SENDMAIL_BIN = os.environ.get("SENDMAIL_BIN", "/usr/sbin/sendmail")
MTA_CONTAINER = os.environ.get("MTA_CONTAINER", "").strip()
MAX_BYTES = int(os.environ.get("MAX_BYTES", str(25 * 1024 * 1024)))
PLMAIL_DB_CONTAINER = os.environ.get("PLMAIL_DB_CONTAINER", "plmail-mail-server-database-1")
PLMAIL_DB_USER = os.environ.get("PLMAIL_DB_USER", "app")
PLMAIL_DB_NAME = os.environ.get("PLMAIL_DB_NAME", "app")

TOKEN = os.environ.get("MAIL_INJECT_TOKEN", "")
USERS = {
    u.strip().lower()
    for u in os.environ.get("MAIL_INJECT_USERS", "").split(",")
    if u.strip()
}

FROM_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$")


def log(msg):
    print(msg, flush=True)


def sendmail_available():
    if os.path.exists(SENDMAIL_BIN):
        return True
    return bool(MTA_CONTAINER and shutil.which("docker"))


def extract_from(raw_bytes):
    """Best-effort envelope sender from the original From: header."""
    try:
        msg = BytesParser(policy=default_policy).parsebytes(raw_bytes)
        addrs = msg.get_all("From", [])
        if not addrs:
            return None
        addr = str(addrs[0]).strip()
        # Angle-addr form: "Name <user@example.com>"
        m = re.search(r"<([^<>]+)>", addr)
        if m:
            addr = m.group(1).strip()
        return addr if FROM_RE.match(addr) else None
    except Exception:
        return None


def inject(user, raw_bytes):
    """Pipe the raw message to sendmail. Returns (ok, detail)."""
    from_addr = extract_from(raw_bytes)
    args = ["-i"]
    if from_addr:
        args += ["-f", from_addr]
    args.append(user)

    try:
        if os.path.exists(SENDMAIL_BIN):
            cmd = [SENDMAIL_BIN] + args
        elif MTA_CONTAINER and shutil.which("docker"):
            cmd = ["docker", "exec", "-i", MTA_CONTAINER, "sendmail"] + args
        else:
            return False, "no sendmail available"
        proc = subprocess.run(
            cmd, input=raw_bytes, capture_output=True, timeout=120
        )
    except subprocess.TimeoutExpired:
        return False, "sendmail timed out"
    except Exception as e:  # noqa: BLE001 - report anything, never crash the handler
        return False, "sendmail error: %s" % (e,)

    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()[:500]
        return False, "sendmail exited %d: %s" % (proc.returncode, err)
    return True, "ok"


# One query for every account's live aliases. The account table is
# "account" (Doctrine default); email_alias carries the addresses with a
# status of primary / active / inactive. Only non-inactive aliases count
# for ownership (EmailAliasStatus::countsForOwnership), so those are the
# ones returned. No address from the request ever reaches this SQL: the
# query lists everything and the allowlist filter runs in Python.
ALIASES_SQL = (
    'SELECT a.email, ea.address FROM "account" a '
    "JOIN email_alias ea ON ea.account_id = a.id "
    "WHERE ea.status <> 'inactive' ORDER BY a.email, ea.address"
)


def fetch_aliases():
    """Read every account's live aliases from plMail's Postgres.

    Returns (ok, result): on success result is {mailbox: [alias, ...]}
    keyed by the allowlist mailbox addresses; on failure result is a
    short detail string. The read runs `psql` inside the plMail database
    container: local Unix-socket connections there are trust auth, so no
    DB password is needed. Only the allowlist mailboxes are returned.
    """
    if not shutil.which("docker"):
        return False, "docker not available"
    cmd = [
        "docker", "exec", PLMAIL_DB_CONTAINER,
        "psql", "-U", PLMAIL_DB_USER, "-d", PLMAIL_DB_NAME,
        "-At", "-F", "\t", "-c", ALIASES_SQL,
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=30)
    except subprocess.TimeoutExpired:
        return False, "psql timed out"
    except Exception as e:  # noqa: BLE001 - report anything, never crash the handler
        return False, "docker exec error: %s" % (e,)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()[:300]
        return False, "psql exited %d: %s" % (proc.returncode, err)
    out = proc.stdout.decode("utf-8", "replace")
    result = {u: [] for u in sorted(USERS)}
    for line in out.splitlines():
        parts = line.split("\t")
        if len(parts) != 2:
            continue
        mailbox, alias = parts[0].strip().lower(), parts[1].strip().lower()
        if mailbox in result and alias and alias != mailbox:
            if alias not in result[mailbox]:
                result[mailbox].append(alias)
    return True, result


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _json(self, status, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _auth_token(self):
        auth = self.headers.get("Authorization") or ""
        if auth.startswith("Bearer "):
            return auth[len("Bearer "):].strip()
        return ""

    def do_GET(self):
        path = urlsplit(self.path).path
        if path == "/health":
            if sendmail_available():
                self._json(200, {"status": "ok"})
            else:
                self._json(503, {"status": "unavailable", "detail": "no sendmail available"})
            return
        if path == "/aliases":
            if not hmac.compare_digest(self._auth_token(), TOKEN):
                log("aliases: rejected bad token")
                self._json(403, {"status": "error", "detail": "bad token"})
                return
            ok, result = fetch_aliases()
            if ok:
                total = sum(len(v) for v in result.values())
                log("aliases: ok mailboxes=%d aliases=%d" % (len(result), total))
                self._json(200, result)
            else:
                log("aliases: FAILED %s" % result)
                self._json(503, {"status": "error", "detail": result})
            return
        self._json(404, {"status": "not found"})

    def do_POST(self):
        if self.path != "/inject":
            self._json(404, {"status": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            self._json(411, {"status": "error", "detail": "Content-Length required"})
            return
        if length <= 0 or length > MAX_BYTES:
            self._json(413, {"status": "error", "detail": "message too large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
        except Exception:
            self._json(400, {"status": "error", "detail": "invalid JSON"})
            return

        token = payload.get("token", "")
        user = str(payload.get("user", "")).strip().lower()
        raw_mime = payload.get("rawMime", "")

        if not isinstance(token, str) or not hmac.compare_digest(token, TOKEN):
            log("inject: rejected bad token")
            self._json(403, {"status": "error", "detail": "bad token"})
            return
        if not user or user not in USERS:
            log("inject: rejected unknown user %r" % user)
            self._json(403, {"status": "error", "detail": "unknown user"})
            return
        if not isinstance(raw_mime, str) or not raw_mime:
            self._json(400, {"status": "error", "detail": "empty rawMime"})
            return

        raw_bytes = raw_mime.encode("utf-8")
        ok, detail = inject(user, raw_bytes)
        if ok:
            log("inject: user=%s bytes=%d ok" % (user, len(raw_bytes)))
            self._json(200, {"status": "ok"})
        else:
            log("inject: user=%s bytes=%d FAILED %s" % (user, len(raw_bytes), detail))
            self._json(502, {"status": "error", "detail": detail})

    def log_message(self, fmt, *args):
        # Keep the log to our own one-line entries above; BaseHTTPRequestHandler
        # access logs would only add noise (and never contain content anyway).
        pass


def main():
    if not TOKEN:
        print("MAIL_INJECT_TOKEN is not set; refusing to start.", file=sys.stderr)
        sys.exit(1)
    if not USERS:
        print("MAIL_INJECT_USERS is empty; refusing to start.", file=sys.stderr)
        sys.exit(1)
    server = ThreadingHTTPServer((BIND_HOST, BIND_PORT), Handler)
    log("mail-inject listening on %s:%d (users: %s)" % (BIND_HOST, BIND_PORT, ",".join(sorted(USERS))))
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
