# Home injection endpoint

A tiny Python service (standard library only) that the Cloudflare sync
worker calls to put waiting mail back into the home Dovecot inboxes.
It listens on localhost only and is reached from the internet through the
existing Cloudflare Tunnel — never directly.

## What it does

- `GET /health` — 200 when an injection path is available, 503 otherwise.
  This is what the sync worker polls to decide whether home is back.
- `POST /inject` with JSON `{"token", "user", "rawMime", "read",
  "deleted"}` — checks the token (constant-time compare) and that
  `user` is on the allowlist. Unread inbox mail is piped to sendmail
  inside the plMail Postfix (mta) container
  (`docker exec -i <MTA_CONTAINER> sendmail ...`), which delivers it
  to Dovecot exactly like a message that arrived directly. Every
  original header survives; the only header added is the usual
  `Received:` line Postfix adds to everything, and the envelope sender
  is set to the original `From:` address. The container path is used on
  purpose: the host's own sendmail binary accepts mail into a queue
  that is never processed (the host Postfix daemon is down), so the
  host binary is only a fallback when no container is configured.
  Read mail is stored with `\Seen` and deleted mail in the Trash
  folder instead, via `docker exec -i <MAILSTORE_CONTAINER> doveadm
  save -u <user> -m <mailbox> [-F \Seen]` — sendmail cannot set
  flags or choose a folder. If doveadm is unavailable for a
  read/deleted case the inject **fails** (the sync worker retries)
  rather than delivering to the wrong place.
- `POST /state` with JSON `{"token", "user", "messageId", "read",
  "deleted"}` — applies a backup-side read/delete state to the home
  copy: `\Seen` on/off (via `doveadm flags`), or move the INBOX copy
  to Trash (via `doveadm move`). A copy already in Trash stays there
  — nothing is ever moved out of Trash — and a message found nowhere
  is skipped (200 `skipped`), never resurrected or re-sent. Same token
  and allowlist as `/inject`.
- `GET /aliases` — every account's live aliases from plMail, keyed by the
  allowlist mailbox address, e.g.
  `{"support@bearermail.com": ["walmart@bearermail.com", ...]}`. Same
  token, sent as `Authorization: Bearer <token>`. The sync worker asks
  for this every few hours so the backup knows where alias mail belongs.
  Only non-inactive aliases are listed, and never the mailbox address
  itself. Read path: `docker exec` into the plMail database container
  and one `psql` query over the `email_alias` table — local socket
  connections there are trust auth, so no DB password is needed. If the
  database cannot be read it answers 503 and the worker keeps the
  last-known list.

Nothing is ever logged except one line per request (user, size, result).
The token and message contents never touch the log.

## Install (docker host, 192.168.8.100)

Run these on the docker host itself (Proxmox console), not over ssh from
elsewhere. All paths below are on that host.

```sh
# 1. Put the files in place
mkdir -p /opt/mail-inject
# copy mail-inject.py here (see step 2 for how the files get onto the host)
cp mail-inject.py /opt/mail-inject/
cp mail-inject.service /etc/systemd/system/

# 2. Find the Postfix (mta) container name — injection goes into this
#    container (default plmail-mail-server-mta-1). Do NOT use the host's
#    /usr/sbin/sendmail on its own: the host Postfix daemon is down, so
#    mail handed to it sits in the host queue forever and never reaches
#    Dovecot.
docker ps --format '{{.Names}} {{.Image}}' | grep -i -E 'postfix|mta|mail'

# 2b. Confirm the Trash folder name Dovecot uses (the default is
#     "Trash"; if your folder is named differently, set
#     MAIL_TRASH_FOLDER in the env file to match it):
docker exec plmail-mail-server-mailstore-1 doveadm mailbox list -u you@bearermail.com
#    Also confirm doveadm itself works from this host:
docker exec -i plmail-mail-server-mailstore-1 doveadm search -u you@bearermail.com mailbox INBOX ALL | head

# 3. Create the env file (use your real addresses, not the placeholders)
cat > /opt/mail-inject/mail-inject.env <<'EOF'
MAIL_INJECT_TOKEN=<paste the token from step 4>
MAIL_INJECT_USERS=you@bearermail.com,friend@bearermail.com
MTA_CONTAINER=plmail-mail-server-mta-1
#    Set this to the container name from step 2 if yours differs; the
#    default is plmail-mail-server-mta-1, so the line can be left out.
# /aliases only — defaults are usually right; set these only if your
# plMail database container, user or database name differ:
# PLMAIL_DB_CONTAINER=plmail-mail-server-database-1
# PLMAIL_DB_USER=app
# PLMAIL_DB_NAME=app
# Read/deleted injects and POST /state use the mailstore container
# (defaults are usually right; set these only if yours differ):
# MAILSTORE_CONTAINER=plmail-mail-server-mailstore-1
# MAIL_TRASH_FOLDER=Trash
# Home-to-backup watcher only — public URL of the sync worker:
# SYNC_WORKER_URL=https://cloud-mail-sync.soarespaulv.workers.dev
EOF
chmod 600 /opt/mail-inject/mail-inject.env

# 4. Make the token (run once, keep it secret)
openssl rand -hex 32
#    Use the value both here (MAIL_INJECT_TOKEN) and as the sync worker
#    secret SYNC_TOKEN. The two must be identical.

# 5. Start it
systemctl daemon-reload
systemctl enable --now mail-inject
curl -s http://127.0.0.1:8765/health
#    Expect: {"status": "ok"}
journalctl -u mail-inject -f   # one line per request; Ctrl-C to exit

# 6. Start the home-to-backup state watcher (optional but part of
#    the two-way sync: without it, reads/deletes made at home never
#    reach the backup). It reuses the same env file — just add
#    SYNC_WORKER_URL to it first (see step 3).
cp state-watch.py /opt/mail-inject/
cp state-watch.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now state-watch
journalctl -u state-watch -f   # one line per poll; Ctrl-C to exit
```

## Test the aliases endpoint

```sh
TOKEN=$(grep '^MAIL_INJECT_TOKEN=' /opt/mail-inject/mail-inject.env | cut -d= -f2-)
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8765/aliases
#    Expect: {"you@bearermail.com": ["alias@bearermail.com", ...], ...}
```

## Expose it through the Cloudflare Tunnel

The sync worker (running on Cloudflare) has to reach this service, so it
needs a public hostname on the tunnel. Add it in the Cloudflare Zero
Trust dashboard under the existing tunnel (Access -> Tunnels -> your
tunnel -> Public Hostname), or in `cloudflared`'s `config.yml`:

- Hostname, e.g. `sync.bearermail.com`
- Service: `http://localhost:8765` (the docker host's own loopback)

Point the tunnel straight at the service. Do **not** route it through
FeatherWall — this is a machine-to-machine endpoint, not a user-facing
app. Test from outside the LAN:

```sh
curl -s https://sync.bearermail.com/health
#    Expect: {"status": "ok"}
```

Then set the same hostname in the sync worker's vars
(`HOME_HEALTH_URL=https://sync.bearermail.com/health`,
`HOME_INJECT_URL=https://sync.bearermail.com/inject`).

## The state watcher (home → backup)

`state-watch.py` polls Dovecot every 5 minutes (via `doveadm fetch`
for `uid`, `flags` and `hdr.message-id` on INBOX + Trash) and reports
only two transitions to the sync worker (`POST /state`, same token):
a message gaining `\Seen`, and a message appearing in Trash. It
never deletes or moves home mail, never asks the backup for mail, and
never reports a message disappearing from Trash (expunge stays local
— the backup Trash copy is the last copy) or a message losing
`\Seen`. It keeps its seen-state in `/opt/mail-inject/
state-watch.json` and only saves it after every report in a poll
succeeds, so a failed report is retried next poll. First poll after
install converges safely: mail already read or already in Trash is
reported once (the backup treats an unchanged state as a no-op).

## Test an injection by hand

```sh
# Build a tiny test message and inject it as yourself.
printf 'From: test@example.com\r\nTo: you@bearermail.com\r\nSubject: merge-back test\r\n\r\nhello\r\n' > /tmp/test.eml
python3 - <<'EOF'
import json, os, urllib.request
raw = open('/tmp/test.eml', encoding='utf-8').read()
req = urllib.request.Request(
    'https://sync.bearermail.com/inject',
    data=json.dumps({
        'token': open('/opt/mail-inject/mail-inject.env').read().split('MAIL_INJECT_TOKEN=')[1].splitlines()[0].strip(),
        'user': 'you@bearermail.com',
        'rawMime': raw,
    }).encode('utf-8'),
    headers={'Content-Type': 'application/json'},
)
print(urllib.request.urlopen(req, timeout=30).read().decode())
EOF
# Then check the inbox in plMail: the test message should be there.
```

## Fallback if sendmail is not available: IMAP APPEND

If neither the mta container nor a host sendmail is reachable, messages
can be appended straight to a mailbox over IMAP instead. This needs the
mailbox password (or a Dovecot master user) and the mailstore's IMAP
address — it is a fallback, not the default path:

```python
import imaplib
from email.parser import BytesParser
from email.policy import default as p

raw = open('/tmp/test.eml', 'rb').read()
msg = BytesParser(policy=p).parsebytes(raw)
date = msg['Date']  # keep the original date as the internal date

m = imaplib.IMAP4_SSL('mailstore-host', 993)
m.login('you@bearermail.com', '<imap password>')
m.append('INBOX', None, date, raw)
m.logout()
```

A host-side alternative that needs no password is Dovecot's own tool,
run against the mailstore container:

```sh
docker exec -i <mailstore-container> doveadm save -u you@bearermail.com -m INBOX < /tmp/test.eml
```

## Notes and limits

- **Fidelity**: the raw message travels as a JSON string, so it is
  re-encoded as UTF-8 on arrival. Ordinary mail (UTF-8 throughout) is
  byte-identical. Mail carrying non-UTF-8 8-bit content may be altered
  in transit; the headers and body text still arrive intact.
- **Size**: messages over 25 MB are rejected with 413 (`MAX_BYTES`).
- **Duplicates**: the sync worker records every delivered message id in
  KV, so a retry never injects the same message twice. If you inject by
  hand, that protection does not apply.
- **Security**: localhost-only bind, shared-secret token, fixed user
  allowlist. The token is the only thing standing between the internet
  and your inboxes: use a long random value, never reuse a password,
  and rotate it (change it in both places) if it ever leaks.
