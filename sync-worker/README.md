# Cloud Mail merge-back sync worker

Pushes mail that Cloud Mail caught while the home lab was unreachable back
into the users' home (Dovecot) inboxes, as the untouched originals, so it
looks like ordinary mail in plMail. No notification email, no Resend /
Mailjet relay, no per-message forwarding.

## How it works

Every 5 minutes (cron) the worker fetches the home health URL:

- **Home down** (connection refused / timeout / non-2xx): records the
  outage start time in KV and does nothing else. Server-down and
  internet-down look identical from out here, and both are handled.
- **Home up, no outage recorded**: nothing to do.
- **Home up after an outage**: lists every received message in the outage
  window via the admin `/api/allEmail/list` endpoint, fetches each
  original via the new `/api/email/raw` endpoint, and POSTs it to the home
  injection endpoint (see `../home-inject/`). Each delivered message id is
  recorded in KV for 30 days, so a crash mid-sync can never deliver the
  same message twice. The outage window only closes once every listed
  message was synced or deliberately skipped; failures are retried on the
  next run.

Messages skipped on purpose (logged, not errors):

- `userId 0` — mail for an unknown recipient, stored with no owner. There
  is no home mailbox to deliver it to.
- No `USER_MAP` entry for the message's Cloud Mail user id.
- No stored original (message arrived before the raw-mail patch was
  deployed). The Cloud Mail copy is kept.

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
  the summary as JSON (`{home, outageSince, listed, synced, skipped,
  failed}`), so you can force a pass without waiting for the cron.
- `npx wrangler tail` shows live logs, including per-message skip/fail
  reasons.
- To re-run a past outage window by hand: delete the `home_down_since`
  key (`npx wrangler kv key delete --binding SYNC_KV home_down_since`)
  and hit `/sync` while home is up. Messages already marked
  `synced:<id>` are still skipped; delete a `synced:<id>` key to
  re-deliver that one message.

