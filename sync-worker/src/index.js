// Cloud Mail merge-back sync worker.
//
// Cloudflare Email Routing is the front door for bearermail.com: ALL
// inbound mail lands in Cloud Mail first, and this worker carries it home
// into Dovecot continuously, so it shows up as ordinary mail in plMail.
// Every 5 minutes (cron) — and on a manual GET /sync — it lists every
// received message newer than the last one it processed, fetches the
// untouched original for each one, and hands it to the home injection
// endpoint, which drops it into the right user's inbox.
//
// No Resend, no Mailjet, no SMTP relay anywhere here: the handoff is a
// plain HTTPS POST from this worker to the home endpoint, and delivery home
// is local (sendmail) on the home host, so there is no per-message cap to
// burn through.
//
// State lives in the SYNC_KV namespace:
//   last_email_id    highest emailId fully processed (synced or deliberately
//                    skipped); the next run starts just above it
//   home_down_since  ISO timestamp of when home was last noticed down
//                    (observability only — it never gates syncing)
//   cloudmail_token  cached admin JWT for the Cloud Mail API
//   synced:<id>      "1" once a message was delivered home (30 day TTL,
//                    so a crash mid-sync can never deliver the same
//                    message twice)
//
// Cloud Mail copies are NOT deleted after sync; that stays the user's call.

const KV_DOWN_SINCE = 'home_down_since';
const KV_LAST_ID = 'last_email_id';
const KV_TOKEN = 'cloudmail_token';
const SYNCED_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_PER_RUN = 200; // messages moved per cron run; the rest wait for the next run
const FETCH_TIMEOUT_MS = 10000;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/sync') {
			const result = await runSync(env);
			return Response.json(result);
		}
		return new Response('cloud-mail merge-back sync worker\n', { status: 200 });
	},

	async scheduled(event, env, ctx) {
		ctx.waitUntil(runSync(env));
	},
};

// One full check-and-sync pass. Returns a summary object (also logged).
async function runSync(env) {
	const summary = { home: 'unknown', lastEmailId: 0, listed: 0, synced: 0, skipped: 0, failed: 0 };
	try {
		const up = await isHomeUp(env);
		summary.home = up ? 'up' : 'down';

		// The cursor is the highest emailId fully processed (synced or
		// deliberately skipped). It only ever moves forward.
		let cursor = Number(await env.SYNC_KV.get(KV_LAST_ID) || '0') || 0;
		summary.lastEmailId = cursor;

		if (!up) {
			// Record when the outage was first noticed, for observability
			// only. It no longer gates syncing: every run syncs everything
			// above the cursor while home is up, outage or not.
			const existing = await env.SYNC_KV.get(KV_DOWN_SINCE);
			if (!existing) {
				await env.SYNC_KV.put(KV_DOWN_SINCE, new Date().toISOString());
			}
			return summary;
		}

		// Home is up: a stale down marker, if any, is no longer meaningful.
		await env.SYNC_KV.delete(KV_DOWN_SINCE);

		const rows = await listMailSince(env, cursor);
		summary.listed = rows.length;

		const userMap = parseUserMap(env.USER_MAP);
		let failed = 0;

		for (const row of rows) {
			if (summary.synced + summary.skipped + failed >= MAX_PER_RUN) {
				break; // leave the rest for the next run; the cursor stays where it is
			}
			const outcome = await syncOne(env, row, userMap);
			if (outcome === 'synced') {
				summary.synced++;
				cursor = row.emailId;
			} else if (outcome === 'skipped') {
				summary.skipped++;
				cursor = row.emailId;
			} else {
				// Failed: stop here, do not advance past this row and do
				// not process further rows this run, so the next run
				// retries it from the same cursor.
				failed++;
				break;
			}
		}
		summary.failed = failed;

		// Persist the cursor even when nothing was listed; the value is
		// unchanged in that case.
		await env.SYNC_KV.put(KV_LAST_ID, String(cursor));
		summary.lastEmailId = cursor;
		return summary;
	} catch (e) {
		console.error('sync pass failed:', e);
		summary.error = String(e && e.message ? e.message : e);
		return summary;
	}
}

// Home counts as up only when the health endpoint answers 2xx. A refused
// connection (server down, internet down, tunnel down) throws, and a 5xx
// from a half-broken home side counts as down too, so we never push mail
// into an endpoint that is not ready to take it.
async function isHomeUp(env) {
	try {
		const res = await fetch(env.HOME_HEALTH_URL, {
			method: 'GET',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		return res.ok;
	} catch (e) {
		return false;
	}
}

function parseUserMap(raw) {
	try {
		const map = JSON.parse(raw || '{}');
		return map && typeof map === 'object' ? map : {};
	} catch (e) {
		console.error('USER_MAP is not valid JSON:', e);
		return {};
	}
}

function cloudmailUrl(env, path) {
	return env.CLOUDMAIL_URL.replace(/\/+$/, '') + path;
}

// Log in as the admin user and cache the JWT in KV. The token is good for
// 30 days; a 401 anywhere below clears the cache and logs in again once.
async function login(env) {
	const res = await fetch(cloudmailUrl(env, '/api/login'), {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			email: env.CLOUDMAIL_ADMIN_EMAIL,
			password: env.CLOUDMAIL_ADMIN_PASSWORD,
		}),
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	const body = await res.json().catch(() => null);
	if (!res.ok || !body || body.code !== 200 || !body.data || !body.data.token) {
		throw new Error(`cloud-mail login failed (HTTP ${res.status})`);
	}
	await env.SYNC_KV.put(KV_TOKEN, body.data.token);
	return body.data.token;
}

async function getToken(env) {
	const cached = await env.SYNC_KV.get(KV_TOKEN);
	if (cached) {
		return cached;
	}
	return login(env);
}

// One authenticated Cloud Mail API call. On a 401 the cached token is
// thrown away, a fresh login happens, and the call is retried once.
async function cloudmailFetch(env, path, init) {
	let token = await getToken(env);
	let res = await fetch(cloudmailUrl(env, path), {
		...init,
		headers: { ...(init && init.headers ? init.headers : {}), Authorization: token },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	});
	if (res.status === 401) {
		await env.SYNC_KV.delete(KV_TOKEN);
		token = await login(env);
		res = await fetch(cloudmailUrl(env, path), {
			...init,
			headers: { ...(init && init.headers ? init.headers : {}), Authorization: token },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	}
	return res;
}

// All received mail above the cursor, oldest first, via the admin
// /allEmail/list endpoint (the per-user /email/list only ever returns the
// caller's own mail). Paginates with the emailId cursor, 50 rows a page.
// No date window: with Email Routing as the front door, mail arrives
// continuously while home is up, so every run syncs everything newer than
// the last processed emailId. startDate/endDate are optional in
// emailService.allList (they only add a filter when present), so they are
// omitted here.
async function listMailSince(env, cursor) {
	const rows = [];
	let pageCursor = cursor;
	for (;;) {
		const params = new URLSearchParams({
			type: 'receive',
			timeSort: '1',
			size: '50',
			// full=1: the brief columns omit userId/accountId, and the sync
			// needs userId to map each message to a home inbox.
			full: '1',
			emailId: String(pageCursor),
		});
		const res = await cloudmailFetch(env, `/api/allEmail/list?${params.toString()}`, { method: 'GET' });
		const body = await res.json().catch(() => null);
		if (!res.ok || !body || body.code !== 200 || !body.data || !Array.isArray(body.data.list)) {
			throw new Error(`allEmail/list failed (HTTP ${res.status})`);
		}
		const page = body.data.list;
		rows.push(...page);
		if (page.length < 50) {
			break;
		}
		pageCursor = page[page.length - 1].emailId;
		if (rows.length >= 5000) {
			break; // safety valve; the next run picks up where this one stopped
		}
	}
	return rows;
}

// Move one message home. Returns 'synced', 'skipped' or 'failed'.
async function syncOne(env, row, userMap) {
	// Unowned mail (unknown recipient, stored with userId 0) has no home
	// mailbox to deliver to; leave it in Cloud Mail and log it.
	if (!row.userId) {
		console.log(`skip emailId ${row.emailId}: no owner (userId 0)`);
		return 'skipped';
	}
	const homeUser = userMap[String(row.userId)];
	if (!homeUser) {
		console.log(`skip emailId ${row.emailId}: no USER_MAP entry for Cloud Mail user ${row.userId}`);
		return 'skipped';
	}
	if (await env.SYNC_KV.get(`synced:${row.emailId}`)) {
		return 'skipped'; // already delivered home on an earlier run
	}

	// Fetch the untouched original bytes stored at receive time.
	const rawRes = await cloudmailFetch(env, `/api/email/raw?emailId=${row.emailId}`, { method: 'GET' });
	if (rawRes.status === 404) {
		// The message arrived before the raw-mail patch was deployed, so no
		// original was ever stored. Nothing to push; keep the Cloud Mail copy.
		console.log(`skip emailId ${row.emailId}: no stored original (arrived before the raw patch)`);
		return 'skipped';
	}
	if (!rawRes.ok) {
		console.error(`fetch raw failed for emailId ${row.emailId} (HTTP ${rawRes.status})`);
		return 'failed';
	}
	const rawMime = await rawRes.text();
	if (!rawMime) {
		console.error(`fetch raw returned empty body for emailId ${row.emailId}`);
		return 'failed';
	}

	const injectRes = await fetch(env.HOME_INJECT_URL, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token: env.SYNC_TOKEN, user: homeUser, rawMime }),
		signal: AbortSignal.timeout(60000),
	});
	if (!injectRes.ok) {
		console.error(`inject failed for emailId ${row.emailId} (HTTP ${injectRes.status})`);
		return 'failed';
	}

	await env.SYNC_KV.put(`synced:${row.emailId}`, '1', { expirationTtl: SYNCED_TTL_SECONDS });
	return 'synced';
}
