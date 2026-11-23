import BizError from '../error/biz-error';
import userService from './user-service';
import emailUtils from '../utils/email-utils';
import { isDel, settingConst, userConst } from '../const/entity-const';
import JwtUtils from '../utils/jwt-utils';
import { v4 as uuidv4 } from 'uuid';
import KvConst from '../const/kv-const';
import constant from '../const/constant';
import userContext from '../security/user-context';
import verifyUtils from '../utils/verify-utils';
import accountService from './account-service';
import settingService from './setting-service';
import saltHashUtils from '../utils/crypto-utils';
import cryptoUtils from '../utils/crypto-utils';
import turnstileService from './turnstile-service';
import roleService from './role-service';
import regKeyService from './reg-key-service';
import dayjs from 'dayjs';
import { toUtc } from '../utils/date-uitil';
import { t } from '../i18n/i18n.js';
import verifyRecordService from './verify-record-service';
import totpService from './totp-service';

const loginService = {

	async register(c, params, oauth = false) {

		const { email, password, token, code } = params;

		let { regKey, register, registerVerify, regVerifyCount, minEmailPrefix, emailPrefixFilter } = await settingService.query(c)

		if (oauth) {
			registerVerify = settingConst.registerVerify.CLOSE;
			register = settingConst.register.OPEN;
		}

		if (register === settingConst.register.CLOSE) {
			throw new BizError(t('regDisabled'));
		}

		if (!verifyUtils.isEmail(email)) {
			throw new BizError(t('notEmail'));
		}

		if (emailUtils.getName(email).length < minEmailPrefix) {
			throw new BizError(t('minEmailPrefix', { msg: minEmailPrefix } ));
		}

		if (emailPrefixFilter.some(content => emailUtils.getName(email).includes(content)))  {
			throw new BizError(t('banEmailPrefix'));
		}

		if (emailUtils.getName(email).length > 64) {
			throw new BizError(t('emailLengthLimit'));
		}

		if (password.length > 30) {
			throw new BizError(t('pwdLengthLimit'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		let type = null;
		let regKeyId = 0

		if (regKey === settingConst.regKey.OPEN) {
			const result = await this.handleOpenRegKey(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		if (regKey === settingConst.regKey.OPTIONAL) {
			const result = await this.handleOpenOptional(c, regKey, code)
			type = result?.type
			regKeyId = result?.regKeyId
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow) {
			// Same response as a fresh registration: never reveal whether
			// the address already has an account (mirrors the
			// password-reset flow's identical response). No account is
			// created and no invite code is consumed.
			return { regVerifyOpen: false };
		}

		let defType = null

		if (!type) {
			const roleRow = await roleService.selectDefaultRole(c);
			defType = roleRow.roleId
		}


		const roleRow = await roleService.selectById(c, type || defType);

		if(!roleService.hasAvailDomainPerm(roleRow.availDomain, email)) {

			if (type) {
				throw new BizError(t('noDomainPermRegKey'),403)
			}

			if (defType) {
				throw new BizError(t('noDomainPermReg'),403)
			}

		}

		let regVerifyOpen = false

		if (registerVerify === settingConst.registerVerify.OPEN) {
			regVerifyOpen = true
			await turnstileService.verify(c,token)
		}

		if (registerVerify === settingConst.registerVerify.COUNT) {
			regVerifyOpen = await verifyRecordService.isOpenRegVerify(c, regVerifyCount);
			if (regVerifyOpen) {
				await turnstileService.verify(c,token)
			}
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		let consumedCode = null
		const usingRegKey = regKey !== settingConst.regKey.CLOSE && type

		if (usingRegKey && !await regKeyService.consumeCount(c, code)) {
			if (regKey === settingConst.regKey.OPEN) {
				throw new BizError(t('noRegKeyCount'))
			}
			type = null
			regKeyId = 0
			defType = await this.useDefaultRole(c, email)
		}

		if (usingRegKey && type) {
			consumedCode = code
		}

		let userId

		try {
			userId = await userService.insert(c, { email, regKeyId, password: hash, salt, type: type || defType });
			await accountService.insert(c, { userId: userId, email, name: emailUtils.getName(email) });
		} catch (error) {
			if (consumedCode) {
				await regKeyService.restoreCount(c, consumedCode)
			}
			throw error
		}

		await userService.updateUserInfo(c, userId, true);

		if (registerVerify === settingConst.registerVerify.COUNT && !regVerifyOpen) {
			const row = await verifyRecordService.increaseRegCount(c);
			return {regVerifyOpen: row.count >= regVerifyCount}
		}

		return {regVerifyOpen}

	},

	async registerVerify() {

	},

	async handleOpenRegKey(c, regKey, code) {

		if (!code) {
			throw new BizError(t('emptyRegKey'));
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			throw new BizError(t('notExistRegKey'));
		}

		if (regKeyRow.count <= 0) {
			throw new BizError(t('noRegKeyCount'));
		}

		if (!toUtc(regKeyRow.expireTime).isAfter(toUtc())) {
			throw new BizError(t('regKeyExpire'));
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async useDefaultRole(c, email) {
		const defaultRole = await roleService.selectDefaultRole(c)
		if (!roleService.hasAvailDomainPerm(defaultRole.availDomain, email)) {
			throw new BizError(t('noDomainPermReg'), 403)
		}
		return defaultRole.roleId
	},

	async handleOpenOptional(c, regKey, code) {

		if (!code) {
			return null
		}

		const regKeyRow = await regKeyService.selectByCode(c, code);

		if (!regKeyRow) {
			return null
		}

		if (regKeyRow.count <= 0 || !toUtc(regKeyRow.expireTime).isAfter(toUtc())) {
			return null
		}

		return { type: regKeyRow.roleId, regKeyId: regKeyRow.regKeyId };
	},

	async login(c, params, noVerifyPwd = false) {

		const { email, password, token } = params;

		if ((!email || !password) && !noVerifyPwd) {
			throw new BizError(t('emailAndPwdEmpty'));
		}

		if (!noVerifyPwd) {
			// Unconditional per-IP attempt budget (30/day; the record
			// clears at UTC 0). No Turnstile is involved, so the sync
			// worker's rare admin logins — it caches its JWT and re-logs
			// in only on 401 — stay well under the budget. This runs
			// whatever the Login verification setting is; the Turnstile
			// gate below is unchanged.
			if (!await verifyRecordService.consumeLoginRateLimit(c, 30)) {
				throw new BizError(t('tooManyLoginAttempts'), 429);
			}
			const { loginVerify, loginVerifyCount = 1 } = await settingService.query(c);
			if (loginVerify === settingConst.loginVerify.OPEN ||
				(loginVerify === settingConst.loginVerify.COUNT && !await verifyRecordService.consumeLoginAttempt(c, loginVerifyCount))) {
				await turnstileService.verify(c, token);
			}
		}

		const userRow = await userService.selectByEmailIncludeDel(c, email);

		if (!userRow) {
			if (!noVerifyPwd) {
				// Same-cost dummy check: a missing account costs exactly
				// one password hash, like a wrong password — no timing
				// oracle for the attacker.
				await cryptoUtils.verifyPassword(password, 'invalid', 'invalid');
			}
			throw new BizError(t('invalidEmailOrPassword'));
		}

		if (!noVerifyPwd && !await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			throw new BizError(t('invalidEmailOrPassword'));
		}

		if(userRow.isDel === isDel.DELETE || userRow.status === userConst.status.BAN) {
			throw new BizError(t('invalidEmailOrPassword'));
		}

		// Password logins with TOTP on stop here: no JWT is issued until
		// the second factor verifies. OAuth logins (noVerifyPwd) skip
		// TOTP — the OAuth provider already authenticated the user.
		if (!noVerifyPwd && userRow.totpEnabled) {
			// Service-token bypass, sync worker only: a long random token
			// set as the SERVICE_TOKEN secret on both workers, valid for
			// the admin account only. Browser logins never send it and can
			// never use it.
			const serviceToken = c.req.header('X-Service-Token');
			if (serviceToken && c.env.SERVICE_TOKEN && userRow.email === c.env.admin &&
				totpService.timingSafeEqual(serviceToken, c.env.SERVICE_TOKEN)) {
				return this.issueSession(c, userRow);
			}
			const challenge = await this.createTotpChallenge(c, userRow.userId);
			return { totpRequired: true, challenge };
		}

		return this.issueSession(c, userRow);
	},

	// Mint a JWT session for a user who already passed every check.
	// Shared by the password login and the TOTP challenge verification.
	async issueSession(c, userRow) {
		const uuid = uuidv4();
		const jwt = await JwtUtils.generateToken(c,{ userId: userRow.userId, token: uuid, gen: constant.AUTH_GEN });

		let authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userRow.userId, { type: 'json' });

		if (authInfo && (authInfo.user.email === userRow.email)) {

			if (authInfo.tokens.length > 10) {
				authInfo.tokens.shift();
			}

			authInfo.tokens.push(uuid);

		} else {

			authInfo = {
				tokens: [],
				user: userRow,
				refreshTime: dayjs().toISOString()
			};

			authInfo.tokens.push(uuid);

		}

		await userService.updateUserInfo(c, userRow.userId);

		await c.env.kv.put(KvConst.AUTH_INFO + userRow.userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
		return jwt;
	},

	async createTotpChallenge(c, userId) {
		const bytes = new Uint8Array(24);
		crypto.getRandomValues(bytes);
		const challenge = [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
		await c.env.kv.put(KvConst.TOTP_CHALLENGE + challenge,
			JSON.stringify({ userId, attempts: 0 }),
			{ expirationTtl: 300 });
		return challenge;
	},

	// Second step of a TOTP login: the challenge is single-use, lives 5
	// minutes, and dies after 5 wrong codes. A wrong code never reveals
	// whether the account, the challenge, or the code was the problem
	// beyond what the password step already established.
	async verifyTotpChallenge(c, params) {
		const { challenge, code } = params;
		const record = await c.env.kv.get(KvConst.TOTP_CHALLENGE + (challenge || ''), { type: 'json' });
		if (!record) {
			throw new BizError(t('totpChallengeInvalid'), 410);
		}
		if (record.attempts >= 5) {
			await c.env.kv.delete(KvConst.TOTP_CHALLENGE + challenge);
			throw new BizError(t('totpTooManyAttempts'), 410);
		}
		const userRow = await userService.selectById(c, record.userId);
		if (!userRow || userRow.status === userConst.status.BAN || !userRow.totpEnabled) {
			await c.env.kv.delete(KvConst.TOTP_CHALLENGE + challenge);
			throw new BizError(t('totpChallengeInvalid'), 410);
		}
		const ok = await userService.verifyTotpCode(c, userRow, code);
		if (!ok) {
			await c.env.kv.put(KvConst.TOTP_CHALLENGE + challenge,
				JSON.stringify({ userId: record.userId, attempts: record.attempts + 1 }),
				{ expirationTtl: 300 });
			throw new BizError(t('totpInvalidCode'));
		}
		await c.env.kv.delete(KvConst.TOTP_CHALLENGE + challenge);
		return this.issueSession(c, userRow);
	},

	async logout(c, userId) {
		const token = await userContext.getToken(c);
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		const index = authInfo.tokens.findIndex(item => item === token);
		authInfo.tokens.splice(index, 1);
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
	}

};

export default loginService;

