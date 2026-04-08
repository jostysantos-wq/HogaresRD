/**
 * referrals.js — Affiliate/Referral link tracking
 *
 * Agents share links with ?ref=TOKEN. This module tracks:
 *   - Clicks (public, anonymized)
 *   - Lead attribution (stored on leads/applications)
 *   - Agent stats (authenticated)
 */

const express   = require('express');
const fs        = require('fs');
const path      = require('path');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const store     = require('./store');
const { userAuth } = require('./auth');

const router = express.Router();

const clickLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many requests' },
  standardHeaders: true, legacyHeaders: false,
});
const CLICKS_FILE = path.join(__dirname, '../data/referral-clicks.json');

// ── Helpers ────────────────────────────────────────────────────
if (!fs.existsSync(CLICKS_FILE)) fs.writeFileSync(CLICKS_FILE, '[]');
function readClicks()      { try { return JSON.parse(fs.readFileSync(CLICKS_FILE, 'utf8')); } catch { return []; } }
function writeClicks(data) { fs.writeFileSync(CLICKS_FILE, JSON.stringify(data)); }
function hashIP(ip) { return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 12); }

// ── POST /api/referrals/click — public, logs a click ──────────
router.post('/click', clickLimiter, (req, res) => {
  const { ref_token, listing_id } = req.body;
  if (!ref_token) return res.status(400).json({ error: 'ref_token required' });

  const agent = store.getUserByRefToken(ref_token);
  if (!agent) return res.status(404).json({ error: 'Invalid ref token' });

  const clicks = readClicks();
  clicks.push({
    ref_token,
    agent_id:   agent.id,
    listing_id: listing_id || null,
    ip_hash:    hashIP(req.ip),
    timestamp:  new Date().toISOString(),
  });

  // Keep last 10,000 clicks to prevent unbounded growth
  if (clicks.length > 10000) clicks.splice(0, clicks.length - 10000);
  writeClicks(clicks);

  res.json({ ok: true });
});

// ── GET /api/referrals/my-stats — authenticated agent stats ───
router.get('/my-stats', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !user.refToken) return res.json({ clicks: 0, unique_visitors: 0, leads: 0, applications: 0, conversion_rate: 0 });

  const refToken = user.refToken;

  // Click stats
  const allClicks = readClicks().filter(c => c.ref_token === refToken);
  const uniqueIPs = new Set(allClicks.map(c => c.ip_hash));

  // Last 30 days clicks
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const recentClicks = allClicks.filter(c => c.timestamp > thirtyDaysAgo);

  // Lead stats — count leads with this ref_token
  let leads = 0;
  try {
    const leadsFile = path.join(__dirname, '../data/leads.json');
    if (fs.existsSync(leadsFile)) {
      const allLeads = JSON.parse(fs.readFileSync(leadsFile, 'utf8'));
      leads = allLeads.filter(l => l.ref_token === refToken || l.referred_by === user.id).length;
    }
  } catch {}

  // Application stats
  const allApps = store.getApplications ? store.getApplications() : [];
  const refApps = allApps.filter(a => a.referred_by === user.id || a.ref_token === refToken);
  const completedApps = refApps.filter(a => ['completado', 'pago_aprobado', 'aprobado'].includes(a.status));

  const totalLeadsAndApps = leads + refApps.length;
  const conversionRate = totalLeadsAndApps > 0
    ? ((completedApps.length / totalLeadsAndApps) * 100).toFixed(1)
    : '0.0';

  // Top listings by clicks
  const listingClicks = {};
  for (const c of recentClicks) {
    if (c.listing_id) listingClicks[c.listing_id] = (listingClicks[c.listing_id] || 0) + 1;
  }
  const topListings = Object.entries(listingClicks)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, clicks]) => {
      const listing = store.getListingById(id);
      return { id, title: listing?.title || id, clicks };
    });

  res.json({
    ref_token:       refToken,
    clicks_total:    allClicks.length,
    clicks_30d:      recentClicks.length,
    unique_visitors: uniqueIPs.size,
    leads,
    applications:    refApps.length,
    completed:       completedApps.length,
    conversion_rate: parseFloat(conversionRate),
    top_listings:    topListings,
    link_base:       `${process.env.BASE_URL || 'https://hogaresrd.com'}/r/${refToken}`,
  });
});

// ── GET /api/referrals/my-clicks — recent click log ───────────
router.get('/my-clicks', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user?.refToken) return res.json([]);

  const clicks = readClicks()
    .filter(c => c.ref_token === user.refToken)
    .slice(-50)
    .reverse();

  res.json(clicks);
});

module.exports = router;
