/**
 * spaces.js — DigitalOcean Spaces (S3-compatible) upload utility
 *
 * Uploads files to DO Spaces when configured (SPACES_KEY + SPACES_SECRET + SPACES_BUCKET).
 * Falls back to local disk when Spaces is not configured, so the app works in development
 * and gracefully degrades if env vars are missing.
 *
 * Usage:
 *   const { uploadToSpaces } = require('../utils/spaces');
 *   const url = await uploadToSpaces(buffer, 'photos/ph_123.jpg', 'image/jpeg');
 *   // Returns: 'https://hogaresrd-uploads.nyc3.cdn.digitaloceanspaces.com/photos/ph_123.jpg'
 *   // Or null if Spaces is not configured (caller should fall back to local).
 */

'use strict';

const { S3Client, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const SPACES_KEY    = process.env.SPACES_KEY;
const SPACES_SECRET = process.env.SPACES_SECRET;
const SPACES_BUCKET = process.env.SPACES_BUCKET || 'hogaresrd-uploads';
const SPACES_REGION = process.env.SPACES_REGION || 'nyc3';
const SPACES_CDN    = process.env.SPACES_CDN_URL || `https://${SPACES_BUCKET}.${SPACES_REGION}.cdn.digitaloceanspaces.com`;

let _client = null;

function isConfigured() {
  return !!(SPACES_KEY && SPACES_SECRET);
}

function getClient() {
  if (_client) return _client;
  if (!isConfigured()) return null;

  _client = new S3Client({
    endpoint: `https://${SPACES_REGION}.digitaloceanspaces.com`,
    region: SPACES_REGION,
    credentials: {
      accessKeyId: SPACES_KEY,
      secretAccessKey: SPACES_SECRET,
    },
    forcePathStyle: false,
  });

  console.log(`[spaces] Connected to ${SPACES_BUCKET}.${SPACES_REGION}.digitaloceanspaces.com`);
  return _client;
}

/**
 * Upload a file buffer to DigitalOcean Spaces.
 *
 * @param {Buffer} buffer — file contents
 * @param {string} key — object path (e.g., 'photos/ph_123.jpg')
 * @param {string} contentType — MIME type
 * @param {object} [opts] — optional { acl: 'public-read' }
 * @returns {string|null} CDN URL if uploaded, null if Spaces is not configured
 */
async function uploadToSpaces(buffer, key, contentType, opts = {}) {
  const client = getClient();
  if (!client) return null;

  await client.send(new PutObjectCommand({
    Bucket: SPACES_BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    ACL: opts.acl || 'public-read',
    CacheControl: 'public, max-age=31536000, immutable',
  }));

  return `${SPACES_CDN}/${key}`;
}

/**
 * Delete a file from Spaces by its key.
 * Silently ignores errors (fire-and-forget cleanup).
 */
async function deleteFromSpaces(key) {
  const client = getClient();
  if (!client) return;
  try {
    await client.send(new DeleteObjectCommand({
      Bucket: SPACES_BUCKET,
      Key: key,
    }));
  } catch {}
}

/**
 * Extract the Spaces key from a CDN URL.
 * E.g., 'https://hogaresrd-uploads.nyc3.cdn.digitaloceanspaces.com/photos/ph_123.jpg' → 'photos/ph_123.jpg'
 */
function keyFromUrl(url) {
  if (!url || !url.includes('digitaloceanspaces.com/')) return null;
  return url.split('digitaloceanspaces.com/')[1] || null;
}

module.exports = { uploadToSpaces, deleteFromSpaces, keyFromUrl, isConfigured };
