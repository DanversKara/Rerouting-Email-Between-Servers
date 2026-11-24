# Cloud Mail merge-back sync worker

Pushes mail that Cloud Mail caught while the home lab was unreachable back
into the users' home (Dovecot) inboxes, as the untouched originals, so it
looks like ordinary mail in plMail. No notification email, no Resend /
Mailjet relay, no per-message forwarding.

## How it works

Every 5 minutes (cron) — and on a manual `GET /sync` — the worker
checks the home health URL, then, while home is up, lists every received
message newer than the last one it processed via the admin
`/api/allEmail/list` endpoint, fetches each original via the
`/api/email/raw` endpoint, and POSTs it to the home injection endpoint
(see `../home-inject/`). Each delivered message id is recorded in KV for
30 days, so a crash mid-sync can never deliver the same message twice.
Failures stop that run at the failed message and are retried on the next
run. Server-down and internet-down look identical from out here, and both
are handled: while home is down nothing advances and the outage start
time is recorded in KV for observability only.

Read/unread and Trash state travel with the mail: each list row already
carries `unread` and `isDel`, so the inject POST includes
`read`/`deleted` and home stores read mail with `\Seen` and deleted
mail in the Trash folder. See "State sync" below.

Messages skipped on purpose (logged, not errors):

- `userId 0` — mail for an unknown recipient that the worker could not
  place (the noRecipient OPEN limbo case). Unknown mail normally routes
  to the admin inbox now and syncs home like admin mail.
- No `USER_MAP` entry for the message's Cloud Mail user id.
- No stored original (message arrived before the raw-mail patch was
  deployed). The Cloud Mail copy is kept.

## State sync (two-way read/delete)

The backup and home inboxes keep the same read/unread and Trash state,
in three parts. **Content still flows one way only, once, via the
`last_email_id` cursor** — state updates never carry message content
and never move mail out of Trash, so a delete at home can never make
the backup re-send anything.

- **At sync time.** The inject POST carries `read`/`deleted` (see
  above); home stores the message accordingly.
- **Backup → home, after sync.** A second pass each run lists rows
  whose `update_time` moved after the `last_state_cursor`
  (`(update_time, email_id)` tuple, so rows sharing one second are
  never skipped) via the admin `GET /api/email/stateList` endpoint,
  and POSTs each row's current state to home `POST /state`. A message
  not home yet is skipped (200 skipped) — the content pass carries
  the state when it delivers. At most 100 state updates per run.
  The run summary carries a `stateSync` field
  (`{status, listed, pushed, skipped, failed}`).
- **Home → backup.** The docker-host watcher (`../home-inject/
  state-watch.py`) polls Dovecot and POSTs only read-gained and
  moved-to-Trash transitions to this worker's `POST /state`
  (authenticated with `SYNC_TOKEN`, constant-time compare). The
  worker forwards them to the backup's admin-only
  `POST /api/email/state` with the cached admin JWT.

Limits, by design: restoring a mail from Trash does not mirror to
the other side, and permanently emptying home Trash leaves the
backup Trash copy as the last copy.

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

