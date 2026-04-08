/**
 * referrals.js — Affiliate/Referral link tracking (PostgreSQL-backed)
 */

const express   = require('express');
const crypto    = require('crypto');
const rateLimit = require('express-rate-limit');
const store     = require('./store');
const { userAuth } = require('./auth');

const router = express.Router();

function hashIP(ip) { return crypto.createHash('sha256').update(String(ip || '')).digest('hex').slice(0, 12); }

const clickLimiter = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many requests' },
  standardHeaders: true, legacyHeaders: false,
});

// ── POST /api/referrals/click — public, logs a click ──────────
router.post('/click', clickLimiter, async (req, res) => {
  const { ref_token, listing_id } = req.body;
  if (!ref_token) return res.status(400).json({ error: 'ref_token required' });

  const agent = store.getUserByRefToken(ref_token);
  if (!agent) return res.status(404).json({ error: 'Invalid ref token' });

  try {
    await store.pool.query(
      'INSERT INTO referral_clicks (ref_token, agent_id, listing_id, ip_hash, created_at) VALUES ($1, $2, $3, $4, $5)',
      [ref_token, agent.id, listing_id || null, hashIP(req.ip), new Date().toISOString()]
    );
  } catch {}

  res.json({ ok: true });
});

// ── GET /api/referrals/my-stats — authenticated agent stats ───
router.get('/my-stats', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !user.refToken) return res.json({ clicks: 0, unique_visitors: 0, leads: 0, applications: 0, conversion_rate: 0 });

  const refToken = user.refToken;
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  try {
    // Click stats
    const [allClicks, recentClicks, uniqueVisitors] = await Promise.all([
      store.pool.query('SELECT COUNT(*) as c FROM referral_clicks WHERE ref_token = $1', [refToken]),
      store.pool.query('SELECT COUNT(*) as c FROM referral_clicks WHERE ref_token = $1 AND created_at > $2', [refToken, thirtyDaysAgo]),
      store.pool.query('SELECT COUNT(DISTINCT ip_hash) as c FROM referral_clicks WHERE ref_token = $1', [refToken]),
    ]);

    // Lead stats
    const leadResult = await store.pool.query(
      'SELECT COUNT(*) as c FROM leads WHERE ref_token = $1 OR referred_by = $2',
      [refToken, user.id]
    );

    // Application stats
    const allApps = store.getApplications();
    const refApps = allApps.filter(a => a.referred_by === user.id || a.ref_token === refToken);
    const completedApps = refApps.filter(a => ['completado', 'pago_aprobado', 'aprobado'].includes(a.status));

    const leads = parseInt(leadResult.rows[0]?.c || 0);
    const totalLeadsAndApps = leads + refApps.length;
    const conversionRate = totalLeadsAndApps > 0
      ? ((completedApps.length / totalLeadsAndApps) * 100).toFixed(1)
      : '0.0';

    // Top listings by clicks
    const topResult = await store.pool.query(
      `SELECT listing_id, COUNT(*) as clicks FROM referral_clicks
       WHERE ref_token = $1 AND listing_id IS NOT NULL AND created_at > $2
       GROUP BY listing_id ORDER BY clicks DESC LIMIT 5`,
      [refToken, thirtyDaysAgo]
    );
    const topListings = topResult.rows.map(r => {
      const listing = store.getListingById(r.listing_id);
      return { id: r.listing_id, title: listing?.title || r.listing_id, clicks: parseInt(r.clicks) };
    });

    res.json({
      ref_token:       refToken,
      clicks_total:    parseInt(allClicks.rows[0]?.c || 0),
      clicks_30d:      parseInt(recentClicks.rows[0]?.c || 0),
      unique_visitors: parseInt(uniqueVisitors.rows[0]?.c || 0),
      leads,
      applications:    refApps.length,
      completed:       completedApps.length,
      conversion_rate: parseFloat(conversionRate),
      top_listings:    topListings,
      link_base:       `${process.env.BASE_URL || 'https://hogaresrd.com'}/r/${refToken}`,
    });
  } catch (err) {
    console.error('[referrals] Stats error:', err.message);
    res.json({ clicks: 0, unique_visitors: 0, leads: 0, applications: 0, conversion_rate: 0 });
  }
});

// ── GET /api/referrals/my-clicks — recent click log ───────────
router.get('/my-clicks', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user?.refToken) return res.json([]);

  try {
    const result = await store.pool.query(
      'SELECT * FROM referral_clicks WHERE ref_token = $1 ORDER BY created_at DESC LIMIT 50',
      [user.refToken]
    );
    res.json(result.rows);
  } catch {
    res.json([]);
  }
});

module.exports = router;
