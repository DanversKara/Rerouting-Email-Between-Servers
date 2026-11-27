#!/usr/bin/env python3
"""Home-to-backup mirror watcher.

Polls Dovecot (via doveadm in the mailstore container) every 10 seconds
and tells the Cloudflare sync worker about everything a user did at home
(in plMail) that the backup has to mirror:

State (POST <SYNC_WORKER_URL>/state):
  - a message gains \\Seen               -> {"read": true}
  - a message loses \\Seen (marked unread) -> {"read": false}
  - a message moves INBOX -> Trash       -> {"deleted": true}
  - a message moves Trash -> INBOX       -> {"restored": true}

Content (POST <SYNC_WORKER_URL>/import):
  - a new message in Sent (the user sent mail from plMail)
        -> kind "send": the backup files it in the user's Sent list
  - a new message in INBOX the backup has never seen (mail that reached
    home without passing through the backup)
        -> kind "receive"
  Each import first asks with just the Message-ID; the message itself is
  only uploaded when the backup answers "need_raw", so mail that came
  from the backup in the first place costs one small request.

What is deliberately NOT reported:
  - a message disappearing from Trash (emptying Trash at home is local;
    the backup Trash copy stays until the user empties it there too),
  - a message vanishing from INBOX without appearing in Trash (moved to
    another folder, not deleted).

The first time a user is seen (or the first time Sent is watched) the
current contents are recorded as the baseline and NOT imported, so
installing or upgrading this never floods the backup with old mail.

State is kept in STATE_FILE and updated per message as each report
succeeds, so a failed report is simply re-detected on the next poll.

Standard library only: no third-party packages, no pip install.

Configuration (environment, same file as mail-inject:
 /opt/mail-inject/mail-inject.env):
  MAIL_INJECT_TOKEN  required unless OPENBAO_TOKEN is set. Same value as
                     the sync worker's SYNC_TOKEN secret.
  OPENBAO_TOKEN      optional. Limited OpenBao token (the badge) that may
                     only read secret/mail-inject/sync-token. When set, the
                     real sync token is fetched from the vault at startup
                     and kept only in memory; MAIL_INJECT_TOKEN is then
                     ignored. When unset, MAIL_INJECT_TOKEN is used as
                     before, so the old .env still works as a rollback.
  OPENBAO_ADDR       OpenBao address, default http://192.168.8.100:8200.
                     Only used when OPENBAO_TOKEN is set.
  MAIL_INJECT_USERS  required. Comma-separated allowlist, same as
                     mail-inject. Only these users are watched.
  SYNC_WORKER_URL    required. Public URL of the sync worker, e.g.
                     https://cloud-mail-sync.<you>.workers.dev
                     (no trailing slash).
  MAILSTORE_CONTAINER  default plmail-mail-server-mailstore-1.
  MAIL_TRASH_FOLDER  default "Trash".
  MAIL_SENT_FOLDER   default "Sent".
  STATE_FILE         default /opt/mail-inject/state-watch.json.
  POLL_SECONDS       default 10 (minimum 5).
  IMPORT_INBOX       default 1. Set 0 to stop importing INBOX mail that
                     did not come through the backup.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

MAILSTORE_CONTAINER = os.environ.get("MAILSTORE_CONTAINER", "plmail-mail-server-mailstore-1").strip()
MAIL_TRASH_FOLDER = os.environ.get("MAIL_TRASH_FOLDER", "Trash").strip()
MAIL_SENT_FOLDER = os.environ.get("MAIL_SENT_FOLDER", "Sent").strip()
# The sync token is resolved in main() (load_token): from the vault when
# OPENBAO_TOKEN is set, else from MAIL_INJECT_TOKEN. Kept only in memory.
TOKEN = ""
OPENBAO_ADDR = os.environ.get("OPENBAO_ADDR", "http://192.168.8.100:8200").strip().rstrip("/")
OPENBAO_TOKEN = os.environ.get("OPENBAO_TOKEN", "").strip()
OPENBAO_SECRET_PATH = "mail-inject/sync-token"


def fetch_token_from_openbao(addr, bao_token):
    """Read the sync token from OpenBao KV v2. Returns the token string.

    Raises RuntimeError with a plain message on any failure (sealed vault,
    bad badge, unreachable, missing key). Never logs the token.
    """
    url = addr + "/v1/secret/data/" + OPENBAO_SECRET_PATH
    req = urllib.request.Request(url, headers={"X-Vault-Token": bao_token})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.load(resp)
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            "OpenBao HTTP %s (vault may be sealed or the badge token invalid)" % e.code)
    except Exception as e:  # noqa: BLE001 - report anything, never crash startup
        raise RuntimeError("OpenBao unreachable: %s" % e)
    token = (data.get("data") or {}).get("data", {}).get("token", "")
    if not token:
        raise RuntimeError("OpenBao secret %s has no 'token' key" % OPENBAO_SECRET_PATH)
    return token


def load_token():
    """Resolve the sync token.

    When OPENBAO_TOKEN (the limited badge) is set, the real token is
    fetched from the vault at startup and kept only in memory. Otherwise
    fall back to MAIL_INJECT_TOKEN (the pre-vault behaviour), so the old
    .env still works as a rollback.
    """
    if OPENBAO_TOKEN:
        return fetch_token_from_openbao(OPENBAO_ADDR, OPENBAO_TOKEN)
    return os.environ.get("MAIL_INJECT_TOKEN", "").strip()
USERS = {
    u.strip().lower()
    for u in os.environ.get("MAIL_INJECT_USERS", "").split(",")
    if u.strip()
}
SYNC_WORKER_URL = os.environ.get("SYNC_WORKER_URL", "").rstrip("/")
STATE_FILE = os.environ.get("STATE_FILE", "/opt/mail-inject/state-watch.json")
IMPORT_INBOX = os.environ.get("IMPORT_INBOX", "1").strip() not in ("0", "false", "no")
MAX_RAW_BYTES = 25 * 1024 * 1024
try:
    POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "10"))
except ValueError:
    POLL_SECONDS = 10
if POLL_SECONDS < 5:
    POLL_SECONDS = 5

STATE_VERSION = 2

# Cloudflare answers 403 to Python's default "Python-urllib/x.y"
# User-Agent (bot protection), which is why the watcher could never
# reach the sync worker. Identify ourselves with an explicit one.
USER_AGENT = "bearermail-state-watch/2 (+home-inject)"


def log(msg):
    print(msg, flush=True)


# ---------------------------------------------------------------------------
# Dovecot
# ---------------------------------------------------------------------------

def run_doveadm(args, timeout=120, raw=False):
    """Run doveadm in the mailstore container. Returns (ok, stdout, detail)."""
    if not MAILSTORE_CONTAINER or not shutil.which("docker"):
        return False, b"" if raw else "", "doveadm unavailable (no docker or no mailstore container)"
    cmd = ["docker", "exec", MAILSTORE_CONTAINER, "doveadm"] + args
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, b"" if raw else "", "doveadm timed out"
    except Exception as e:  # noqa: BLE001 - report anything, never crash the poll
        return False, b"" if raw else "", "doveadm error: %s" % (e,)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()[:300]
        return False, b"" if raw else "", "doveadm exited %d: %s" % (proc.returncode, err)
    out = proc.stdout or b""
    return True, out if raw else out.decode("utf-8", "replace"), "ok"


def parse_fetch_output(out):
    """Parse `doveadm fetch 'uid flags hdr.message-id'` output.

    One `key: value` field per line, a blank (or form-feed) line between
    messages. Blocks without a Message-ID or uid are skipped. Returns
    {messageId: {"uid": str, "read": bool}}.
    """
    result = {}
    blocks = []
    current = []
    for line in out.splitlines():
        if line.strip() == "":
            if current:
                blocks.append(current)
                current = []
        else:
            current.append(line)
    if current:
        blocks.append(current)
    for block in blocks:
        segments = {}
        for line in block:
            m = re.match(r"^(uid|flags|hdr\.message-id)[:=]\s*(.*)$", line.strip())
            if m:
                segments[m.group(1)] = m.group(2).strip()
        message_id = segments.get("hdr.message-id", "")
        uid = segments.get("uid", "")
        if not message_id or not uid:
            continue
        flags = segments.get("flags", "")
        result[message_id] = {"uid": uid, "read": "\\Seen" in flags.split()}
    return result


def fetch_folder(user, mailbox):
    """Current {messageId: {uid, read}} for one folder. Returns (ok, mapping, detail)."""
    ok, out, detail = run_doveadm([
        "fetch", "-u", user, "uid flags hdr.message-id",
        "mailbox", mailbox,
    ])
    if not ok:
        return False, {}, detail
    return True, parse_fetch_output(out), "ok"


def fetch_raw(user, mailbox, uid):
    """The full message (headers + body) by UID. Returns (ok, bytes, detail).

    `doveadm -f pager fetch text` prints `text:` on the first line and
    the message after it, then a form feed; both are stripped.
    """
    ok, out, detail = run_doveadm([
        "-f", "pager", "fetch", "-u", user, "text",
        "mailbox", mailbox, "uid", str(uid),
    ], raw=True)
    if not ok:
        return False, b"", detail
    if out.startswith(b"text:"):
        out = out[len(b"text:"):]
        if out.startswith(b"\r\n"):
            out = out[2:]
        elif out.startswith(b"\n") or out.startswith(b" "):
            out = out[1:]
    out = out.rstrip(b"\f\r\n")
    if not out:
        return False, b"", "empty message"
    if len(out) > MAX_RAW_BYTES:
        return False, b"", "message too large to upload"
    return True, out + b"\r\n", "ok"


# ---------------------------------------------------------------------------
# Sync worker
# ---------------------------------------------------------------------------

def post_json(path, body, timeout=30):
    """POST to the sync worker. Returns (ok, data_or_detail)."""
    req = urllib.request.Request(
        SYNC_WORKER_URL + path,
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json", "User-Agent": USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            err_data = json.loads(e.read().decode("utf-8") or "{}")
            if isinstance(err_data, dict) and err_data.get("detail"):
                detail = " (%s)" % err_data["detail"]
        except Exception:
            pass
        return False, "HTTP %d%s" % (e.code, detail)
    except Exception as e:  # noqa: BLE001
        return False, "post failed: %s" % (e,)
    if not isinstance(data, dict) or data.get("status") == "error":
        return False, "worker refused: %s" % (data.get("detail", "?") if isinstance(data, dict) else "?")
    return True, data


def report_state(user, message_id, read=None, deleted=False, restored=False):
    body = {"syncToken": TOKEN, "user": user, "messageId": message_id}
    if read is not None:
        body["read"] = read
    if deleted:
        body["deleted"] = True
    if restored:
        body["restored"] = True
    ok, data = post_json("/state", body)
    return ok, (data if not ok else "ok")


def import_message(user, kind, mailbox, message_id, uid, read):
    """Make sure the backup has this message. Returns (ok, detail)."""
    base = {"syncToken": TOKEN, "user": user, "kind": kind, "messageId": message_id, "read": bool(read)}
    ok, data = post_json("/import", base)
    if not ok:
        return False, data
    status = data.get("status")
    if status != "need_raw":
        return True, status or "ok"
    ok, raw, detail = fetch_raw(user, mailbox, uid)
    if not ok:
        if detail == "message too large to upload":
            log("watch: user=%s %s import skipped (%s)" % (user, kind, detail))
            return True, "too large"
        return False, detail
    body = dict(base)
    body["rawMime"] = raw.decode("utf-8", "replace")
    ok, data = post_json("/import", body, timeout=120)
    if not ok:
        return False, data
    return True, data.get("status") or "ok"


# ---------------------------------------------------------------------------
# State file
# ---------------------------------------------------------------------------

def load_state():
    """{"v": 2, "users": {user: {"msgs": {...}, "sent": {...}}}}.

    Version-1 files ({user: {messageId: {folder, read}}}) are upgraded in
    place: their messages become the INBOX/Trash baseline, and Sent gets
    its own baseline on the first poll.
    """
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = None
    if not isinstance(data, dict):
        return {"v": STATE_VERSION, "users": {}}
    if data.get("v") == STATE_VERSION and isinstance(data.get("users"), dict):
        return data
    users = {}
    for user, msgs in data.items():
        if isinstance(msgs, dict):
            users[user] = {"msgs": msgs}
    return {"v": STATE_VERSION, "users": users}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


# ---------------------------------------------------------------------------
# One poll
# ---------------------------------------------------------------------------

def poll_user(user, prev_user):
    """One poll for one user. Returns (new_user_state, all_ok)."""
    prev_msgs = prev_user.get("msgs")
    first_inbox = not isinstance(prev_msgs, dict)
    prev_msgs = prev_msgs if isinstance(prev_msgs, dict) else {}
    prev_sent = prev_user.get("sent")
    first_sent = not isinstance(prev_sent, dict)
    prev_sent = prev_sent if isinstance(prev_sent, dict) else {}

    current = {}
    for mailbox in ("INBOX", MAIL_TRASH_FOLDER):
        ok, mapping, detail = fetch_folder(user, mailbox)
        if not ok:
            log("watch: user=%s fetch %s FAILED %s" % (user, mailbox, detail))
            return prev_user, False
        for message_id, info in mapping.items():
            # INBOX wins if a move is mid-flight between the two fetches.
            if message_id not in current:
                current[message_id] = {"folder": mailbox, "read": info["read"], "uid": info["uid"]}

    all_ok = True
    new_msgs = {}
    for message_id, info in current.items():
        now_state = {"folder": info["folder"], "read": info["read"]}
        old = prev_msgs.get(message_id)
        ok = True
        if old is None:
            if first_inbox:
                # Baseline: converge state only (the backup treats an
                # unchanged state as a no-op), never import.
                if info["folder"] == MAIL_TRASH_FOLDER:
                    ok, detail = report_state(user, message_id, read=True if info["read"] else None, deleted=True)
                elif info["read"]:
                    ok, detail = report_state(user, message_id, read=True)
            elif info["folder"] == "INBOX" and IMPORT_INBOX:
                ok, detail = import_message(user, "receive", "INBOX", message_id, info["uid"], info["read"])
                if ok and info["read"]:
                    ok, detail = report_state(user, message_id, read=True)
            elif info["folder"] == MAIL_TRASH_FOLDER:
                ok, detail = report_state(user, message_id, read=True if info["read"] else None, deleted=True)
            elif info["read"]:
                ok, detail = report_state(user, message_id, read=True)
        else:
            moved_to_trash = old.get("folder") == "INBOX" and info["folder"] == MAIL_TRASH_FOLDER
            restored = old.get("folder") == MAIL_TRASH_FOLDER and info["folder"] == "INBOX"
            read_changed = bool(old.get("read")) != info["read"]
            if moved_to_trash or restored or read_changed:
                ok, detail = report_state(
                    user, message_id,
                    read=info["read"] if read_changed else None,
                    deleted=moved_to_trash,
                    restored=restored,
                )
        if ok:
            new_msgs[message_id] = now_state
        else:
            all_ok = False
            log("watch: user=%s report %s FAILED %s" % (user, message_id, detail))
            if old is not None:
                new_msgs[message_id] = old  # re-detected next poll
    # Messages gone from INBOX/Trash (expunged, or moved to another
    # folder) simply drop out of the state: deliberately silent.

    new_sent = dict(prev_sent)
    ok, sent_now, detail = fetch_folder(user, MAIL_SENT_FOLDER)
    if not ok:
        log("watch: user=%s fetch %s FAILED %s" % (user, MAIL_SENT_FOLDER, detail))
        all_ok = False
    else:
        new_sent = {}
        for message_id, info in sent_now.items():
            if first_sent or message_id in prev_sent:
                new_sent[message_id] = 1
                continue
            ok, detail = import_message(user, "send", MAIL_SENT_FOLDER, message_id, info["uid"], True)
            if ok:
                new_sent[message_id] = 1
                log("watch: user=%s sent %s -> backup: %s" % (user, message_id, detail))
            else:
                all_ok = False
                log("watch: user=%s sent import %s FAILED %s" % (user, message_id, detail))

    return {"msgs": new_msgs, "sent": new_sent}, all_ok


def poll_all():
    state = load_state()
    users_state = state.get("users", {})
    new_users = {}
    all_ok = True
    for user in sorted(USERS):
        prev_user = users_state.get(user) if isinstance(users_state.get(user), dict) else {}
        updated, ok = poll_user(user, prev_user)
        new_users[user] = updated
        if not ok:
            all_ok = False
    try:
        save_state({"v": STATE_VERSION, "users": new_users})
    except OSError as e:
        log("watch: state file save FAILED %s" % (e,))
        return False
    return all_ok


def check_worker_url():
    """Verify SYNC_WORKER_URL actually points at the sync worker."""
    for attempt in range(5):
        try:
            req = urllib.request.Request(SYNC_WORKER_URL + "/", headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=15) as resp:
                body = resp.read().decode("utf-8", "replace")
                if resp.status == 200 and "cloud-mail merge-back sync worker" in body:
                    return True, "ok"
                return False, "unexpected answer HTTP %d: %s" % (resp.status, body[:120])
        except urllib.error.HTTPError as e:
            if e.code == 403:
                return False, "HTTP 403 (blocked by Cloudflare, or not the sync worker — check SYNC_WORKER_URL and any WAF/Bot Fight rules on workers.dev)"
            return False, "HTTP %d (this URL is not the sync worker — check SYNC_WORKER_URL)" % e.code
        except Exception as e:  # noqa: BLE001 - transient network error; retry
            if attempt < 4:
                time.sleep(10)
                continue
            return False, "unreachable: %s" % (e,)
    return False, "unreachable"


def main():
    global TOKEN
    try:
        TOKEN = load_token()
    except RuntimeError as e:
        print("could not load sync token: %s" % e, file=sys.stderr)
        sys.exit(1)
    if not TOKEN:
        print("no sync token configured (MAIL_INJECT_TOKEN or OPENBAO_TOKEN); refusing to start.", file=sys.stderr)
        sys.exit(1)
    if not USERS:
        print("MAIL_INJECT_USERS is empty; refusing to start.", file=sys.stderr)
        sys.exit(1)
    if not SYNC_WORKER_URL:
        print("SYNC_WORKER_URL is not set; refusing to start.", file=sys.stderr)
        sys.exit(1)
    ok, detail = check_worker_url()
    if not ok:
        print("SYNC_WORKER_URL check failed (%s): %s; refusing to start."
              % (SYNC_WORKER_URL, detail), file=sys.stderr)
        sys.exit(1)
    log("state-watch starting (users: %s, poll every %ds, sent folder: %s, inbox import: %s)"
        % (",".join(sorted(USERS)), POLL_SECONDS, MAIL_SENT_FOLDER, "on" if IMPORT_INBOX else "off"))
    while True:
        started = time.monotonic()
        try:
            if not poll_all():
                log("watch: poll had failures; will retry next round")
        except Exception as e:  # noqa: BLE001 - one bad poll must not kill the watcher
            log("watch: poll crashed: %s" % (e,))
        time.sleep(max(1.0, POLL_SECONDS - (time.monotonic() - started)))


if __name__ == "__main__":
    main()
