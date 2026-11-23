import BizError from '../error/biz-error';
import accountService from './account-service';
import orm from '../entity/orm';
import user from '../entity/user';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { emailConst, isDel, roleConst, settingConst, userConst } from '../const/entity-const';
import kvConst from '../const/kv-const';
import KvConst from '../const/kv-const';
import cryptoUtils from '../utils/crypto-utils';
import emailService from './email-service';
import dayjs from 'dayjs';
import permService from './perm-service';
import roleService from './role-service';
import emailUtils from '../utils/email-utils';
import saltHashUtils from '../utils/crypto-utils';
import constant from '../const/constant';
import { t } from '../i18n/i18n'
import reqUtils from '../utils/req-utils';
import {oauth} from "../entity/oauth";
import oauthService from "./oauth-service";
import settingService from './setting-service';
import starService from './star-service';
import userContext from '../security/user-context';
import totpService from './totp-service';

const userService = {

	async loginUserInfo(c, userId) {

		const userRow = await userService.selectById(c, userId);

		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}

		const [account, roleRow, permKeys] = await Promise.all([
			accountService.selectByEmailIncludeDel(c, userRow.email),
			roleService.selectById(c, userRow.type),
			userRow.email === c.env.admin ? Promise.resolve(['*']) : permService.userPermKeys(c, userId)
		]);

		const user = {};
		user.userId = userRow.userId;
		user.sendCount = userRow.sendCount;
		user.email = userRow.email;
		user.account = account;
		user.name = account.name;
		user.permKeys = permKeys;
		user.role = roleRow;
		user.type = userRow.type;
		user.blockImages = userRow.blockImages ?? 1;
		user.disableLinks = userRow.disableLinks ?? 0;
		user.totpEnabled = userRow.totpEnabled ?? 0;

		if (c.env.admin === userRow.email) {
			user.role = constant.ADMIN_ROLE
			user.type = 0;
		}

		return user;
	},


	async setEmailSecurity(c, params, userId) {
		const updates = {};
		if (params.blockImages !== undefined) {
			updates.blockImages = Number(params.blockImages) ? 1 : 0;
		}
		if (params.disableLinks !== undefined) {
			updates.disableLinks = Number(params.disableLinks) ? 1 : 0;
		}
		if (!Object.keys(updates).length) {
			return;
		}
		await orm(c).update(user).set(updates).where(eq(user.userId, userId)).run();
	},


	// --- Two-factor authentication (TOTP) ---
	// The secret is stored AES-GCM-encrypted (see totp-service); backup
	// codes are stored as salted SHA-256 hashes and are single-use.
	async setupTotp(c, userId) {
		const userRow = await this.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}
		if (userRow.totpEnabled) {
			throw new BizError(t('totpAlreadyEnabled'));
		}
		const secret = totpService.generateSecret();
		const encrypted = await totpService.encryptSecret(c, secret);
		await orm(c).update(user).set({ totpSecret: encrypted }).where(eq(user.userId, userId)).run();
		return { secret, otpauthUrl: totpService.buildOtpAuthUrl('BearerMail', userRow.email, secret) };
	},

	async enableTotp(c, params, userId) {
		const { code } = params;
		const userRow = await this.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}
		if (userRow.totpEnabled) {
			throw new BizError(t('totpAlreadyEnabled'));
		}
		if (!userRow.totpSecret) {
			throw new BizError(t('totpNoPendingSecret'));
		}
		const secret = await totpService.decryptSecret(c, userRow.totpSecret);
		if (!await totpService.verifyCode(secret, code)) {
			throw new BizError(t('totpInvalidCode'));
		}
		const backupCodes = totpService.generateBackupCodes();
		const hashed = await totpService.hashBackupCodes(backupCodes);
		await orm(c).update(user).set({ totpEnabled: 1, totpBackupCodes: hashed }).where(eq(user.userId, userId)).run();
		return { backupCodes };
	},

	async disableTotp(c, params, userId) {
		const { password, code } = params;
		const userRow = await this.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}
		if (!userRow.totpEnabled) {
			throw new BizError(t('totpNotEnabled'));
		}
		if (!password || !await cryptoUtils.verifyPassword(password, userRow.salt, userRow.password)) {
			throw new BizError(t('IncorrectPwd'));
		}
		const ok = await this.verifyTotpCode(c, userRow, code);
		if (!ok) {
			throw new BizError(t('totpInvalidCode'));
		}
		await orm(c).update(user).set({ totpEnabled: 0, totpSecret: '', totpBackupCodes: '' }).where(eq(user.userId, userId)).run();
	},

	async regenerateBackupCodes(c, params, userId) {
		const { code } = params;
		const userRow = await this.selectById(c, userId);
		if (!userRow) {
			throw new BizError(t('authExpired'), 401);
		}
		if (!userRow.totpEnabled) {
			throw new BizError(t('totpNotEnabled'));
		}
		// Backup codes alone must not mint fresh backup codes: only a
		// live authenticator code proves possession of the app.
		const secret = await totpService.decryptSecret(c, userRow.totpSecret);
		if (!await totpService.verifyCode(secret, code)) {
			throw new BizError(t('totpInvalidCode'));
		}
		const backupCodes = totpService.generateBackupCodes();
		const hashed = await totpService.hashBackupCodes(backupCodes);
		await orm(c).update(user).set({ totpBackupCodes: hashed }).where(eq(user.userId, userId)).run();
		return { backupCodes };
	},

	// Verify a TOTP code or a backup code for a user. Backup codes are
	// single-use: a match consumes the code. Used by the login challenge
	// and by disableTotp.
	async verifyTotpCode(c, userRow, code) {
		const clean = String(code || '').replace(/[\s-]/g, '');
		if (!userRow.totpSecret) {
			return false;
		}
		if (/^\d{6}$/.test(clean)) {
			const secret = await totpService.decryptSecret(c, userRow.totpSecret);
			if (await totpService.verifyCode(secret, code)) {
				return true;
			}
		}
		if (/^[A-Z0-9]{10}$/i.test(clean)) {
			const result = await totpService.verifyBackupCode(code, userRow.totpBackupCodes);
			if (result.matched) {
				await orm(c).update(user).set({ totpBackupCodes: result.remaining }).where(eq(user.userId, userRow.userId)).run();
				return true;
			}
		}
		return false;
	},

	// Admin recovery: a user who lost the authenticator AND the backup
	// codes has no way back in on their own. The admin clears TOTP for
	// them; their sessions are dropped everywhere so the recovery is
	// not silently shadowed by a live login.
	async adminDisableTotp(c, params) {
		const { userId } = params;
		if (!userId) {
			throw new BizError(t('emptyAccountId'));
		}
		await orm(c).update(user).set({ totpEnabled: 0, totpSecret: '', totpBackupCodes: '' }).where(eq(user.userId, Number(userId))).run();
		await c.env.kv.delete(KvConst.AUTH_INFO + Number(userId));
	},

	async resetPassword(c, params, userId) {

		const { password } = params;

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}
		const { salt, hash } = await cryptoUtils.hashPassword(password);
		await orm(c).update(user).set({ password: hash, salt: salt }).where(eq(user.userId, userId)).run();

		// 个人设置改密：会话列表只留当前 uuid，其它设备下线。管理员改别人密码不走这里。
		if (userContext.getUserId(c) !== userId) {
			return;
		}

		const sessionToken = await userContext.getToken(c);
		const authInfo = await c.env.kv.get(KvConst.AUTH_INFO + userId, { type: 'json' });
		if (!authInfo) {
			return;
		}
		authInfo.tokens = sessionToken ? [sessionToken] : [];
		await c.env.kv.put(KvConst.AUTH_INFO + userId, JSON.stringify(authInfo), { expirationTtl: constant.TOKEN_EXPIRE });
	},

	selectByEmail(c, email) {
		return orm(c).select().from(user).where(
			and(
				sql`${user.email} COLLATE NOCASE = ${email}`,
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async insert(c, params) {
		const { userId } = await orm(c).insert(user).values({ ...params }).returning().get();
		return userId;
	},

	selectByEmailIncludeDel(c, email) {
		return orm(c).select().from(user).where(sql`${user.email} COLLATE NOCASE = ${email}`).get();
	},

	selectByIdIncludeDel(c, userId) {
		return orm(c).select().from(user).where(eq(user.userId, userId)).get();
	},

	selectById(c, userId) {
		return orm(c).select().from(user).where(
			and(
				eq(user.userId, userId),
				eq(user.isDel, isDel.NORMAL)))
			.get();
	},

	async delete(c, userId) {
		const { syncDelete } = await settingService.query(c);
		if (syncDelete === settingConst.syncDelete.OPEN) {
			await this.physicsDelete(c, { userIds: String(userId) });
			await c.env.kv.delete(kvConst.AUTH_INFO + userId)
			return;
		}
		await orm(c).update(user).set({ isDel: isDel.DELETE }).where(eq(user.userId, userId)).run();
		await c.env.kv.delete(kvConst.AUTH_INFO + userId)
	},

	async physicsDelete(c, params) {
		let { userIds } = params;
		userIds = userIds.split(',').map(Number);
		await starService.removeByUserIds(c, userIds);
		await accountService.physicsDeleteByUserIds(c, userIds);
		await oauthService.deleteByUserIds(c, userIds);
		await orm(c).delete(user).where(inArray(user.userId, userIds)).run();
	},

	async list(c, params) {

		let { num, size, email, timeSort, status } = params;

		size = Number(size);
		num = Number(num);
		timeSort = Number(timeSort);
		params.isDel = Number(params.isDel);

		if (isNaN(size)) {
			size = 50;
		}

		if (isNaN(num)) {
			num = 1;
		}

		if (size > 50) {
			size = 50;
		}

		num = (num - 1) * size;

		const conditions = [];

		if (status > -1) {
			conditions.push(eq(user.status, status));
			conditions.push(eq(user.isDel, isDel.NORMAL));
		}


		if (email) {
			conditions.push(sql`${user.email} COLLATE NOCASE LIKE ${email + '%'}`);
		}


		if (params.isDel) {
			conditions.push(eq(user.isDel, params.isDel));
		}


		const query = orm(c).select({
			...user,
			username: oauth.username,
			trustLevel: oauth.trustLevel,
			avatar: oauth.avatar,
			name: oauth.name,
			platform: oauth.platform
		}).from(user).leftJoin(oauth, eq(oauth.userId, user.userId))
			.where(and(...conditions));


		if (timeSort) {
			query.orderBy(asc(user.userId));
		} else {
			query.orderBy(desc(user.userId));
		}

		const list = await query.limit(size).offset(num);

		const { total } = await orm(c)
			.select({ total: count() })
			.from(user)
			.where(and(...conditions)).get();
		const userIds = list.map(user => user.userId);

		const types = [...new Set(list.map(user => user.type))];

		const [emailCounts, delEmailCounts, sendCounts, delSendCounts, accountCounts, delAccountCounts, roleList] = await Promise.all([
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.RECEIVE, isDel.DELETE),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND),
			emailService.selectUserEmailCountList(c, userIds, emailConst.type.SEND, isDel.DELETE),
			accountService.selectUserAccountCountList(c, userIds),
			accountService.selectUserAccountCountList(c, userIds, isDel.DELETE),
			roleService.selectByIdsHasPermKey(c, types,'email:send')
		]);

		const receiveMap = Object.fromEntries(emailCounts.map(item => [item.userId, item.count]));
		const sendMap = Object.fromEntries(sendCounts.map(item => [item.userId, item.count]));
		const accountMap = Object.fromEntries(accountCounts.map(item => [item.userId, item.count]));

		const delReceiveMap = Object.fromEntries(delEmailCounts.map(item => [item.userId, item.count]));
		const delSendMap = Object.fromEntries(delSendCounts.map(item => [item.userId, item.count]));
		const delAccountMap = Object.fromEntries(delAccountCounts.map(item => [item.userId, item.count]));

		for (const user of list) {

			const userId = user.userId;

			user.receiveEmailCount = receiveMap[userId] || 0;
			user.sendEmailCount = sendMap[userId] || 0;
			user.accountCount = accountMap[userId] || 0;

			user.delReceiveEmailCount = delReceiveMap[userId] || 0;
			user.delSendEmailCount = delSendMap[userId] || 0;
			user.delAccountCount = delAccountMap[userId] || 0;

			const roleIndex = roleList.findIndex(roleRow => user.type === roleRow.roleId);
			let sendAction = {};

			if (roleIndex > -1) {
				sendAction.sendType = roleList[roleIndex].sendType;
				sendAction.sendCount = roleList[roleIndex].sendCount;
				sendAction.hasPerm = true;
			} else {
				sendAction.hasPerm = false;
			}

			if (user.email === c.env.admin) {
				sendAction.sendType = constant.ADMIN_ROLE.sendType;
				sendAction.sendCount = constant.ADMIN_ROLE.sendCount;
				sendAction.hasPerm = true;
				user.type = 0
			}

			user.sendAction = sendAction;
		}

		return { list, total };
	},

	async updateUserInfo(c, userId, recordCreateIp = false) {



		const activeIp = reqUtils.getIp(c);

		const {os, browser, device} = reqUtils.getUserAgent(c);

		const params = {
			os,
			browser,
			device,
			activeIp,
			activeTime: dayjs().format('YYYY-MM-DD HH:mm:ss')
		};

		if (recordCreateIp) {
			params.createIp = activeIp;
		}

		await orm(c)
			.update(user)
			.set(params)
			.where(eq(user.userId, userId))
			.run();
	},

	async setPwd(c, params) {

		const { password, userId } = params;
		await this.resetPassword(c, { password }, userId);
		await c.env.kv.delete(KvConst.AUTH_INFO + userId);
	},

	async setStatus(c, params) {

		const { status, userId } = params;

		await orm(c)
			.update(user)
			.set({ status })
			.where(eq(user.userId, userId))
			.run();

		if (status === userConst.status.BAN) {
			await c.env.kv.delete(KvConst.AUTH_INFO + userId);
		}
	},

	async setType(c, params) {

		const { type, userId } = params;

		const roleRow = await roleService.selectById(c, type);

		if (!roleRow) {
			throw new BizError(t('roleNotExist'));
		}

		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.userId, userId))
			.run();

	},

	async incrUserSendCount(c, quantity, userId) {
		await orm(c).update(user).set({
			sendCount: sql`${user.sendCount}
	  +
	  ${quantity}`
		}).where(eq(user.userId, userId)).run();
	},

	async reserveSendCount(c, quantity, userId, limit) {
		// Atomic check-and-increment: only one concurrent send can win the
		// remaining quota. Mirrors regKeyService.consumeCount.
		const rows = await orm(c).update(user).set({
			sendCount: sql`${user.sendCount} + ${quantity}`
		}).where(and(
			eq(user.userId, userId),
			sql`${user.sendCount} + ${quantity} <= ${limit}`
		)).returning({ userId: user.userId });
		return rows.length > 0;
	},

	async releaseSendCount(c, quantity, userId) {
		if (!quantity || quantity <= 0) {
			return;
		}
		await orm(c).update(user).set({
			sendCount: sql`max(${user.sendCount} - ${quantity}, 0)`
		}).where(eq(user.userId, userId)).run();
	},

	async updateAllUserType(c, type, curType) {
		await orm(c)
			.update(user)
			.set({ type })
			.where(eq(user.type, curType))
			.run();
	},

	async initAdmin(c) {
		const email = c.env.admin;
		const password = c.env.password;

		if (!email || !password) {
			return;
		}

		const exist = await userService.selectByEmailIncludeDel(c, email);
		if (exist) {
			return;
		}

		const role = await roleService.selectDefaultRole(c);
		const { salt, hash } = await cryptoUtils.hashPassword(password);
		const userId = await userService.insert(c, {
			email,
			password: hash,
			salt,
			type: role?.roleId || 1
		});
		await userService.updateUserInfo(c, userId, true);
		await accountService.insert(c, {
			userId,
			email,
			name: emailUtils.getName(email)
		});
	},

	async add(c, params) {

		let { email, type, password } = params;

		if (!c.env.domain.includes(emailUtils.getDomain(email))) {
			throw new BizError(t('notEmailDomain'));
		}

		if (password.length < 6) {
			throw new BizError(t('pwdMinLength'));
		}

		const accountRow = await accountService.selectByEmailIncludeDel(c, email);

		if (accountRow && accountRow.isDel === isDel.DELETE) {
			throw new BizError(t('isDelUser'));
		}

		if (accountRow) {
			throw new BizError(t('isRegAccount'));
		}

		let role;
		if (type === undefined) {
			role = await roleService.selectDefaultRole(c);
			type = role?.roleId;
		} else {
			role = await roleService.selectById(c, type);
		}

		if (!role) {
			throw new BizError(t('roleNotExist'));
		}

		const { salt, hash } = await saltHashUtils.hashPassword(password);

		const userId = await userService.insert(c, { email, password: hash, salt, type });

		await userService.updateUserInfo(c, userId, true);

		await accountService.insert(c, { userId: userId, email, type, name: emailUtils.getName(email) });
	},

	async resetDaySendCount(c) {
		// 仅 UTC 0 点执行，便于配合每小时 cron
		if (new Date().getUTCHours() !== 0) {
			return;
		}
		const roleList = await roleService.selectByIdsAndSendType(c, 'email:send', roleConst.sendType.DAY);
		const roleIds = roleList.map(action => action.roleId);
		await orm(c).update(user).set({ sendCount: 0 }).where(inArray(user.type, roleIds)).run();
	},

	async resetSendCount(c, params) {
		await orm(c).update(user).set({ sendCount: 0 }).where(eq(user.userId, params.userId)).run();
	},

	async restore(c, params) {
		const { userId, type } = params
		await orm(c)
			.update(user)
			.set({ isDel: isDel.NORMAL })
			.where(eq(user.userId, userId))
			.run();
		const userRow = await this.selectById(c, userId);
		await accountService.restoreByEmail(c, userRow.email);

		if (type) {
			await emailService.restoreByUserId(c, userId);
			await accountService.restoreByUserId(c, userId);
		}

	},

	listByRegKeyId(c, regKeyId) {
		return orm(c)
			.select({email: user.email,createTime: user.createTime})
			.from(user)
			.where(eq(user.regKeyId, regKeyId))
			.orderBy(desc(user.userId))
			.all();
	}
};

export default userService;

