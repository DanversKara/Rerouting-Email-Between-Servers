// Wake the merge-back sync worker right away instead of waiting for its
// once-a-minute cron. Called after anything that home needs to hear
// about: new mail received, mail sent, read, deleted, restored.
//
// The sync worker is reached through a service binding named `sync`
// (an RPC entrypoint, SyncKick, so it is not reachable from the public
// internet). The binding is optional: when it is missing, or the call
// fails, nothing breaks — the cron still runs every minute as a
// backstop. Never awaited by the caller: it rides on waitUntil.
export function kickSync(env, ctx, reason) {
	const binding = env && env.sync;
	if (!binding || typeof binding.kick !== 'function') {
		return;
	}
	const task = Promise.resolve()
		.then(() => binding.kick(String(reason || '')))
		.catch(err => {
			console.warn('sync kick failed (cron will catch up):', err && err.message ? err.message : err);
		});
	if (ctx && typeof ctx.waitUntil === 'function') {
		ctx.waitUntil(task);
	} else {
		void task;
	}
}

// Same, from inside a Hono request.
export function kickSyncFromContext(c, reason) {
	let ctx = null;
	try {
		ctx = c.executionCtx;
	} catch (e) {
		ctx = null;
	}
	kickSync(c.env, ctx, reason);
}
