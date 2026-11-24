#!/usr/bin/env python3
"""Cloud Mail merge-back injection endpoint (home side).

Listens on localhost only. The Cloudflare sync worker POSTs each original
message here once the home lab is reachable again, and this service drops
it into the right user's Dovecot mailbox, so it shows up in plMail like
ordinary mail.

  POST /inject   {"token": ..., "user": ..., "rawMime": ...,
                  "read": true/false, "deleted": true/false}
                read mail is stored with \\Seen and deleted mail is
                stored in the Trash folder, via doveadm save; unread
                inbox mail keeps the sendmail path.
  POST /state    {"token": ..., "user": ..., "messageId": ...,
                  "read": true/false, "deleted": true/false}
                apply a backup-side read/delete state to the home copy:
                \\Seen on/off, or move the INBOX copy to Trash. Never
                moves anything out of Trash; a message found nowhere is
                skipped, never resurrected or re-sent.
  GET  /health  200 only when an injection path is available
  GET  /aliases  {"support@example.com": ["alias@example.com", ...], ...}
                every account's live aliases from plMail, keyed by the
                allowlist mailbox address. Same token, sent as
                `Authorization: Bearer <token>`. The backup asks for this
                every few hours so it knows where alias mail belongs.

Injection is done by piping the raw message to sendmail inside the plMail
Postfix (mta) container: `docker exec -i <MTA_CONTAINER> sendmail ...`.
Read and deleted mail cannot go through sendmail (it cannot set \\Seen
or choose a folder), so those are stored directly with Dovecot's own
tool: `docker exec -i <MAILSTORE_CONTAINER> doveadm save -u <user>
-m <mailbox> [-F \\Seen]`. State updates (POST /state) use the same
container: `doveadm search` to find a message by Message-ID, `doveadm
flags add/remove` for \\Seen, `doveadm move` for INBOX -> Trash.
The message is piped unchanged, so every original header survives and
Postfix delivers it to Dovecot exactly as it would a message that arrived
directly. The only header added is the usual Received: line Postfix adds
to everything.

The container path is preferred on purpose: the host's own
/usr/sbin/sendmail is Postfix's sendmail binary, but the host Postfix
daemon is down, so postdrop accepts messages with exit 0 and they sit
in the host queue forever, never reaching Dovecot. The host sendmail
binary is used only as a fallback when no container is configured or
docker is unavailable.

Standard library only: no third-party packages, no pip install.

Configuration (environment, see mail-inject.env):
  MAIL_INJECT_TOKEN  required. Shared secret; must match the sync worker's
                     SYNC_TOKEN secret. Checked with a constant-time compare.
  MAIL_INJECT_USERS  required. Comma-separated allowlist of home inbox
                     addresses, e.g. you@bearermail.com,friend@bearermail.com
                     Only these users ever receive injected mail.
  MTA_CONTAINER      name of the Postfix (mta) container, default
                     plmail-mail-server-mta-1. Injection goes here first:
                     `docker exec -i <container> sendmail ...`.
  SENDMAIL_BIN       host sendmail binary, default /usr/sbin/sendmail.
                     Fallback only, used when no container is configured
                     or docker is unavailable. Do NOT rely on it alone:
                     the host Postfix daemon is down, so anything handed
                     to it sits in the host queue forever.
  BIND_HOST          default 127.0.0.1 (do not expose this publicly).
  BIND_PORT          default 8765.
  MAX_BYTES          default 26214400 (25 MB). Larger messages get a 413.
  PLMAIL_DB_CONTAINER  plMail database container, default
                     plmail-mail-server-database-1. Used only by /aliases.
  PLMAIL_DB_USER     database user, default app. Used only by /aliases.
  PLMAIL_DB_NAME     database name, default app. Used only by /aliases.
  MAILSTORE_CONTAINER  Dovecot (mailstore) container, default
                     plmail-mail-server-mailstore-1. Used by the doveadm
                     paths: read/deleted injects and POST /state.
  MAIL_TRASH_FOLDER  home Trash folder name as Dovecot sees it, default
                     "Trash". Confirm with:
                     docker exec plmail-mail-server-mailstore-1 doveadm mailbox list -u you@bearermail.com

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
MTA_CONTAINER = os.environ.get("MTA_CONTAINER", "plmail-mail-server-mta-1").strip()
MAILSTORE_CONTAINER = os.environ.get("MAILSTORE_CONTAINER", "plmail-mail-server-mailstore-1").strip()
MAIL_TRASH_FOLDER = os.environ.get("MAIL_TRASH_FOLDER", "Trash").strip()
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
    # Container first: the host Postfix daemon is down, so the host
    # sendmail binary accepts mail into a queue that is never processed.
    if MTA_CONTAINER and shutil.which("docker"):
        return True
    return os.path.exists(SENDMAIL_BIN)


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


def run_doveadm(args, input_bytes=None, timeout=120):
    """Run a doveadm command inside the mailstore container.

    Returns (ok, stdout, detail). ok is False when docker or the
    container is unavailable, or doveadm exits non-zero.
    """
    if not MAILSTORE_CONTAINER or not shutil.which("docker"):
        return False, "", "doveadm unavailable (no docker or no mailstore container)"
    cmd = ["docker", "exec", "-i", MAILSTORE_CONTAINER, "doveadm"] + args
    try:
        proc = subprocess.run(cmd, input=input_bytes, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "", "doveadm timed out"
    except Exception as e:  # noqa: BLE001 - report anything, never crash the handler
        return False, "", "doveadm error: %s" % (e,)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()[:300]
        return False, "", "doveadm exited %d: %s" % (proc.returncode, err)
    return True, (proc.stdout or b"").decode("utf-8", "replace"), "ok"


def doveadm_search(user, mailbox, message_id):
    """UIDs of messages in `mailbox` whose Message-ID matches.

    Returns (ok, uids, detail). The match is a substring match on the
    header value (IMAP HEADER search semantics); the full `<...>`
    Message-ID is effectively exact. No match is ok=True with an
    empty list.
    """
    ok, out, detail = run_doveadm([
        "search", "-u", user, "mailbox", mailbox,
        "HEADER", "Message-ID", message_id,
    ])
    if not ok:
        return False, [], detail
    uids = [line.strip() for line in out.splitlines() if line.strip()]
    return True, uids, "ok"


def doveadm_flags(user, mailbox, message_id, action):
    """Add or remove \\Seen on messages matching a Message-ID.

    action is 'add' or 'remove'. Returns (ok, detail).
    """
    ok, _out, detail = run_doveadm([
        "flags", action, "-u", user, "\\Seen",
        "mailbox", mailbox, "HEADER", "Message-ID", message_id,
    ])
    return ok, detail


def inject_doveadm(user, raw_bytes, mailbox, seen):
    """Store the raw message directly in a Dovecot mailbox, with flags.

    Used when the backup state says read or deleted: sendmail cannot
    set \\Seen or choose a folder. Returns (ok, detail).
    """
    args = ["save", "-u", user, "-m", mailbox]
    if seen:
        args += ["-F", "\\Seen"]
    ok, _out, detail = run_doveadm(args, input_bytes=raw_bytes)
    return ok, detail


def inject(user, raw_bytes, read=False, deleted=False):
    """Deliver the raw message to the user's mailbox. Returns (ok, detail).

    Unread inbox mail takes the exact sendmail path that has always
    worked. Read mail is stored with \\Seen and deleted mail is stored
    in the Trash folder (with \\Seen if it was read) via doveadm save.
    If doveadm is unavailable for a read/deleted case the inject FAILS
    (the sync worker retries) rather than delivering to the wrong place.
    """
    if not read and not deleted:
        return inject_sendmail(user, raw_bytes)
    if not MAILSTORE_CONTAINER or not shutil.which("docker"):
        return False, "doveadm unavailable (no docker or no mailstore container)"
    mailbox = MAIL_TRASH_FOLDER if deleted else "INBOX"
    return inject_doveadm(user, raw_bytes, mailbox, seen=read)


def apply_state(user, message_id, read, deleted):
    """Apply a backup-side read/delete state to the home copy.

    Returns ("ok"|"skipped"|"failed", detail).
    - read=True adds \\Seen; read=False removes it; read=None leaves flags alone.
    - deleted=True moves the INBOX copy to Trash (the read flag is
      applied to the Trash copy afterwards); a copy already in Trash
      stays there — nothing is ever moved OUT of Trash.
    - Nothing is ever re-sent: a message found nowhere is skipped,
      not resurrected.
    """
    ok, inbox_uids, detail = doveadm_search(user, "INBOX", message_id)
    if not ok:
        return "failed", detail
    if inbox_uids:
        folder = "INBOX"
        if deleted:
            ok, _out, detail = run_doveadm([
                "move", "-u", user, MAIL_TRASH_FOLDER,
                "mailbox", "INBOX", "HEADER", "Message-ID", message_id,
            ])
            if not ok:
                return "failed", detail
            folder = MAIL_TRASH_FOLDER
        if read is not None:
            ok, detail = doveadm_flags(user, folder, message_id, "add" if read else "remove")
            if not ok:
                return "failed", detail
        return "ok", "ok"
    ok, trash_uids, detail = doveadm_search(user, MAIL_TRASH_FOLDER, message_id)
    if not ok:
        return "failed", detail
    if trash_uids:
        # Already in Trash: never move it out. Only the read flag may
        # still change on the Trash copy.
        if read is not None:
            ok, detail = doveadm_flags(user, MAIL_TRASH_FOLDER, message_id, "add" if read else "remove")
            if not ok:
                return "failed", detail
        return "ok", "ok"
    return "skipped", "not found"


def inject_sendmail(user, raw_bytes):
    """Pipe the raw message to sendmail. Returns (ok, detail)."""
    from_addr = extract_from(raw_bytes)
    args = ["-i"]
    if from_addr:
        args += ["-f", from_addr]
    args.append(user)

    try:
        # Container first: the host Postfix daemon is down, so anything
        # piped to the host sendmail binary sits in the host queue
        # forever and never reaches Dovecot. Fall back to the host
        # binary only when no container is configured or docker is
        # unavailable.
        if MTA_CONTAINER and shutil.which("docker"):
            cmd = ["docker", "exec", "-i", MTA_CONTAINER, "sendmail"] + args
        elif os.path.exists(SENDMAIL_BIN):
            cmd = [SENDMAIL_BIN] + args
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

    def _read_json_body(self):
        """Read and parse a JSON POST body. Returns (payload, error_status, error_detail)."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            return None, 411, "Content-Length required"
        if length <= 0 or length > MAX_BYTES:
            return None, 413, "message too large"
        try:
            payload = json.loads(self.rfile.read(length))
        except Exception:
            return None, 400, "invalid JSON"
        if not isinstance(payload, dict):
            return None, 400, "invalid JSON"
        return payload, None, None

    def _check_token_user(self, payload):
        """Shared token + allowlist check for POST endpoints.

        Returns (user, error_status, error_detail). `user` is None on
        failure. The token is the same MAIL_INJECT_TOKEN the sync
        worker already sends.
        """
        token = payload.get("token", "")
        user = str(payload.get("user", "")).strip().lower()
        if not isinstance(token, str) or not hmac.compare_digest(token, TOKEN):
            log("rejected bad token")
            return None, 403, "bad token"
        if not user or user not in USERS:
            log("rejected unknown user %r" % user)
            return None, 403, "unknown user"
        return user, None, None

    def do_POST(self):
        path = urlsplit(self.path).path
        if path not in ("/inject", "/state"):
            self._json(404, {"status": "not found"})
            return
        payload, err_status, err_detail = self._read_json_body()
        if payload is None:
            self._json(err_status, {"status": "error", "detail": err_detail})
            return
        user, err_status, err_detail = self._check_token_user(payload)
        if user is None:
            self._json(err_status, {"status": "error", "detail": err_detail})
            return

        if path == "/state":
            self._do_state(user, payload)
            return

        raw_mime = payload.get("rawMime", "")
        if not isinstance(raw_mime, str) or not raw_mime:
            self._json(400, {"status": "error", "detail": "empty rawMime"})
            return
        # Strict booleans: only a real JSON true counts as read/deleted.
        read = payload.get("read") is True
        deleted = payload.get("deleted") is True

        raw_bytes = raw_mime.encode("utf-8")
        ok, detail = inject(user, raw_bytes, read=read, deleted=deleted)
        if ok:
            log("inject: user=%s bytes=%d read=%s deleted=%s ok" % (user, len(raw_bytes), read, deleted))
            self._json(200, {"status": "ok"})
        else:
            log("inject: user=%s bytes=%d read=%s deleted=%s FAILED %s" % (user, len(raw_bytes), read, deleted, detail))
            self._json(502, {"status": "error", "detail": detail})

    def _do_state(self, user, payload):
        """POST /state: apply a backup-side read/delete state."""
        message_id = payload.get("messageId", "")
        if not isinstance(message_id, str) or not message_id.strip():
            self._json(400, {"status": "error", "detail": "empty messageId"})
            return
        message_id = message_id.strip()
        # read/deleted are optional: only a real JSON boolean counts.
        # Absent means "leave that part alone".
        read = payload.get("read")
        if read is not True and read is not False:
            read = None
        deleted = payload.get("deleted") is True
        result, detail = apply_state(user, message_id, read, deleted)
        if result == "failed":
            log("state: user=%s FAILED %s" % (user, detail))
            self._json(502, {"status": "error", "detail": detail})
        else:
            log("state: user=%s read=%s deleted=%s %s" % (user, read, deleted, result))
            self._json(200, {"status": result, "detail": detail})

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
