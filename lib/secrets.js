const crypto = require('crypto');

// AES-256-GCM encryption for secrets at rest (tenant DB passwords).
// Values are stored as  enc:v1:<base64(iv | authTag | ciphertext)> .
// Values without the prefix are treated as legacy plaintext so existing
// rows keep working; they are re-encrypted the next time they're saved.

const PREFIX = 'enc:v1:';

function getKey() {
  const raw = process.env.TENANT_DB_ENC_KEY;
  if (!raw) return null;
  return crypto.createHash('sha256').update(raw).digest();
}

function encryptSecret(plain) {
  const key = getKey();
  if (!key) return plain;
  const iv     = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc    = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

function decryptSecret(value) {
  if (!value || !value.startsWith(PREFIX)) return value; // legacy plaintext
  const key = getKey();
  if (!key) throw new Error('Encrypted secret found but TENANT_DB_ENC_KEY is not set');
  const buf      = Buffer.from(value.slice(PREFIX.length), 'base64');
  const iv       = buf.subarray(0, 12);
  const authTag  = buf.subarray(12, 28);
  const enc      = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}

module.exports = { encryptSecret, decryptSecret };
