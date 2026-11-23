import BizError from '../error/biz-error';
import saltHashUtils from '../utils/crypto-utils';
import { t } from '../i18n/i18n.js';

// TOTP two-factor authentication (RFC 6238, 6 digits, 30-second steps),
// dependency-free on WebCrypto (HMAC-SHA1 + AES-GCM + HKDF).
//
// Secret storage: the per-user TOTP secret is encrypted at rest with
// AES-GCM-256. The key is derived from jwt_secret via HKDF with a
// TOTP-only salt/info, so it is cryptographically separated from the
// JWT HMAC key — but it IS the same root secret. Rotating JWT_SECRET
// orphans every stored TOTP secret: affected users must have TOTP
// disabled by the admin and re-enrol. Backup codes are stored as
// salted SHA-256 hashes (like passwords), single-use, never plaintext.

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const BACKUP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const BACKUP_CODE_COUNT = 8;
const TOTP_STEP_SECONDS = 30;
const TOTP_WINDOW = 1;

function base32Encode(bytes) {
	let bits = 0;
	let value = 0;
	let out = '';
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
	}
	return out;
}

function base32Decode(str) {
	const clean = String(str || '').replace(/[\s=]/g, '').toUpperCase();
	let bits = 0;
	let value = 0;
	const bytes = [];
	for (const ch of clean) {
		const idx = BASE32_ALPHABET.indexOf(ch);
		if (idx === -1) {
			throw new Error('Invalid base32');
		}
		value = (value << 5) | idx;
		bits += 5;
		if (bits >= 8) {
			bytes.push((value >>> (bits - 8)) & 255);
			bits -= 8;
		}
	}
	return new Uint8Array(bytes);
}

async function hotp(secretBytes, counter) {
	const msg = new Uint8Array(8);
	let c = counter;
	for (let i = 7; i >= 0; i--) {
		msg[i] = c & 0xff;
		c = Math.floor(c / 256);
	}
	const key = await crypto.subtle.importKey('raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
	const offset = sig[sig.length - 1] & 0x0f;
	const code = ((sig[offset] & 0x7f) << 24) | ((sig[offset + 1] & 0xff) << 16) | ((sig[offset + 2] & 0xff) << 8) | (sig[offset + 3] & 0xff);
	return String(code % 1000000).padStart(6, '0');
}

const totpService = {

	// Constant-time string comparison. The length check short-circuits,
	// which is fine: length alone reveals nothing about the secret.
	timingSafeEqual(a, b) {
		if (typeof a !== 'string' || typeof b !== 'string') {
			return false;
		}
		if (a.length !== b.length) {
			return false;
		}
		let diff = 0;
		for (let i = 0; i < a.length; i++) {
			diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
		}
		return diff === 0;
	},

	generateSecret() {
		// 160-bit secret: 20 bytes encode to exactly 32 base32 chars.
		return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
	},

	buildOtpAuthUrl(issuer, account, secret) {
		const label = encodeURIComponent(`${issuer}:${account}`);
		return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
	},

	async verifyCode(secretBase32, code) {
		const clean = String(code || '').replace(/[\s-]/g, '');
		if (!/^\d{6}$/.test(clean)) {
			return false;
		}
		let secretBytes;
		try {
			secretBytes = base32Decode(secretBase32);
		} catch (e) {
			return false;
		}
		const step = Math.floor(Date.now() / 1000 / TOTP_STEP_SECONDS);
		for (let offset = -TOTP_WINDOW; offset <= TOTP_WINDOW; offset++) {
			const expected = await hotp(secretBytes, step + offset);
			if (this.timingSafeEqual(clean, expected)) {
				return true;
			}
		}
		return false;
	},

	async encryptionKey(c) {
		if (!c.env.jwt_secret) {
			throw new BizError(t('totpNotConfigured'));
		}
		const material = await crypto.subtle.importKey(
			'raw', new TextEncoder().encode(c.env.jwt_secret), 'HKDF', false, ['deriveKey']);
		return crypto.subtle.deriveKey(
			{
				name: 'HKDF',
				hash: 'SHA-256',
				salt: new TextEncoder().encode('cloud-mail/totp/v1'),
				info: new TextEncoder().encode('totp-secret-encryption')
			},
			material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
	},

	async encryptSecret(c, secret) {
		const key = await this.encryptionKey(c);
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(secret));
		const out = new Uint8Array(12 + data.byteLength);
		out.set(iv, 0);
		out.set(new Uint8Array(data), 12);
		return btoa(String.fromCharCode(...out));
	},

	async decryptSecret(c, encrypted) {
		let raw;
		try {
			raw = Uint8Array.from(atob(encrypted), ch => ch.charCodeAt(0));
		} catch (e) {
			throw new BizError(t('totpUnavailable'));
		}
		if (raw.length <= 12) {
			throw new BizError(t('totpUnavailable'));
		}
		try {
			const key = await this.encryptionKey(c);
			const plain = await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: raw.slice(0, 12) }, key, raw.slice(12));
			return new TextDecoder().decode(plain);
		} catch (e) {
			if (e instanceof BizError) {
				throw e;
			}
			// Wrong key (JWT_SECRET was rotated) or corrupted data: the
			// secret cannot be recovered. Say so plainly instead of
			// reporting a wrong code.
			throw new BizError(t('totpUnavailable'));
		}
	},

	generateBackupCodes(count = BACKUP_CODE_COUNT) {
		const codes = [];
		for (let i = 0; i < count; i++) {
			const bytes = crypto.getRandomValues(new Uint8Array(10));
			let code = '';
			for (const b of bytes) {
				code += BACKUP_ALPHABET[b % BACKUP_ALPHABET.length];
			}
			// Display grouped; verification strips the dash.
			codes.push(code.slice(0, 5) + '-' + code.slice(5));
		}
		return codes;
	},

	async hashBackupCodes(codes) {
		const out = [];
		for (const display of codes) {
			const canonical = display.replace(/[^A-Z0-9]/gi, '').toUpperCase();
			const { salt, hash } = await saltHashUtils.hashPassword(canonical);
			out.push({ s: salt, h: hash });
		}
		return JSON.stringify(out);
	},

	// Returns { matched, remaining }: remaining is the stored JSON with
	// the matched code removed (single-use). Caller persists it on match.
	async verifyBackupCode(code, storedJson) {
		let list;
		try {
			list = JSON.parse(storedJson || '[]');
		} catch (e) {
			return { matched: false, remaining: storedJson };
		}
		if (!Array.isArray(list)) {
			return { matched: false, remaining: storedJson };
		}
		const canonical = String(code || '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
		if (!/^[A-Z0-9]{10}$/.test(canonical)) {
			return { matched: false, remaining: storedJson };
		}
		for (let i = 0; i < list.length; i++) {
			const entry = list[i];
			if (!entry || !entry.s || !entry.h) {
				continue;
			}
			const hash = await saltHashUtils.genHashPassword(canonical, entry.s);
			if (this.timingSafeEqual(hash, entry.h)) {
				const remaining = list.slice();
				remaining.splice(i, 1);
				return { matched: true, remaining: JSON.stringify(remaining) };
			}
		}
		return { matched: false, remaining: storedJson };
	}
};

export default totpService;
