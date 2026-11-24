#!/usr/bin/env python3
"""Home-to-backup mail state watcher.

Polls Dovecot (via doveadm in the mailstore container) every few
minutes and reports read/delete transitions to the Cloudflare sync
worker, which forwards them to the backup webmail with its admin
login. That is the home-to-backup half of the two-way state sync:
the backup and home inboxes keep the same read/unread and Trash
state.

What is reported (only transitions, only these two):
  - an INBOX message gains \\Seen  -> {"read": true}
  - a message appears in Trash    -> {"deleted": true}
    (a message that arrives in Trash already-read reports both)

What is NEVER reported:
  - a message disappearing from Trash (expunge stays local — the
    backup Trash copy is the last copy),
  - a message vanishing from INBOX without appearing in Trash
    (it may have been moved to another folder, not deleted),
  - a message losing \\Seen (un-read at home stays local).

The watcher never deletes home mail, never moves mail, and never
asks the backup for mail: it only POSTs state deltas to the sync
worker (POST /state, authenticated with the same MAIL_INJECT_TOKEN
the sync worker already sends to mail-inject as SYNC_TOKEN).

State is kept in a local JSON file (STATE_FILE): {user: {messageId:
{"folder": "INBOX"|"Trash", "read": bool}}}. The file is only
rewritten after every report in a poll succeeds, so a failed POST
is re-detected and retried on the next poll instead of being lost.

Standard library only: no third-party packages, no pip install.

Configuration (environment, same file as mail-inject:
 /opt/mail-inject/mail-inject.env):
  MAIL_INJECT_TOKEN  required. Same value as the sync worker's
                     SYNC_TOKEN secret. Checked by the sync worker
                     with a constant-time compare.
  MAIL_INJECT_USERS  required. Comma-separated allowlist, same as
                     mail-inject. Only these users are watched.
  MAILSTORE_CONTAINER  Dovecot (mailstore) container, default
                     plmail-mail-server-mailstore-1.
  MAIL_TRASH_FOLDER  home Trash folder name as Dovecot sees it,
                     default "Trash".
  SYNC_WORKER_URL    required. Public URL of the sync worker, e.g.
                     https://cloud-mail-sync.soarespaulv.workers.dev
                     (no trailing slash). Reports go to <url>/state.
  STATE_FILE         default /opt/mail-inject/state-watch.json.
  POLL_SECONDS       default 60 (1 minute).
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
TOKEN = os.environ.get("MAIL_INJECT_TOKEN", "")
USERS = {
    u.strip().lower()
    for u in os.environ.get("MAIL_INJECT_USERS", "").split(",")
    if u.strip()
}
SYNC_WORKER_URL = os.environ.get("SYNC_WORKER_URL", "").rstrip("/")
STATE_FILE = os.environ.get("STATE_FILE", "/opt/mail-inject/state-watch.json")
try:
    POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "60"))
except ValueError:
    POLL_SECONDS = 60
if POLL_SECONDS < 60:
    POLL_SECONDS = 60


def log(msg):
    print(msg, flush=True)


def run_doveadm(args, timeout=120):
    """Run doveadm in the mailstore container. Returns (ok, stdout, detail)."""
    if not MAILSTORE_CONTAINER or not shutil.which("docker"):
        return False, "", "doveadm unavailable (no docker or no mailstore container)"
    cmd = ["docker", "exec", MAILSTORE_CONTAINER, "doveadm"] + args
    try:
        proc = subprocess.run(cmd, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return False, "", "doveadm timed out"
    except Exception as e:  # noqa: BLE001 - report anything, never crash the poll
        return False, "", "doveadm error: %s" % (e,)
    if proc.returncode != 0:
        err = (proc.stderr or b"").decode("utf-8", "replace").strip()[:300]
        return False, "", "doveadm exited %d: %s" % (proc.returncode, err)
    return True, (proc.stdout or b"").decode("utf-8", "replace"), "ok"


def parse_fetch_output(out):
    """Parse `doveadm fetch 'uid flags hdr.message-id'` output.

    Real doveadm output is one `key: value` field per line, with a
    blank line between messages, e.g.
        uid: 12
        flags: \\Seen
        hdr.message-id: <abc@example.com>

        uid: 13
        flags:
        hdr.message-id: <def@example.com>
    (A field may also use `=` instead of `:`; that form is accepted
    defensively.) Blocks without a Message-ID or uid are skipped
    (nothing to match them against). Returns
    {messageId: {"uid": str, "read": bool}}.
    """
    result = {}
    # Group lines into per-message blocks on blank lines.
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
    """Current {messageId: {uid, read}} for one folder.

    Returns (ok, mapping, detail).
    """
    ok, out, detail = run_doveadm([
        "fetch", "-u", user, "uid flags hdr.message-id",
        "mailbox", mailbox,
    ])
    if not ok:
        return False, {}, detail
    return True, parse_fetch_output(out), "ok"


def post_report(message_id, read, deleted):
    """POST one state delta to the sync worker. Returns (ok, detail)."""
    body = {"syncToken": TOKEN, "messageId": message_id}
    if read is not None:
        body["read"] = read
    if deleted:
        body["deleted"] = True
    req = urllib.request.Request(
        SYNC_WORKER_URL + "/state",
        data=json.dumps(body).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            data = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:
        return False, "HTTP %d" % e.code
    except Exception as e:  # noqa: BLE001
        return False, "post failed: %s" % (e,)
    if not isinstance(data, dict) or data.get("status") in ("error",):
        return False, "worker refused: %s" % (data.get("detail", "?") if isinstance(data, dict) else "?")
    return True, "ok"


def load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            return data
    except (OSError, ValueError):
        pass
    return {}


def save_state(state):
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(state, f)
    os.replace(tmp, STATE_FILE)


def poll_user(user, prev):
    """One poll for one user. Returns (new_state, ok).

    `prev` is {messageId: {"folder", "read"}} from the state file.
    Reports are sent first; the new state is only returned for
    saving when every report succeeded, so a failed report is
    re-detected on the next poll.
    """
    current = {}
    for mailbox in ("INBOX", MAIL_TRASH_FOLDER):
        ok, mapping, detail = fetch_folder(user, mailbox)
        if not ok:
            log("watch: user=%s fetch %s FAILED %s" % (user, mailbox, detail))
            return prev, False
        for message_id, info in mapping.items():
            # A message cannot be in two folders; INBOX wins if a
            # move is mid-flight between the two fetches.
            if message_id not in current:
                current[message_id] = {"folder": mailbox, "read": info["read"]}

    reports = []
    for message_id, info in current.items():
        old = prev.get(message_id)
        if old is None:
            # New to the watcher: report only if it is already read
            # or already in Trash; unread inbox mail needs nothing.
            if info["folder"] == MAIL_TRASH_FOLDER:
                reports.append((message_id, info["read"] or None, True))
            elif info["read"]:
                reports.append((message_id, True, False))
            continue
        if old.get("folder") == "INBOX" and info["folder"] == MAIL_TRASH_FOLDER:
            # Moved to Trash: report the delete (and the read, if it
            # gained \\Seen in the same interval).
            read = True if info["read"] and not old.get("read") else None
            reports.append((message_id, read, True))
        elif old.get("folder") == "INBOX" and info["folder"] == "INBOX":
            if info["read"] and not old.get("read"):
                reports.append((message_id, True, False))
        # Anything else (read -> unread, Trash -> gone, INBOX -> gone)
        # is deliberately silent: see the module docstring.

    for message_id, read, deleted in reports:
        ok, detail = post_report(message_id, read, deleted)
        if not ok:
            log("watch: user=%s report FAILED %s" % (user, detail))
            return prev, False
    return current, True


def poll_all():
    """One poll for every allowlisted user. Returns True if all ok."""
    state = load_state()
    new_state = {}
    all_ok = True
    for user in sorted(USERS):
        prev = state.get(user, {}) if isinstance(state.get(user), dict) else {}
        updated, ok = poll_user(user, prev)
        if ok:
            new_state[user] = updated
        else:
            # Keep the old state for this user so its transitions
            # are re-detected next poll; other users still converge.
            new_state[user] = prev
            all_ok = False
    try:
        save_state(new_state)
    except OSError as e:
        log("watch: state file save FAILED %s" % (e,))
        return False
    return all_ok


def main():
    if not TOKEN:
        print("MAIL_INJECT_TOKEN is not set; refusing to start.", file=sys.stderr)
        sys.exit(1)
    if not USERS:
        print("MAIL_INJECT_USERS is empty; refusing to start.", file=sys.stderr)
        sys.exit(1)
    if not SYNC_WORKER_URL:
        print("SYNC_WORKER_URL is not set; refusing to start.", file=sys.stderr)
        sys.exit(1)
    log("state-watch starting (users: %s, poll every %ds, state file: %s)"
        % (",".join(sorted(USERS)), POLL_SECONDS, STATE_FILE))
    while True:
        try:
            ok = poll_all()
            if not ok:
                log("watch: poll had failures; will retry next round")
        except Exception as e:  # noqa: BLE001 - one bad poll must not kill the watcher
            log("watch: poll crashed: %s" % (e,))
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    main()
