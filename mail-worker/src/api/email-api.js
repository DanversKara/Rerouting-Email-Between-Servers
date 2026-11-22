import app from '../hono/hono';
import emailService from '../service/email-service';
import r2Service from '../service/r2-service';
import result from '../model/result';
import userContext from '../security/user-context';
import attService from '../service/att-service';
import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';

// Merge-back: R2 key prefix for the untouched original message bytes.
// Keep in sync with the same value in email/email.js.
const RAW_PREFIX = 'raw/';

app.get('/email/list', async (c) => {
	const data = await emailService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.get('/email/latest', async (c) => {
	const list = await emailService.latest(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(list));
});

// Unified inbox: unread counts per account for the caller only, plus the
// total across all of the caller's accounts. Used for the count badges in
// the address list. Session-authenticated like /email/list; the counts are
// always scoped to the caller's own userId, never another user's mail.
app.get('/email/unreadCounts', async (c) => {
	const data = await emailService.unreadCounts(c, userContext.getUserId(c));
	return c.json(result.ok(data));
});

app.delete('/email/delete', async (c) => {
	await emailService.delete(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok());
});

app.get('/email/attList', async (c) => {
	const attList = await attService.list(c, c.req.query(), userContext.getUserId(c));
	return c.json(result.ok(attList));
});

app.post('/email/send', async (c) => {
	const email = await emailService.send(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok(email));
});

app.put('/email/read', async (c) => {
	await emailService.read(c, await c.req.json(), userContext.getUserId(c));
	return c.json(result.ok());
})

// Merge-back: return the untouched original message bytes stored at
// receive time, as message/rfc822. Own mail only; the admin (env.admin)
// may fetch any message. Used by the sync worker to push the original
// home when the home lab comes back.
app.get('/email/raw', async (c) => {
	const user = userContext.getUser(c);
	const emailId = Number(c.req.query().emailId);
	if (!emailId) {
		return c.notFound();
	}
	const row = await emailService.selectById(c, emailId);
	if (!row) {
		return c.notFound();
	}
	if (row.userId !== user.userId && user.email !== c.env.admin) {
		throw new BizError(t('unauthorized'), 403);
	}
	const resp = await r2Service.toObjResp(c, RAW_PREFIX + row.emailId + '.eml');
	if (!resp) {
		return c.notFound();
	}
	return resp;
})
