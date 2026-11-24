// Cloud Mail merge-back sync worker.
//
// Cloudflare Email Routing is the front door for bearermail.com: ALL
// inbound mail lands in Cloud Mail (the backup) first, and this worker
// keeps the backup and the home lab (Dovecot + plMail) mirrored:
//
//   backup -> home   new inbound mail      -> home INBOX   (content pass)
//   backup -> home   mail sent from backup -> home Sent    (sent pass)
//   backup -> home   read / delete / restore made in the backup (state pass)
//   home -> backup   read / un-read / delete / restore made in plMail
//                    (POST /state, from home-inject/state-watch.py)
//   home -> backup   mail sent from plMail, or mail that reached home on
//                    its own -> backup Sent / inbox (POST /import)
//
// SPEED. Nothing waits for a timer when it does not have to:
//   - The backup app calls this worker the moment something changes
//     (mail received, sent, read, deleted, restored) through a service
//     binding to the SyncKick RPC entrypoint below. The run starts about
//     a second later, so mail is home in seconds.
//   - The once-a-minute cron is only the backstop (and the way an outage
//     is noticed to be over).
//   - Home -> backup reports arrive as they happen (the watcher polls
//     Dovecot every 10 seconds) and are applied immediately.
//
// ONE RUN AT A TIME. Every run goes through one Durable Object
// (SyncRunner), so two triggers can never run the same pass twice at
// once, and the cursors live in its strongly consistent storage. They
// used to live in KV, which is eventually consistent (a run could read a
// stale cursor and deliver a message twice) and, on the free plan,
// allows only 1,000 writes a day — a per-minute cron writing two or
// three keys every run exhausts that within hours, after which every
// run failed until midnight UTC. KV now only holds the cached admin
// login token (and the old cursors are read once, to migrate them).
//
// Content flows each way once, deduplicated by Message-ID on both
// sides; state updates never carry content.

import { DurableObject, WorkerEntrypoint } from 'cloudflare:workers';

const KV_TOKEN = 'cloudmail_token';

// Durable Object storage keys (the first four were KV keys before; their
// old KV values are read once when the DO storage has none).
const S_LAST_ID = 'last_email_id';
const S_STATE_CURSOR = 'last_state_cursor';
const S_ALIAS_SYNC = 'last_alias_sync';
const S_DOWN_SINCE = 'home_down_since';
const S_LAST_SENT_ID = 'last_sent_id';
const S_LAST_PRUNE = 'last_prune';
const S_LAST_SUMMARY = 'last_summary';
const P_SYNCED = 'synced:'; // + emailId -> epoch ms delivered home
const P_FAILS = 'fails:'; // + emailId -> count of permanent failures
const P_PARKED = 'parked:'; // + emailId -> {at, detail}

const ALIAS_SYNC_INTERVAL_MS = 30 * 60 * 1000;
const SYNCED_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_PER_RUN = 200; // messages moved per run; a full run re-arms at once
const MAX_STATE_PER_RUN = 200;
const PAGE = 100;
const FETCH_TIMEOUT_MS = 10000;
const INJECT_TIMEOUT_MS = 60000;
const KICK_DEBOUNCE_MS = 750; // batch e.g. "mark 40 read" into one run
const RETRY_WAITING_MS = 3000; // a message still being saved
const RETRY_FAILED_MS = 15000; // home answered with an error
const RETRY_DOWN_MS = 30000; // home unreachable
const SAVING_STUCK_MS = 2 * 60 * 60 * 1000; // the backup's hourly cron settles these
const RAW_GRACE_MS = 10 * 60 * 1000; // a just-saved message's original may lag
const PARK_AFTER = 3; // permanent failures before a message stops blocking
const STATE_HOLD_MAX_MS = 60 * 60 * 1000;

// ---------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------

function runner(env) {
	return env.RUNNER.get(env.RUNNER.idFromName('main'));
}

// RPC entrypoint for the backup app's service binding (`sync`). Not
// reachable from the internet: only Workers with a binding can call it.
export class SyncKick extends WorkerEntrypoint {
	async kick(reason) {
		await runner(this.env).kick(String(reason || 'kick'));
		return true;
	}
}

export class SyncRunner extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env);
		this.running = null;
	}

	// Ask for a run soon. Many kicks in a burst collapse into one run.
	async kick(reason) {
		const target = Date.now() + KICK_DEBOUNCE_MS;
		const current = await this.ctx.storage.getAlarm();
		if (current === null || current > target) {
			await this.ctx.storage.setAlarm(target);
		}
		return { scheduled: target, reason };
	}

	async alarm() {
		const summary = await this.runLocked();
		if (summary.nextRunMs) {
			const target = Date.now() + summary.nextRunMs;
			const current = await this.ctx.storage.getAlarm();
			if (current === null || current > target) {
				await this.ctx.storage.setAlarm(target);
			}
		}
	}

	// GET /sync: run now and return the summary.
	async runNow() {
		return this.runLocked();
	}

	async lastSummary() {
		return (await this.ctx.storage.get(S_LAST_SUMMARY)) || null;
	}

	async runLocked() {
		while (this.running) {
			await this.running.catch(() => {});
		}
		this.running = runSync(this.env, new Store(this.ctx.storage, this.env.SYNC_KV));
		try {
			const summary = await this.running;
			await this.ctx.storage.put(S_LAST_SUMMARY, { at: new Date().toISOString(), ...summary });
			return summary;
		} finally {
			this.running = null;
		}
	}
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url);
		if (url.pathname === '/sync') {
			// Running a sync is not secret, but it is not public either:
			// same SYNC_TOKEN as everything else, as a Bearer header or
			// ?token=.
			if (!requestHasToken(request, url, env)) {
				return Response.json({ status: 'error', detail: 'token required (Authorization: Bearer <SYNC_TOKEN> or ?token=)' }, { status: 403 });
			}
			if (url.searchParams.get('last') === '1') {
				return Response.json(await runner(env).lastSummary());
			}
			return Response.json(await runner(env).runNow());
		}
		if (url.pathname === '/state' && request.method === 'POST') {
			return handleStateReport(env, request);
		}
		if (url.pathname === '/import' && request.method === 'POST') {
			return handleImport(env, request);
		}
		return new Response('cloud-mail merge-back sync worker\n', { status: 200 });
	},

	// Backstop only: the backup app kicks a run the moment anything
	// changes. The cron also notices when home comes back.
	async scheduled(event, env, ctx) {
		ctx.waitUntil(runner(env).kick('cron'));
	},
};

// ---------------------------------------------------------------------
// Storage: DO storage, with a one-time read of the old KV value
// ---------------------------------------------------------------------

class Store {
	constructor(storage, kv) {
		this.storage = storage;
		this.kv = kv;
	}

	async get(key) {
		let value = await this.storage.get(key);
		if (value === undefined && this.kv) {
			const legacy = await this.kv.get(key).catch(() => null);
			if (legacy !== null && legacy !== undefined) {
				value = legacy;
				await this.storage.put(key, value);
			}
		}
		return value;
	}

	put(key, value) {
		return this.storage.put(key, value);
	}

	delete(key) {
		return this.storage.delete(key);
	}

	// Per-message markers: DO storage only (no KV fallback reads per
	// message — the old KV markers only guarded against KV's own
	// staleness, which DO storage does not have).
	getLocal(key) {
		return this.storage.get(key);
	}
}

// ---------------------------------------------------------------------
// One full pass
// ---------------------------------------------------------------------

async function runSync(env, store) {
	const summary = { home: 'unknown', content: null, sent: null, stateSync: null };
	let nextRunMs = 0;
	const want = (ms) => {
		if (ms && (!nextRunMs || ms < nextRunMs)) {
			nextRunMs = ms;
		}
	};
	try {
		const up = await isHomeUp(env);
		summary.home = up ? 'up' : 'down';
		if (!up) {
			if (!(await store.get(S_DOWN_SINCE))) {
				await store.put(S_DOWN_SINCE, new Date().toISOString());
			}
			summary.downSince = await store.get(S_DOWN_SINCE);
			// Everything waits for home; check again soon so mail moves
			// within ~30 s of home coming back (not only on the cron).
			want(RETRY_DOWN_MS);
			summary.nextRunMs = nextRunMs;
			return summary;
		}
		if (await store.get(S_DOWN_SINCE)) {
			await store.delete(S_DOWN_SINCE);
		}

		const userMap = parseUserMap(env.USER_MAP);

		try {
			summary.aliasSync = await maybeSyncAliases(env, store, userMap);
		} catch (e) {
			console.error('alias sync failed (mail sync continues):', e);
			summary.aliasSync = { status: 'error', detail: errText(e) };
		}

		try {
			summary.content = await runContentPass(env, store, userMap);
			want(summary.content.nextRunMs);
		} catch (e) {
			console.error('content pass failed:', e);
			summary.content = { status: 'error', detail: errText(e) };
			want(RETRY_FAILED_MS);
		}

		try {
			summary.sent = await runSentPass(env, store, userMap);
			want(summary.sent.nextRunMs);
		} catch (e) {
			console.error('sent pass failed:', e);
			summary.sent = { status: 'error', detail: errText(e) };
			want(RETRY_FAILED_MS);
		}

		// State after content, so a message delivered this run has its
		// home copy by the time its state is pushed.
		try {
			summary.stateSync = await runStatePass(env, store, userMap);
			want(summary.stateSync.nextRunMs);
		} catch (e) {
			console.error('state pass failed:', e);
			summary.stateSync = { status: 'error', detail: errText(e) };
			want(RETRY_FAILED_MS);
		}

		await maybePrune(store);
	} catch (e) {
		console.error('sync pass failed:', e);
		summary.error = errText(e);
		want(RETRY_FAILED_MS);
	}
	summary.nextRunMs = nextRunMs;
	return summary;
}

// Home counts as up only when the health endpoint answers 2xx.
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

// ---------------------------------------------------------------------
// Content pass: backup inbox -> home INBOX
// ---------------------------------------------------------------------

// Walks received rows above the cursor, oldest first. The cursor only
// moves past a row once that row is settled (delivered, or skipped for a
// reason that will never change). What is different from before:
//   - Rows still being saved (status SAVING) are visible now and the
//     pass WAITS for them. Previously they were invisible, so when two
//     messages arrived together the cursor could jump past the first
//     one and it never reached home.
//   - A missing original on a brand-new row means "not written yet",
//     not "arrived before the raw patch": wait, do not skip.
//   - A message home rejects outright (too big, bad request) no longer
//     blocks every message behind it forever: after PARK_AFTER tries it
//     is parked (left in the backup, listed in the summary) and the pass
//     moves on. Home being down or erroring (5xx) still stops the pass,
//     as it should — nothing behind it would get through either.
async function runContentPass(env, store, userMap) {
	const summary = { status: 'ok', cursor: 0, listed: 0, synced: 0, skipped: 0, parked: 0, waiting: 0, failed: 0, nextRunMs: 0 };
	let cursor = Number(await store.get(S_LAST_ID)) || 0;
	let done = 0;
	let stop = false;
	while (!stop && done < MAX_PER_RUN) {
		const page = await syncList(env, 'receive', cursor);
		summary.listed += page.list.length;
		if (!page.list.length) {
			break;
		}
		for (const row of page.list) {
			if (done >= MAX_PER_RUN) {
				summary.nextRunMs = 1000; // more to do: go again right away
				stop = true;
				break;
			}
			const outcome = await syncOne(env, store, row, userMap);
			if (outcome.result === 'synced' || outcome.result === 'skipped' || outcome.result === 'parked') {
				summary[outcome.result]++;
				cursor = row.emailId;
				done++;
				continue;
			}
			if (outcome.result === 'waiting') {
				summary.waiting++;
				summary.nextRunMs = RETRY_WAITING_MS;
			} else {
				summary.failed++;
				summary.status = 'partial';
				summary.detail = outcome.detail;
				summary.nextRunMs = RETRY_FAILED_MS;
			}
			stop = true;
			break;
		}
		if (page.list.length < PAGE) {
			break;
		}
	}
	await putIfChanged(store, S_LAST_ID, cursor);
	summary.cursor = cursor;
	return summary;
}

async function syncOne(env, store, row, userMap) {
	const ageMs = ageOf(row.createTime);
	if (row.status === STATUS_SAVING) {
		if (ageMs < SAVING_STUCK_MS) {
			return { result: 'waiting' };
		}
		console.log(`skip emailId ${row.emailId}: stuck in SAVING`);
		return { result: 'skipped' };
	}
	if (row.resendEmailId === HOME_IMPORT) {
		return { result: 'skipped' }; // came from home; home already has it
	}
	if (!row.userId) {
		return { result: 'skipped' }; // unknown recipient, no home mailbox
	}
	const homeUser = userMap[String(row.userId)];
	if (!homeUser) {
		console.log(`skip emailId ${row.emailId}: no USER_MAP entry for Cloud Mail user ${row.userId}`);
		return { result: 'skipped' };
	}
	if (await store.getLocal(P_SYNCED + row.emailId)) {
		return { result: 'skipped' };
	}

	const rawRes = await cloudmailFetch(env, `/api/email/raw?emailId=${row.emailId}`, { method: 'GET' });
	if (rawRes.status === 404) {
		if (ageMs < RAW_GRACE_MS) {
			return { result: 'waiting' };
		}
		console.log(`skip emailId ${row.emailId}: no stored original`);
		return { result: 'skipped' };
	}
	if (!rawRes.ok || isJson(rawRes)) {
		return { result: 'failed', detail: `fetch raw HTTP ${rawRes.status}${isJson(rawRes) ? ' (error envelope, not a message)' : ''}` };
	}
	const rawMime = await rawRes.text();
	if (!rawMime) {
		return { result: 'failed', detail: 'empty original' };
	}

	let injectRes;
	try {
		injectRes = await fetch(env.HOME_INJECT_URL, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				token: env.SYNC_TOKEN,
				user: homeUser,
				rawMime,
				read: row.unread === READ,
				deleted: row.isDel === DELETED,
			}),
			signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
		});
	} catch (e) {
		return { result: 'failed', detail: `inject: ${errText(e)}` };
	}
	if (injectRes.ok) {
		await store.put(P_SYNCED + row.emailId, Date.now());
		await store.delete(P_FAILS + row.emailId);
		return { result: 'synced' };
	}
	const detail = `inject HTTP ${injectRes.status}${await errDetail(injectRes)}`;
	if (isPermanent(injectRes.status)) {
		return park(store, row.emailId, detail);
	}
	return { result: 'failed', detail };
}

// 400/413/422: this message will never be accepted as it is. 403 is
// deliberately NOT permanent (a wrong token or allowlist is a config
// problem that blocks everything and must be fixed, not skipped past).
function isPermanent(status) {
	return status === 400 || status === 413 || status === 422;
}

async function park(store, emailId, detail) {
	const fails = (Number(await store.getLocal(P_FAILS + emailId)) || 0) + 1;
	if (fails < PARK_AFTER) {
		await store.put(P_FAILS + emailId, fails);
		return { result: 'failed', detail: `${detail} (try ${fails}/${PARK_AFTER})` };
	}
	console.error(`parked emailId ${emailId}: ${detail}`);
	await store.put(P_PARKED + emailId, { at: new Date().toISOString(), detail });
	await store.delete(P_FAILS + emailId);
	return { result: 'parked', detail };
}

// ---------------------------------------------------------------------
// Sent pass: mail sent from the backup -> home Sent folder
// ---------------------------------------------------------------------

// The backup now stores a full RFC 822 copy (with a Message-ID) of every
// message it sends. This pass files each one in the user's home Sent
// folder via POST /append, so mail written in the backup while home was
// down is in plMail's Sent afterwards. Starts at the newest sent message
// the first time it runs (older sent mail has no stored copy to carry).
// Home skips anything whose Message-ID is already in Sent or Trash.
async function runSentPass(env, store, userMap) {
	const summary = { status: 'ok', cursor: 0, listed: 0, filed: 0, skipped: 0, parked: 0, waiting: 0, failed: 0, nextRunMs: 0 };
	const appendUrl = siblingUrl(env, 'append');
	if (!appendUrl) {
		return { status: 'error', detail: 'cannot derive /append URL from HOME_INJECT_URL' };
	}
	let cursor = await store.get(S_LAST_SENT_ID);
	if (cursor === undefined || cursor === null) {
		const first = await syncList(env, 'send', 0, 1);
		cursor = first.maxEmailId || 0;
		await store.put(S_LAST_SENT_ID, cursor);
		summary.started = cursor;
	}
	cursor = Number(cursor) || 0;
	let done = 0;
	let stop = false;
	while (!stop && done < MAX_PER_RUN) {
		const page = await syncList(env, 'send', cursor);
		summary.listed += page.list.length;
		if (!page.list.length) {
			break;
		}
		for (const row of page.list) {
			if (done >= MAX_PER_RUN) {
				summary.nextRunMs = 1000;
				stop = true;
				break;
			}
			const outcome = await fileSentOne(env, store, row, userMap, appendUrl);
			if (outcome.result === 'filed' || outcome.result === 'skipped' || outcome.result === 'parked') {
				summary[outcome.result]++;
				cursor = row.emailId;
				done++;
				continue;
			}
			if (outcome.result === 'waiting') {
				summary.waiting++;
				summary.nextRunMs = RETRY_WAITING_MS;
			} else {
				summary.failed++;
				summary.status = 'partial';
				summary.detail = outcome.detail;
				summary.nextRunMs = RETRY_FAILED_MS;
			}
			stop = true;
			break;
		}
		if (page.list.length < PAGE) {
			break;
		}
	}
	await putIfChanged(store, S_LAST_SENT_ID, cursor);
	summary.cursor = cursor;
	return summary;
}

async function fileSentOne(env, store, row, userMap, appendUrl) {
	if (row.resendEmailId === HOME_IMPORT) {
		return { result: 'skipped' }; // written in plMail; already in home Sent
	}
	const homeUser = row.userId ? userMap[String(row.userId)] : null;
	if (!homeUser) {
		return { result: 'skipped' };
	}
	const rawRes = await cloudmailFetch(env, `/api/email/raw?emailId=${row.emailId}`, { method: 'GET' });
	if (rawRes.status === 404) {
		return ageOf(row.createTime) < RAW_GRACE_MS ? { result: 'waiting' } : { result: 'skipped' };
	}
	if (!rawRes.ok || isJson(rawRes)) {
		return { result: 'failed', detail: `fetch sent copy HTTP ${rawRes.status}` };
	}
	const rawMime = await rawRes.text();
	let res;
	try {
		res = await fetch(appendUrl, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ token: env.SYNC_TOKEN, user: homeUser, rawMime, folder: 'sent', read: true }),
			signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
		});
	} catch (e) {
		return { result: 'failed', detail: `append: ${errText(e)}` };
	}
	if (res.ok) {
		await store.delete(P_FAILS + row.emailId);
		return { result: 'filed' };
	}
	if (res.status === 404) {
		// Home's mail-inject is older than this worker (no /append yet).
		// Do not lose the place: hold here until it is updated.
		return { result: 'failed', detail: 'home has no /append yet — update home-inject/mail-inject.py' };
	}
	const detail = `append HTTP ${res.status}${await errDetail(res)}`;
	if (isPermanent(res.status)) {
		return park(store, row.emailId, detail);
	}
	return { result: 'failed', detail };
}

// ---------------------------------------------------------------------
// State pass: read / delete / restore made in the backup -> home
// ---------------------------------------------------------------------

// Lists rows whose updateTime moved past the (updateTime, emailId)
// cursor and pushes each row's CURRENT state home. Only states that are
// safe to push repeatedly are sent:
//   read     only `read: true` (the backup has no "mark unread"; an
//            unread row never un-reads the home copy, so a stale row
//            can never undo a read made at home)
//   deleted  `deleted: true` when the row is in the backup Trash
//   restore  `restore: true` only when the row was restored in the
//            backup SINCE the last pass (restoreTime), so an old
//            "not deleted" state can never pull a message home deleted
//            back out of Trash
// A row whose message is not home yet is held (see STATE_HOLD_MAX_MS)
// until the content pass settles it.
async function runStatePass(env, store, userMap) {
	const summary = { status: 'ok', listed: 0, pushed: 0, skipped: 0, held: 0, failed: 0, nextRunMs: 0 };
	const url = siblingUrl(env, 'state');
	if (!url) {
		return { status: 'error', detail: 'cannot derive state URL from HOME_INJECT_URL' };
	}
	const contentCursor = Number(await store.get(S_LAST_ID)) || 0;
	const startCursor = parseStateCursor(await store.get(S_STATE_CURSOR));
	let cursor = startCursor;
	let handled = 0;
	for (;;) {
		const page = await listStateSince(env, cursor);
		summary.listed += page.length;
		let stop = false;
		for (const row of page) {
			if (handled >= MAX_STATE_PER_RUN) {
				summary.nextRunMs = 1000;
				stop = true;
				break;
			}
			const homeUser = row.userId ? userMap[String(row.userId)] : null;
			if (!homeUser || !row.messageId) {
				summary.skipped++;
				cursor = { updateTime: row.updateTime, emailId: row.emailId };
				handled++;
				continue;
			}
			const body = { token: env.SYNC_TOKEN, user: homeUser, messageId: row.messageId };
			if (row.unread === READ) {
				body.read = true;
			}
			if (row.isDel === DELETED) {
				body.deleted = true;
			} else if (row.restoreTime && row.restoreTime > startCursor.updateTime) {
				body.restore = true;
			}
			if (!body.read && !body.deleted && !body.restore) {
				// Unread and not deleted: nothing home needs to change.
				summary.skipped++;
				cursor = { updateTime: row.updateTime, emailId: row.emailId };
				handled++;
				continue;
			}
			let res;
			try {
				res = await fetch(url, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify(body),
					signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
				});
			} catch (e) {
				res = null;
			}
			if (!res || !res.ok) {
				console.error(`state push failed for emailId ${row.emailId} (${res ? 'HTTP ' + res.status : 'network'})`);
				summary.failed++;
				summary.status = 'partial';
				summary.nextRunMs = RETRY_FAILED_MS;
				stop = true;
				break;
			}
			const data = await res.json().catch(() => null);
			const homeStatus = data && typeof data.status === 'string' ? data.status : 'ok';
			if (homeStatus !== 'skipped') {
				summary.pushed++;
				cursor = { updateTime: row.updateTime, emailId: row.emailId };
				handled++;
				continue;
			}
			// Not at home (yet). Hold unless the content pass has settled
			// this message or the row is old enough to be stuck for good.
			const delivered = await store.getLocal(P_SYNCED + row.emailId);
			const rowAgeMs = ageOf(row.updateTime);
			const settled = !!delivered || row.emailId <= contentCursor || !(rowAgeMs >= 0 && rowAgeMs < STATE_HOLD_MAX_MS);
			if (settled) {
				summary.skipped++;
				cursor = { updateTime: row.updateTime, emailId: row.emailId };
				handled++;
				continue;
			}
			summary.held++;
			summary.nextRunMs = RETRY_WAITING_MS;
			stop = true;
			break;
		}
		if (stop || page.length < 50) {
			break;
		}
	}
	if (cursor.updateTime !== startCursor.updateTime || cursor.emailId !== startCursor.emailId) {
		await store.put(S_STATE_CURSOR, JSON.stringify(cursor));
	}
	return summary;
}

function parseStateCursor(raw) {
	try {
		const c = typeof raw === 'string' ? JSON.parse(raw || '') : raw;
		if (c && typeof c.updateTime === 'string' && typeof c.emailId === 'number') {
			return c;
		}
	} catch (e) {
		console.error('state cursor corrupt, restarting sweep:', e);
	}
	return { updateTime: '0000-00-00 00:00:00', emailId: 0 };
}

async function listStateSince(env, cursor) {
	const params = new URLSearchParams({ updateTime: cursor.updateTime, emailId: String(cursor.emailId), size: '50' });
	const res = await cloudmailFetch(env, `/api/email/stateList?${params.toString()}`, { method: 'GET' });
	const body = await res.json().catch(() => null);
	if (!res.ok || !body || body.code !== 200 || !body.data || !Array.isArray(body.data.list)) {
		throw new Error(`email/stateList failed (HTTP ${res.status})`);
	}
	return body.data.list;
}

// ---------------------------------------------------------------------
// Home -> backup
// ---------------------------------------------------------------------

// POST /state from the docker-host watcher: a read, un-read, move to
// Trash or restore out of Trash made at home. Applied to the backup
// right away with the cached admin JWT.
async function handleStateReport(env, request) {
	let body;
	try {
		body = await request.json();
	} catch (e) {
		return Response.json({ status: 'error', detail: 'invalid JSON' }, { status: 400 });
	}
	if (!bodyHasToken(body, env)) {
		return Response.json({ status: 'error', detail: 'bad token (sync-worker /state)' }, { status: 403 });
	}
	const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
	if (!messageId) {
		return Response.json({ status: 'error', detail: 'empty messageId' }, { status: 400 });
	}
	const payload = { messageId };
	const userId = homeUserToId(env, body.user);
	if (userId) {
		payload.userId = Number(userId);
	}
	if (typeof body.read === 'boolean') {
		payload.unread = body.read ? READ : UNREAD;
	}
	if (body.deleted === true) {
		payload.isDel = DELETED;
	} else if (body.restored === true || body.deleted === false) {
		payload.isDel = NOT_DELETED;
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

// POST /import from the watcher: a message in a home folder the backup
// may not have — kind 'send' (Sent, written in plMail) or 'receive'
// (INBOX, reached home without passing through the backup). First call
// without rawMime asks whether the backup already has it ('exists') or
// needs it ('need_raw'); the second call carries the message.
async function handleImport(env, request) {
	let body;
	try {
		body = await request.json();
	} catch (e) {
		return Response.json({ status: 'error', detail: 'invalid JSON' }, { status: 400 });
	}
	if (!bodyHasToken(body, env)) {
		return Response.json({ status: 'error', detail: 'bad token (sync-worker /import)' }, { status: 403 });
	}
	const userId = homeUserToId(env, body.user);
	if (!userId) {
		return Response.json({ status: 'skipped', detail: 'no USER_MAP entry for this home user' });
	}
	const messageId = typeof body.messageId === 'string' ? body.messageId.trim() : '';
	if (!messageId) {
		return Response.json({ status: 'skipped', detail: 'empty messageId' });
	}
	const payload = {
		userId: Number(userId),
		kind: body.kind === 'send' ? 'send' : 'receive',
		messageId,
		read: body.read === true,
	};
	if (typeof body.rawMime === 'string' && body.rawMime) {
		payload.rawMime = body.rawMime;
	}
	const res = await cloudmailFetch(env, '/api/email/import', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(payload),
	});
	const data = await res.json().catch(() => null);
	if (!res.ok || !data || data.code !== 200) {
		return Response.json({ status: 'error', detail: `email/import HTTP ${res.status}${data && data.message ? ': ' + data.message : ''}` }, { status: 502 });
	}
	return Response.json(data.data || { status: 'ok' });
}

// ---------------------------------------------------------------------
// Alias sync (home is the source of truth; add-only)
// ---------------------------------------------------------------------

async function maybeSyncAliases(env, store, userMap) {
	const last = Number(await store.get(S_ALIAS_SYNC)) || 0;
	if (last && Date.now() - last < ALIAS_SYNC_INTERVAL_MS) {
		return { status: 'skipped', reason: 'synced within the last 30m' };
	}
	const url = siblingUrl(env, 'aliases');
	if (!url) {
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
		return { status: 'error', detail: 'aliases fetch failed' };
	}
	if (!res.ok) {
		return { status: 'error', detail: `aliases endpoint HTTP ${res.status}` };
	}
	const data = await res.json().catch(() => null);
	if (!data || typeof data !== 'object' || Array.isArray(data)) {
		return { status: 'error', detail: 'invalid aliases response' };
	}
	const homeToUser = invertUserMap(userMap);
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
			continue;
		}
		const existing = new Set([String(mailbox).toLowerCase()]);
		let listOk = true;
		for (let page = 1; ; page++) {
			const listRes = await cloudmailFetch(env, `/api/user/allAccount?userId=${encodeURIComponent(userId)}&num=${page}&size=30`, { method: 'GET' });
			const listBody = await listRes.json().catch(() => null);
			if (!listRes.ok || !listBody || listBody.code !== 200 || !listBody.data || !Array.isArray(listBody.data.list)) {
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
		}
		if (!listOk) {
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
				failed++;
			}
		}
	}
	if (failed === 0) {
		await store.put(S_ALIAS_SYNC, String(Date.now()));
	}
	return { status: failed === 0 ? 'ok' : 'partial', added, alreadyHad, failed, users: usersSeen.size };
}

// ---------------------------------------------------------------------
// Housekeeping
// ---------------------------------------------------------------------

// Delivered-markers older than 30 days are dropped once a day.
async function maybePrune(store) {
	const last = Number(await store.getLocal(S_LAST_PRUNE)) || 0;
	if (Date.now() - last < PRUNE_INTERVAL_MS) {
		return;
	}
	const cutoff = Date.now() - SYNCED_KEEP_MS;
	const markers = await store.storage.list({ prefix: P_SYNCED, limit: 2000 });
	const old = [];
	for (const [key, at] of markers) {
		if (Number(at) < cutoff) {
			old.push(key);
		}
	}
	for (let i = 0; i < old.length; i += 128) {
		await store.storage.delete(old.slice(i, i + 128));
	}
	await store.put(S_LAST_PRUNE, Date.now());
}

async function putIfChanged(store, key, value) {
	const current = await store.getLocal(key);
	if (current !== value) {
		await store.put(key, value);
	}
}

// ---------------------------------------------------------------------
// Cloud Mail API
// ---------------------------------------------------------------------

const STATUS_SAVING = 6;
const READ = 1;
const UNREAD = 0;
const DELETED = 1;
const NOT_DELETED = 0;
const HOME_IMPORT = 'home-import';

async function syncList(env, type, afterId, size) {
	const params = new URLSearchParams({ type, afterId: String(afterId), size: String(size || PAGE) });
	const res = await cloudmailFetch(env, `/api/email/syncList?${params.toString()}`, { method: 'GET' });
	const body = await res.json().catch(() => null);
	if (!res.ok || !body || body.code !== 200 || !body.data || !Array.isArray(body.data.list)) {
		throw new Error(`email/syncList failed (HTTP ${res.status}${body && body.message ? ': ' + body.message : ''}) — is the backup app deployed with this version?`);
	}
	return body.data;
}

async function login(env) {
	const res = await fetch(cloudmailUrl(env, '/api/login'), {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(env.SERVICE_TOKEN ? { 'X-Service-Token': env.SERVICE_TOKEN } : {}),
		},
		body: JSON.stringify({ email: env.CLOUDMAIL_ADMIN_EMAIL, password: env.CLOUDMAIL_ADMIN_PASSWORD }),
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
	return cached || login(env);
}

// One authenticated Cloud Mail API call; a 401 logs in again once.
// The backup answers some auth failures as HTTP 200 with code 401 in the
// body, so both are treated as "log in again".
async function cloudmailFetch(env, path, init) {
	const call = (token) => fetch(cloudmailUrl(env, path), {
		...init,
		headers: { ...(init && init.headers ? init.headers : {}), Authorization: token },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS * 3),
	});
	let res = await call(await getToken(env));
	if (res.status === 401 || await bodySaysUnauthorized(res)) {
		await env.SYNC_KV.delete(KV_TOKEN).catch(() => {});
		res = await call(await login(env));
	}
	return res;
}

async function bodySaysUnauthorized(res) {
	const type = res.headers.get('content-type') || '';
	if (!res.ok || !type.includes('application/json')) {
		return false;
	}
	const body = await res.clone().json().catch(() => null);
	return !!(body && body.code === 401);
}

// ---------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------

function cloudmailUrl(env, path) {
	return env.CLOUDMAIL_URL.replace(/\/+$/, '') + path;
}

// https://sync.bearermail.com/inject -> https://sync.bearermail.com/<name>
function siblingUrl(env, name) {
	const injectUrl = (env.HOME_INJECT_URL || '').replace(/\/+$/, '');
	if (!injectUrl.endsWith('/inject')) {
		return null;
	}
	return injectUrl.slice(0, -'/inject'.length) + '/' + name;
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

function invertUserMap(userMap) {
	const out = {};
	for (const [userId, homeAddress] of Object.entries(userMap)) {
		if (typeof homeAddress === 'string' && homeAddress) {
			out[homeAddress.toLowerCase()] = userId;
		}
	}
	return out;
}

function homeUserToId(env, user) {
	if (typeof user !== 'string' || !user) {
		return null;
	}
	return invertUserMap(parseUserMap(env.USER_MAP))[user.trim().toLowerCase()] || null;
}

// Backup timestamps are either SQLite 'YYYY-MM-DD HH:MM:SS' (UTC) or ISO.
function ageOf(stamp) {
	if (!stamp) {
		return Infinity;
	}
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(stamp) ? stamp.replace(' ', 'T') + 'Z' : stamp;
	const t = Date.parse(iso);
	return isNaN(t) ? Infinity : Date.now() - t;
}

// The backup answers errors as HTTP 200 + a JSON {code, message}
// envelope; a stored original is never JSON.
function isJson(res) {
	return (res.headers.get('content-type') || '').includes('application/json');
}

function errText(e) {
	return String(e && e.message ? e.message : e);
}

async function errDetail(res) {
	const data = await res.json().catch(() => null);
	return data && data.detail ? ` (${data.detail})` : '';
}

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

function bodyHasToken(body, env) {
	const presented = body && (body.syncToken || body.token);
	return !!env.SYNC_TOKEN && timingSafeEqual(presented, env.SYNC_TOKEN);
}

function requestHasToken(request, url, env) {
	const auth = request.headers.get('Authorization') || '';
	const presented = auth.startsWith('Bearer ') ? auth.slice(7).trim() : (url.searchParams.get('token') || '');
	return !!env.SYNC_TOKEN && timingSafeEqual(presented, env.SYNC_TOKEN);
}
