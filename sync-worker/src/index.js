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
// Every run also refreshes the alias sync when it is due (see
// maybeSyncAliases): home is the source of truth for aliases, and the
// backup asks it for each user's current list so alias mail lands in
// its owning user's inbox. Add-only — addresses are never removed.
//
// State lives in the SYNC_KV namespace:
//   last_email_id    highest emailId fully processed (synced or deliberately
//                    skipped); the next run starts just above it
//   last_alias_sync  epoch ms of the last successful alias sync; the
//                    alias sync runs when this is missing or over 30m old
//   home_down_since  ISO timestamp of when home was last noticed down
//                    (observability only — it never gates syncing)
//   last_state_cursor  JSON {"updateTime","emailId"} — highest (update_time,
//                    email_id) whose read/delete state was pushed home;
//                    the state pass starts just above it
//   cloudmail_token  cached admin JWT for the Cloud Mail API
//   synced:<id>      "1" once a message was delivered home (30 day TTL,
//                    so a crash mid-sync can never deliver the same
//                    message twice)
//
// Cloud Mail copies are NOT deleted after sync; that stays the user's call.
//
// Two-way state sync (see runStatePass and handleStateReport): the
// backup and home inboxes keep the same read/unread and Trash state.
// Content still flows one way only, once, via the emailId cursor
// above — state updates never carry message content and never move
// mail out of Trash, so a delete at home can never make the backup
// re-send anything. Home-to-backup reports arrive as POST /state from
// the docker-host watcher and are forwarded to the backup with the
// cached admin JWT.

const KV_DOWN_SINCE = 'home_down_since';
const KV_LAST_ID = 'last_email_id';
const KV_STATE_CURSOR = 'last_state_cursor';
const KV_ALIAS_SYNC = 'last_alias_sync';
const ALIAS_SYNC_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
const KV_TOKEN = 'cloudmail_token';
const SYNCED_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MAX_PER_RUN = 200; // messages moved per cron run; the rest wait for the next run
const MAX_STATE_PER_RUN = 100; // state updates pushed home per run
const FETCH_TIMEOUT_MS = 10000;

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/sync') {
			const result = await runSync(env);
			return Response.json(result);
		}
		if (url.pathname === '/state' && request.method === 'POST') {
			return handleStateReport(env, request);
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

		const userMap = parseUserMap(env.USER_MAP);

		// Alias sync (at most once every 3 hours, add-only). It never
		// blocks or fails the mail sync: any failure here is logged and
		// the mail sync below runs exactly as before.
		try {
			summary.aliasSync = await maybeSyncAliases(env, userMap);
		} catch (e) {
			console.error('alias sync failed (mail sync continues):', e);
			summary.aliasSync = { status: 'error', detail: String(e && e.message ? e.message : e) };
		}

		const rows = await listMailSince(env, cursor);
		summary.listed = rows.length;
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

		// State pass: push read/delete changes made in the backup after
		// a message already synced home (or in the minutes before its
		// sync turn — home treats those as no-ops if the content pass
		// already carried the state). Independent of the content pass:
		// a content failure does not block state, and a state failure
		// never blocks content.
		try {
			summary.stateSync = await runStatePass(env, userMap);
		} catch (e) {
			console.error('state pass failed:', e);
			summary.stateSync = { status: 'error', detail: String(e && e.message ? e.message : e) };
		}
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
		headers: {
			'Content-Type': 'application/json',
			// Service token: lets the sync worker sign in as the admin
			// even when the admin has TOTP on. Long random value, set as
			// the SERVICE_TOKEN secret on both workers. Sent only here,
			// on the admin login — never on any other call.
			...(env.SERVICE_TOKEN ? { 'X-Service-Token': env.SERVICE_TOKEN } : {}),
		},
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


// Home aliases endpoint, derived from the inject URL:
// https://sync.bearermail.com/inject -> https://sync.bearermail.com/aliases
// (one fewer secret to keep in step; the inject URL always ends in /inject).
function aliasesUrl(env) {
	const injectUrl = (env.HOME_INJECT_URL || '').replace(/\/+$/, '');
	if (!injectUrl.endsWith('/inject')) {
		return null;
	}
	return injectUrl.slice(0, -'/inject'.length) + '/aliases';
}

// Sync home aliases into Cloud Mail, at most once every 30 minutes.
// Add-only: addresses are added to their owning user when missing and
// never removed. A failed fetch or a failed add never clears anything:
// the timestamp only advances when nothing failed, so the next run
// retries what is still missing. Returns a small status object for the
// run summary.
async function maybeSyncAliases(env, userMap) {
	const lastRaw = await env.SYNC_KV.get(KV_ALIAS_SYNC);
	const last = Number(lastRaw || '0') || 0;
	if (last && Date.now() - last < ALIAS_SYNC_INTERVAL_MS) {
		return { status: 'skipped', reason: 'synced within the last 30m' };
	}

	const url = aliasesUrl(env);
	if (!url) {
		console.error('alias sync skipped: HOME_INJECT_URL does not end in /inject, cannot derive the aliases URL');
		return { status: 'error', detail: 'cannot derive aliases URL from HOME_INJECT_URL' };
	}

	let res;
	try {
		res = await fetch(url, {
			method: 'GET',
			headers: { Authorization: `Bearer ${env.SYNC_TOKEN}` },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
	} catch (e) {
		console.error('alias sync skipped: aliases fetch failed:', e);
		return { status: 'error', detail: 'aliases fetch failed' };
	}
	if (!res.ok) {
		console.error(`alias sync skipped: aliases endpoint HTTP ${res.status}`);
		return { status: 'error', detail: `aliases endpoint HTTP ${res.status}` };
	}
	const data = await res.json().catch(() => null);
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		console.error('alias sync skipped: aliases endpoint returned invalid JSON');
		return { status: 'error', detail: 'invalid aliases response' };
	}

	// Invert USER_MAP (Cloud Mail userId -> home address) so each home
	// mailbox maps back to its Cloud Mail user.
	const homeToUser = {};
	for (const [userId, homeAddress] of Object.entries(userMap)) {
		if (typeof homeAddress === 'string' && homeAddress) {
			homeToUser[homeAddress.toLowerCase()] = userId;
		}
	}

	let added = 0;
	let alreadyHad = 0;
	let failed = 0;
	const usersSeen = new Set();

	for (const [mailbox, aliases] of Object.entries(data)) {
		if (!Array.isArray(aliases)) {
			continue;
		}
		const userId = homeToUser[String(mailbox).toLowerCase()];
		if (!userId) {
			console.log(`alias sync: no USER_MAP entry for home mailbox ${mailbox}, skipping its aliases`);
			continue;
		}
		// Current addresses for this user. /user/allAccount omits the
		// primary address, so the mailbox itself is added to the set
		// explicitly. Paginates: 30 rows a page.
		const existing = new Set([String(mailbox).toLowerCase()]);
		let listOk = true;
		let page = 1;
		for (;;) {
			const listRes = await cloudmailFetch(env, `/api/user/allAccount?userId=${encodeURIComponent(userId)}&num=${page}&size=30`, { method: 'GET' });
			const listBody = await listRes.json().catch(() => null);
			if (!listRes.ok || !listBody || listBody.code !== 200 || !listBody.data || !Array.isArray(listBody.data.list)) {
				console.error(`alias sync: could not list addresses for Cloud Mail user ${userId} (HTTP ${listRes.status})`);
				listOk = false;
				break;
			}
			for (const row of listBody.data.list) {
				if (row && typeof row.email === 'string') {
					existing.add(row.email.toLowerCase());
				}
			}
			if (listBody.data.list.length < 30) {
				break;
			}
			page++;
		}
		if (!listOk) {
			// Do not add blind for this user: the existing set may be
			// incomplete. The next run retries the whole user.
			failed++;
			continue;
		}
		usersSeen.add(userId);

		for (const alias of aliases) {
			if (typeof alias !== 'string' || !alias) {
				continue;
			}
			const address = alias.toLowerCase();
			if (existing.has(address)) {
				alreadyHad++;
				continue;
			}
			const addRes = await cloudmailFetch(env, '/api/account/addForUser', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ userId: Number(userId), email: address }),
			});
			if (addRes.ok) {
				existing.add(address);
				added++;
			} else {
				console.error(`alias sync: add ${address} to Cloud Mail user ${userId} failed (HTTP ${addRes.status})`);
				failed++;
			}
		}
	}

	// Only advance the timestamp when nothing failed, so a failed add is
	// retried on the next run instead of waiting 3 hours. Successful adds
	// are already in the user's address set, so the retry only re-tries
	// what is still missing.
	if (failed === 0) {
		await env.SYNC_KV.put(KV_ALIAS_SYNC, String(Date.now()));
	}
	return { status: failed === 0 ? 'ok' : 'partial', added, alreadyHad, failed, users: usersSeen.size };
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
		// Read/delete state at sync time: the home endpoint stores
		// read mail with \Seen and deleted mail in the Trash folder.
		// row.unread / row.isDel are in every full=1 list row.
		body: JSON.stringify({ token: env.SYNC_TOKEN, user: homeUser, rawMime, read: row.unread === 1, deleted: row.isDel === 1 }),
		signal: AbortSignal.timeout(60000),
	});
	if (!injectRes.ok) {
		console.error(`inject failed for emailId ${row.emailId} (HTTP ${injectRes.status})`);
		return 'failed';
	}

	await env.SYNC_KV.put(`synced:${row.emailId}`, '1', { expirationTtl: SYNCED_TTL_SECONDS });
	return 'synced';
}

// Home state endpoint, derived from the inject URL:
// https://sync.bearermail.com/inject -> https://sync.bearermail.com/state
// (one fewer secret to keep in step; the inject URL always ends in /inject).
function stateUrl(env) {
	const injectUrl = (env.HOME_INJECT_URL || '').replace(/\/+$/, '');
	if (!injectUrl.endsWith('/inject')) {
		return null;
	}
	return injectUrl.slice(0, -'/inject'.length) + '/state';
}

function parseStateCursor(raw) {
	try {
		const c = JSON.parse(raw || '');
		if (c && typeof c.updateTime === 'string' && typeof c.emailId === 'number') {
			return c;
		}
	} catch (e) {
		// Corrupt cursor: start the sweep over. It is idempotent —
		// home /state treats already-correct state as a no-op.
		console.error('state cursor corrupt, restarting sweep:', e);
	}
	return { updateTime: '0000-00-00 00:00:00', emailId: 0 };
}

// Rows whose read/delete state changed after the (updateTime, emailId)
// cursor, oldest change first, via the admin /email/stateList
// endpoint. 50 rows a page.
async function listStateSince(env, cursor) {
	const params = new URLSearchParams({
		updateTime: cursor.updateTime,
		emailId: String(cursor.emailId),
		size: '50',
	});
	const res = await cloudmailFetch(env, `/api/email/stateList?${params.toString()}`, { method: 'GET' });
	const body = await res.json().catch(() => null);
	if (!res.ok || !body || body.code !== 200 || !body.data || !Array.isArray(body.data.list)) {
		throw new Error(`email/stateList failed (HTTP ${res.status})`);
	}
	return body.data.list;
}

// Push post-sync read/delete state home. Lists rows whose updateTime
// moved after the state cursor, oldest change first, and POSTs each
// row's current state to home /state. The (updateTime, emailId) tuple
// cursor is exact even when many rows share one second. A row whose
// message is not home yet is skipped (home answers 200 skipped): the
// content pass carries the state when it delivers. A failed row stops
// the pass so the next run retries it. This pass NEVER sends message
// content and NEVER moves mail out of Trash — home /state can only set
// \Seen or move INBOX to Trash.
async function runStatePass(env, userMap) {
	const summary = { status: 'ok', listed: 0, pushed: 0, skipped: 0, failed: 0 };
	const url = stateUrl(env);
	if (!url) {
		return { status: 'error', detail: 'cannot derive state URL from HOME_INJECT_URL' };
	}
	let cursor = parseStateCursor(await env.SYNC_KV.get(KV_STATE_CURSOR));
	for (;;) {
		const page = await listStateSince(env, cursor);
		summary.listed += page.length;
		let failed = false;
		for (const row of page) {
			if (summary.pushed + summary.skipped + summary.failed >= MAX_STATE_PER_RUN) {
				break; // cap reached; the rest wait for the next run
			}
			if (!row.userId || !userMap[String(row.userId)]) {
				// Unowned or unmapped: nothing home can do with it.
				summary.skipped++;
				cursor = { updateTime: row.updateTime, emailId: row.emailId };
				continue;
			}
			if (!row.messageId) {
				// No Message-ID stored: home cannot match it. Skip it;
				// the content pass already carried the state if it
				// ever delivers.
				console.log(`state skip emailId ${row.emailId}: no stored Message-ID`);
				summary.skipped++;
				cursor = { updateTime: row.updateTime, emailId: row.emailId };
				continue;
			}
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					token: env.SYNC_TOKEN,
					user: userMap[String(row.userId)],
					messageId: row.messageId,
					read: row.unread === 1,
					deleted: row.isDel === 1,
				}),
				signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
			});
			if (!res.ok) {
				console.error(`state push failed for emailId ${row.emailId} (HTTP ${res.status})`);
				summary.failed++;
				failed = true;
				break;
			}
			summary.pushed++;
			cursor = { updateTime: row.updateTime, emailId: row.emailId };
		}
		await env.SYNC_KV.put(KV_STATE_CURSOR, JSON.stringify(cursor));
		if (failed || page.length < 50 || summary.pushed + summary.skipped + summary.failed >= MAX_STATE_PER_RUN) {
			break;
		}
	}
	if (summary.failed) {
		summary.status = 'partial';
	}
	return summary;
}

// Constant-time string compare (the sync worker has no shared crypto
// helper; this is the same shape as the TOTP service's compare).
function timingSafeEqual(a, b) {
	if (typeof a !== 'string' || typeof b !== 'string' || !a.length || a.length !== b.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

// Home-to-backup state reports, from the docker-host watcher. The
// caller proves itself with SYNC_TOKEN (the same value as
// MAIL_INJECT_TOKEN); the state is then applied to the backup with the
// cached admin JWT, exactly like the alias sync's addForUser calls.
// The watcher only ever reports read=true and deleted=true; nothing
// here can un-delete, restore, or re-send mail.
async function handleStateReport(env, request) {
	let body;
	try {
		body = await request.json();
	} catch (e) {
		return Response.json({ status: 'error', detail: 'invalid JSON' }, { status: 400 });
	}
	if (!env.SYNC_TOKEN || !timingSafeEqual(body && body.syncToken, env.SYNC_TOKEN)) {
		return Response.json({ status: 'error', detail: 'bad token' }, { status: 403 });
	}
	const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
	if (!messageId) {
		return Response.json({ status: 'error', detail: 'empty messageId' }, { status: 400 });
	}
	const payload = { messageId };
	if (typeof body.read === 'boolean') {
		payload.unread = body.read ? 1 : 0;
	}
	if (body.deleted === true) {
		payload.isDel = 1;
	}
	if (payload.unread === undefined && payload.isDel === undefined) {
		return Response.json({ status: 'skipped', detail: 'nothing to apply' });
	}
	const res = await cloudmailFetch(env, '/api/email/state', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const data = await res.json().catch(() => null);
	if (!res.ok || !data || data.code !== 200) {
		console.error(`state report forward failed for ${messageId} (HTTP ${res.status})`);
		return Response.json({ status: 'error', detail: `email/state HTTP ${res.status}` }, { status: 502 });
	}
	return Response.json(data.data || { status: 'ok' });
}
