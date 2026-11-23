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
