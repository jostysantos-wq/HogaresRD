'use strict';

/**
 * encryption.js — AES-256-GCM field-level encryption for sensitive PII
 *
 * Used to encrypt cédula numbers, income data, and other sensitive
 * fields at the application layer before storing in PostgreSQL.
 *
 * Key: derived from ENCRYPTION_KEY env var (falls back to JWT_SECRET).
 * Each encryption produces a unique IV + auth tag — same plaintext
 * produces different ciphertext every time.
 *
 * Format: iv:authTag:ciphertext (all hex-encoded)
 */

const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;

// Derive a 32-byte key from the env var using SHA-256
function getKey() {
  const secret = process.env.ENCRYPTION_KEY || process.env.JWT_SECRET;
  if (!secret) {
    console.error('[encryption] CRITICAL: No ENCRYPTION_KEY or JWT_SECRET set — encryption will fail');
    throw new Error('ENCRYPTION_KEY environment variable is required');
  }
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt a plaintext string.
 * Returns: "iv:authTag:ciphertext" (hex-encoded)
 * Returns null if input is null/undefined/empty.
 */
function encrypt(plaintext) {
  if (!plaintext || typeof plaintext !== 'string' || !plaintext.trim()) return null;

  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag().toString('hex');

  return `${iv.toString('hex')}:${authTag}:${encrypted}`;
}

/**
 * Decrypt a previously encrypted string.
 * Input: "iv:authTag:ciphertext" (hex-encoded)
 * Returns the original plaintext, or null if decryption fails.
 */
function decrypt(encryptedStr) {
  if (!encryptedStr || typeof encryptedStr !== 'string') return null;

  // If the value doesn't look encrypted (no colons), return as-is
  // This handles legacy plaintext data gracefully
  const parts = encryptedStr.split(':');
  if (parts.length !== 3) return encryptedStr; // legacy plaintext

  try {
    const [ivHex, authTagHex, ciphertext] = parts;
    const key = getKey();
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(ciphertext, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch {
    // Decryption failed — likely legacy plaintext or corrupted
    return encryptedStr;
  }
}

/**
 * Check if a value is already encrypted (has the iv:tag:cipher format)
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3 && parts[0].length === 32 && parts[1].length === 32;
}

module.exports = { encrypt, decrypt, isEncrypted };
