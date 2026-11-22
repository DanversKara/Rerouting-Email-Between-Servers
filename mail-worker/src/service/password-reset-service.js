import BizError from '../error/biz-error';
import { t } from '../i18n/i18n';
import { Resend } from 'resend';
import userService from './user-service';
import settingService from './setting-service';
import verifyRecordService from './verify-record-service';
import verifyUtils from '../utils/verify-utils';
import emailUtils from '../utils/email-utils';
import saltHashUtils from '../utils/crypto-utils';
import orm from '../entity/orm';
import user from '../entity/user';
import { eq } from 'drizzle-orm';
import KvConst from '../const/kv-const';
import { isDel, userConst } from '../const/entity-const';

const TOKEN_TTL_SECONDS = 30 * 60; // Reset links live 30 minutes, then die.
const RESET_DAILY_LIMIT = 5; // Reset requests per IP per day (verify_record clears at UTC 0).

function randomToken() {
	const bytes = new Uint8Array(24);
	crypto.getRandomValues(bytes);
	return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

function resetBaseUrl(c, setting) {
	// Prefer the configured custom domain; fall back to the request host.
	const host = setting.customDomain || new URL(c.req.url).host;
	return `https://${host}`;
}

const passwordResetService = {

	async requestReset(c, params) {
		const { email } = params;

		// Rate-limit first, before any account lookup, so abuse and
		// non-existent addresses cost exactly the same.
		const allowed = await verifyRecordService.consumeResetAttempt(c, RESET_DAILY_LIMIT);
		if (!allowed) {
			throw new BizError(t('resetTooMany'));
		}

		// Deliberately the same response whether or not the address exists:
		// never reveal account existence (user enumeration).
		if (!email || !verifyUtils.isEmail(email)) {
			return;
		}

		const userRow = await userService.selectByEmail(c, email);

		if (!userRow || userRow.isDel === isDel.DELETE || userRow.status === userConst.status.BAN) {
			return;
		}

		// One live link per address: a repeat request inside the window
		// reuses the first link instead of flooding the mailbox.
		const emailKey = KvConst.PWD_RESET_EMAIL + email.toLowerCase();
		if (await c.env.kv.get(emailKey)) {
			return;
		}

		const token = randomToken();
		const setting = await settingService.query(c);

		await c.env.kv.put(KvConst.PWD_RESET + token,
			JSON.stringify({ userId: userRow.userId, email: userRow.email }),
			{ expirationTtl: TOKEN_TTL_SECONDS });
		await c.env.kv.put(emailKey, token, { expirationTtl: TOKEN_TTL_SECONDS });

		const link = `${resetBaseUrl(c, setting)}/login/reset-password?token=${token}`;

		// A send failure must not change the response: only existing
		// accounts trigger a send, so a 500 here would be an oracle.
		try {
			await this.sendResetEmail(c, setting, userRow.email, link);
		} catch (e) {
			console.error(`password reset: failed to send reset email to ${userRow.email}:`, e.message);
		}
	},

	async sendResetEmail(c, setting, toEmail, link) {
		const fromEmail = c.env.admin;
		const subject = 'Reset your BearerMail password';
		const text = `You asked to reset the password for ${toEmail}.\n\nReset it here (valid for 30 minutes, one-time use):\n${link}\n\nIf you did not ask for this, just ignore this email — your password will not change.`;
		const html = `<p>You asked to reset the password for ${toEmail}.</p><p><a href="${link}">Reset your password</a> (valid for 30 minutes, one-time use).</p><p>Or copy this link into your browser:<br>${link}</p><p>If you did not ask for this, just ignore this email — your password will not change.</p>`;

		// Resend first (per-domain token, same setup as normal sending),
		// Cloudflare Email second.
		const domain = emailUtils.getDomain(fromEmail);
		const resendToken = setting.resendTokens?.[domain];
		if (resendToken) {
			const resend = new Resend(resendToken);
			await resend.emails.send({ from: `BearerMail <${fromEmail}>`, to: [toEmail], subject, text, html });
			return;
		}

		if (c.env.email) {
			await c.env.email.send({ from: { email: fromEmail, name: 'BearerMail' }, to: [toEmail], subject, text, html });
			return;
		}

		throw new Error('no send provider configured (no Resend token, no Cloudflare Email binding)');
	},

	async confirmReset(c, params) {
		const { token, password } = params;

		if (!token) {
			throw new BizError(t('resetLinkInvalid'));
		}

		if (!password || password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		const stored = await c.env.kv.get(KvConst.PWD_RESET + token, { type: 'json' });

		if (!stored) {
			throw new BizError(t('resetLinkInvalid'));
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		await orm(c).update(user).set({ password: hash, salt }).where(eq(user.userId, stored.userId)).run();

		// Single-use: the token and the per-address throttle die with it.
		await c.env.kv.delete(KvConst.PWD_RESET + token);
		await c.env.kv.delete(KvConst.PWD_RESET_EMAIL + stored.email.toLowerCase());

		// Log every session out, like the admin set-password flow does.
		await c.env.kv.delete(KvConst.AUTH_INFO + stored.userId);
	}
};

export default passwordResetService;
