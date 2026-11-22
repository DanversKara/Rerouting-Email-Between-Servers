import app from './hono/webs';
import { email } from './email/email';
import userService from './service/user-service';
import verifyRecordService from './service/verify-record-service';
import emailService from './service/email-service';
import r2Service from './service/r2-service';
import oauthService from './service/oauth-service';
import analysisService from './service/analysis-service';
import { handleWsUpgrade } from './websocket/connect';
import proxyService from './service/proxy-service';
export { MailHub } from './websocket/hub'; // Durable Object 必须从 Worker 入口导出
// Mail originals live under raw/<emailId>.eml in object storage. Those keys
// are sequential integers, so anyone could enumerate them — the public
// object routes must never serve them.
function isRawMailKey(key) {
	let decoded = key;
	try {
		decoded = decodeURIComponent(key);
	} catch (e) {
		// Undecodable key: judge the raw form as-is.
	}
	return decoded === 'raw' || decoded.startsWith('raw/');
}

// Framing protection for responses the Worker serves directly (the SPA
// itself is covered by mail-vue/public/_headers via Static Assets).
function withFrameHeaders(resp) {
	const headers = new Headers(resp.headers);
	headers.set('X-Frame-Options', 'SAMEORIGIN');
	headers.set('Content-Security-Policy', "frame-ancestors 'self'");
	return new Response(resp.body, { status: resp.status, headers });
}

export default {
	 async fetch(req, env, ctx) {

		const url = new URL(req.url)

		// WebSocket：浏览器连 /realtime，转到 MailHub Durable Object
		if (url.pathname === '/realtime') {
			return handleWsUpgrade(req, env);
		}

		// 邮件图片代理：校验链接签名后，由 Worker 代拉外链图。
		if (url.pathname === '/proxy') {
			return proxyService.fetchImage(env, url.searchParams);
		}

		if (url.pathname.startsWith('/api/')) {
			url.pathname = url.pathname.replace('/api', '')
			req = new Request(url.toString(), req)
			return app.fetch(req, env, ctx);
		}

		if (url.pathname.startsWith('/oss/')) {
			const key = url.pathname.slice('/oss/'.length);
			// Raw mail originals are private: they are only served through
			// the authenticated /api/email/raw endpoint. Never serve them
			// from the public object routes, whatever key is requested.
			if (isRawMailKey(key)) {
				return new Response('Not Found', { status: 404 });
			}
			const resp = await r2Service.toObjResp({ env }, key);
			return resp ? withFrameHeaders(resp) : new Response('Not Found', { status: 404 });
		}

		 if (['/static/','/attachments/'].some(p => url.pathname.startsWith(p))) {
			 const resp = await r2Service.toObjResp({ env }, url.pathname.substring(1));
			 return resp ? withFrameHeaders(resp) : new Response('Not Found', { status: 404 });
		 }

		return env.assets.fetch(req);
	},
	email: email,
	async scheduled(c, env, ctx) {
		if (c.cron === '*/30 * * * *') {
			await analysisService.refreshEchartsCache({ env })
			return;
		}

		await verifyRecordService.clearRecord({ env })
		await userService.resetDaySendCount({ env })
		await emailService.completeReceiveAll({ env })
		await emailService.autoClean({ env })
		await analysisService.refreshEchartsCache({ env })
		await oauthService.clearNoBindOathUser({ env })
	},
};

