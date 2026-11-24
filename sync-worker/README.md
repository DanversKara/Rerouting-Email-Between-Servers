# Cloud Mail merge-back sync worker

Pushes mail that Cloud Mail caught while the home lab was unreachable back
into the users' home (Dovecot) inboxes, as the untouched originals, so it
looks like ordinary mail in plMail. No notification email, no Resend /
Mailjet relay, no per-message forwarding.

## How it works

The backup (Cloud Mail) and home (Dovecot + plMail) are kept as mirrors:

| What | Direction | How |
| --- | --- | --- |
| New inbound mail | backup → home INBOX | content pass, original bytes via `POST /inject` |
| Mail sent from the backup | backup → home **Sent** | sent pass, stored RFC 822 copy via `POST /append` |
| Read / delete / restore in the backup | backup → home | state pass via `POST /state` |
| Read / **un-read** / delete / **restore** in plMail | home → backup | watcher → this worker's `POST /state` |
| Mail sent from plMail | home Sent → backup sent list | watcher → this worker's `POST /import` (kind `send`) |
| Mail that reached home without the backup | home INBOX → backup inbox | watcher → `POST /import` (kind `receive`) |

Every message keeps one Message-ID on both sides and both sides skip a
Message-ID they already have, so nothing is ever delivered twice.

### Speed

- **Instant trigger.** The backup app wakes this worker the moment mail
  arrives or a user reads, deletes, restores or sends (service binding
  `sync` → the `SyncKick` RPC entrypoint, added by the main deploy
  workflow). The run starts ~1 s later; mail is home in seconds.
- **Cron every minute** is only a backstop. While home is down the worker
  re-checks every 30 s so mail moves as soon as home is back.
- The home watcher polls Dovecot every **10 s**, and its reports are
  applied to the backup immediately.

### One run at a time

All runs go through one Durable Object (`SyncRunner`, SQLite-backed, so
it works on the free plan). Cursors live in its storage. They used to
live in KV, which is eventually consistent and allows only 1,000 writes a
day on the free plan — a per-minute cron burned through that in hours,
and after that every run failed until midnight UTC. KV now only caches
the admin login token. Old KV cursors are read once and migrated.

### Safety rules

- A message still being saved in the backup is **waited for**, never
  skipped (before, two messages arriving together could make the cursor
  jump past one of them, and it never reached home).
- A message home rejects outright (too large, bad request) is retried 3
  times, then **parked** (left in the backup, shown in the summary) so it
  no longer blocks every message behind it. Home being down or erroring
  still stops the pass.
- State pushes only send states that are safe to repeat: `read: true`,
  `deleted: true`, and `restore: true` only for a restore made in the
  backup since the last pass — an old state can never undo something the
  user just did at home.
- An expired admin login (the backup answers HTTP 200 with code 401) now
  logs in again automatically.

### Endpoints

- `GET /sync` — run now and return the summary. Needs the token:
  `Authorization: Bearer <SYNC_TOKEN>` or `?token=`. `?last=1` returns
  the last run's summary without running.
- `POST /state`, `POST /import` — from the home watcher, `SYNC_TOKEN` in
  the body.

Not mirrored, by design: emptying Trash (permanent delete stays on the
side where it happened), and mail in folders other than INBOX / Trash /
Sent. If the backup's "sync delete" setting is on, deleting in the
backup erases the row outright and home is never told — leave it off.

## Alias sync

Home is the source of truth for aliases. At most once every 3 hours
(`last_alias_sync` in KV), the worker asks the home injection service
for each user's current aliases (`GET /aliases`, derived from
`HOME_INJECT_URL` by swapping `/inject` for `/aliases`) and adds any
missing ones to the owning Cloud Mail user via the admin-only
`POST /account/addForUser` endpoint. **Add-only**: addresses are never
removed. If home is down or the fetch fails, the alias sync is skipped
for that run and the last-known list stays in place; the mail sync is
never blocked or failed by it. The run summary carries an `aliasSync`
field (`{status, added, alreadyHad, failed, users}`).

Cloud Mail copies are **not** deleted after sync. That stays your call.

## Deploy

This worker is **not** deployed by `.github/workflows/deploy-cloudflare.yml`
(that workflow only covers `mail-worker/` and `mail-vue/`).

### Option A — GitHub Actions (recommended)

`.github/workflows/deploy-sync-worker.yml` deploys it. Manual run:
Actions → "Deploy cloud-mail sync worker" → Run workflow. It uses the
same `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` secrets as the
main deploy, finds or creates the `SYNC_KV` namespace (or uses
`SYNC_KV_ID` if you set it), fills in the vars, deploys, then sets the
worker secrets. Nothing secret is committed.

Add these first (repo Settings → Secrets and variables → Actions).
Secrets — values stay hidden:

| Secret | Value |
| --- | --- |
| `CLOUDMAIL_ADMIN_EMAIL` | `support@bearermail.com` (the Cloud Mail admin login) |
| `CLOUDMAIL_ADMIN_PASSWORD` | the Cloud Mail admin password |
| `SYNC_TOKEN` | same value as `MAIL_INJECT_TOKEN` in `../home-inject/mail-inject.env` |

Variables — plain values (a secret works too, the workflow accepts either):

| Variable | Value |
| --- | --- |
| `CLOUDMAIL_URL` | `https://backup.bearermail.com` (no trailing slash) |
| `HOME_HEALTH_URL` | `https://sync.bearermail.com/health` |
| `HOME_INJECT_URL` | `https://sync.bearermail.com/inject` |
| `USER_MAP` | JSON, e.g. `{"1": "support@bearermail.com", "2": "jett@bearermail.com"}` — find the user ids in Cloud Mail under Admin → Users |
| `SYNC_KV_ID` | (optional) id of an existing `SYNC_KV` namespace; the workflow creates one if this is unset |

### Option B — by hand from this directory:

```sh
cd sync-worker
npm install
npx wrangler kv namespace create SYNC_KV
```

Put the returned KV id into `wrangler.toml` (`[[kv_namespaces]] id`).

Set the secrets (never commit these):

```sh
npx wrangler secret put CLOUDMAIL_ADMIN_EMAIL
npx wrangler secret put CLOUDMAIL_ADMIN_PASSWORD
npx wrangler secret put SYNC_TOKEN
```

- `CLOUDMAIL_ADMIN_EMAIL` / `CLOUDMAIL_ADMIN_PASSWORD` — the Cloud Mail
  admin login. The worker logs in as admin to list all users' mail and to
  fetch originals. The JWT is cached in KV and re-fetched on a 401.
  Note: if Cloud Mail's **Login verification** setting is set to
  Turnstile-always, the worker login fails. Set it to Close (or Count)
  in Cloud Mail settings.
- `SYNC_TOKEN` — the shared secret the home injection endpoint checks.
  Must be identical to `MAIL_INJECT_TOKEN` in
  `../home-inject/mail-inject.env`. Generate one with:
  `openssl rand -hex 32`

Set the vars in `wrangler.toml`:

- `CLOUDMAIL_URL` — public URL of the deployed Cloud Mail app, e.g.
  `https://mail.bearermail.com` (no trailing slash).
- `HOME_HEALTH_URL` — e.g. `https://sync.bearermail.com/health`
- `HOME_INJECT_URL` — e.g. `https://sync.bearermail.com/inject`
- `USER_MAP` — JSON mapping Cloud Mail user ids to home inbox addresses,
  e.g. `{"1": "you@bearermail.com", "2": "friend@bearermail.com"}`.
  Find the user ids in Cloud Mail under Admin -> Users. A user with no
  entry here has their outage mail skipped (logged).

Then:

```sh
npx wrangler deploy
```

## Testing

- `GET https://<worker>/` returns a one-line status (worker is up).
- `GET https://<worker>/sync` runs one sync pass immediately and returns
  the summary as JSON (`{home, lastEmailId, listed, synced, skipped,
  failed, aliasSync}`), so you can force a pass without waiting for the
  cron.
- `npx wrangler tail` shows live logs, including per-message skip/fail
  reasons and alias-sync results.
- To force an alias sync by hand: delete the `last_alias_sync` key
  (`npx wrangler kv key delete --binding SYNC_KV last_alias_sync`) and
  hit `/sync` while home is up. The summary's `aliasSync` field shows
  what was added.
- To re-deliver a message by hand: delete its `synced:<id>` key and hit
  `/sync` while home is up (the cursor does not move backwards, so this
  only works for a message above the cursor — use a fresh test mail
  instead when in doubt).

