const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const multer   = require('multer');
const sharp    = require('sharp');
const store    = require('./store');
function uuidv4() { return crypto.randomUUID(); }

const router   = express.Router();
const { adminSessionAuth } = require('./admin-auth');

// ── Image upload config ───────────────────────────────────────
const ADS_UPLOAD_DIR = path.join(__dirname, '../public/uploads/ads');
if (!fs.existsSync(ADS_UPLOAD_DIR)) fs.mkdirSync(ADS_UPLOAD_DIR, { recursive: true });

const adUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo JPG, PNG, WEBP o GIF'));
  },
});

// Per-ad-type canonical dimensions. The renderer assumes uploaded ads
// already match these — we resize on upload (fit:cover with attention
// crop) so legacy or wrong-spec uploads still produce a clean image.
//
// banner     — inline web banner (1.91:1, Facebook OG-style)
// card       — in-feed card on web/list views (1:1)
// popup      — center-screen modal on iOS (4:5 portrait)
// fullscreen — full-screen interstitial / Reels ad on iOS (9:16)
const AD_TYPE_DIMENSIONS = {
  banner:     { width: 1200, height: 628  },
  card:       { width: 1080, height: 1080 },
  popup:      { width: 1080, height: 1350 },
  fullscreen: { width: 1080, height: 1920 },
};
const DEFAULT_AD_TYPE = 'popup';

function dimensionsForAdType(adType) {
  return AD_TYPE_DIMENSIONS[adType] || AD_TYPE_DIMENSIONS[DEFAULT_AD_TYPE];
}

// ── GET /api/ads/active  (public — used by the mobile app) ─────
// Optional ?type=popup to filter by ad_type
router.get('/active', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const adType = req.query.type || null;
    const result = await store.pool.query(
      `SELECT * FROM ads WHERE is_active = true
       AND (start_date IS NULL OR start_date <= $1)
       AND (end_date IS NULL OR end_date >= $1)
       ${adType ? 'AND ad_type = $2' : ''}
       ORDER BY priority DESC, created_at DESC`,
      adType ? [now, adType] : [now]
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// ── POST /api/ads/upload  (admin — upload ad image) ────────────
// Accepts an `ad_type` field (banner/card/popup/fullscreen). The image
// is resized to the canonical dimensions for that type using cover-fit
// with attention-based smart cropping, so the most visually salient
// region survives the crop.
router.post('/upload', adminSessionAuth, adUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
  try {
    const { uploadToSpaces, isConfigured: spacesConfigured } = require('../utils/spaces');
    const adType = (req.body.ad_type || DEFAULT_AD_TYPE).toLowerCase();
    const { width, height } = dimensionsForAdType(adType);
    const fname = `ad_${adType}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webp`;
    const buf = await sharp(req.file.buffer)
      .rotate()
      .resize(width, height, { fit: 'cover', position: 'attention' })
      .webp({ quality: 85 })
      .toBuffer();
    // Upload to Spaces CDN if configured
    if (spacesConfigured()) {
      try {
        const cdnUrl = await uploadToSpaces(buf, `ads/${fname}`, 'image/webp');
        if (cdnUrl) return res.json({ url: cdnUrl, width, height, ad_type: adType });
      } catch (e) { console.warn('[ads] Spaces upload failed:', e.message); }
    }
    // Fallback: save to local disk
    await sharp(buf).toFile(path.join(ADS_UPLOAD_DIR, fname));
    res.json({ url: `/uploads/ads/${fname}`, width, height, ad_type: adType });
  } catch (e) {
    res.status(500).json({ error: 'Error al procesar imagen: ' + e.message });
  }
});

// Expose the canonical dimensions so frontends can render hints and
// previews without duplicating the map.
router.get('/spec', (_req, res) => {
  res.json(AD_TYPE_DIMENSIONS);
});

// ── GET /api/ads  (admin) ──────────────────────────────────────
router.get('/', adminSessionAuth, async (req, res) => {
  try {
    const result = await store.pool.query('SELECT * FROM ads ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// ── POST /api/ads  (admin — create) ───────────────────────────
router.post('/', adminSessionAuth, async (req, res) => {
  const { title, advertiser, image_url, target_url, start_date, end_date,
          ad_type, placement, description, budget, priority, audience, cooldown_hours } = req.body;
  if (!title || !image_url) {
    return res.status(400).json({ error: 'title and image_url are required' });
  }
  const ad = {
    id:          uuidv4(),
    title,
    advertiser:  advertiser || '',
    description: (description || '').slice(0, 500),
    image_url,
    target_url:  target_url || '',
    ad_type:     ad_type || 'fullscreen',
    placement:   placement || 'feed',
    budget:      budget ? Number(budget) : null,
    priority:    Math.min(10, Math.max(1, Number(priority) || 5)),
    audience:    audience || 'todos',
    cooldown_hours: Math.min(48, Math.max(1, Number(cooldown_hours) || 2)),
    is_active:   false,
    start_date:  start_date || null,
    end_date:    end_date   || null,
    impressions: 0,
    clicks:      0,
    created_at:  new Date().toISOString()
  };

  try {
    const cols = Object.keys(ad);
    const vals = cols.map(c => ad[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await store.pool.query(
      `INSERT INTO ads (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
      vals
    );
    res.status(201).json(ad);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/ads/analytics  (admin — dashboard data) ──────────
// IMPORTANT: This literal route MUST be registered before /:id params
router.get('/analytics', adminSessionAuth, async (req, res) => {
  try {
    const result = await store.pool.query(`
      SELECT id, title, advertiser, ad_type, placement, impressions, clicks,
        CASE WHEN impressions > 0 THEN ROUND(clicks::numeric / impressions * 100, 2) ELSE 0 END AS ctr,
        budget, is_active, start_date, end_date, cooldown_hours, created_at
      FROM ads ORDER BY created_at DESC
    `);
    const ads = result.rows;
    const summary = {
      total_ads:         ads.length,
      active_ads:        ads.filter(a => a.is_active).length,
      total_impressions: ads.reduce((s, a) => s + (a.impressions || 0), 0),
      total_clicks:      ads.reduce((s, a) => s + (a.clicks || 0), 0),
      avg_ctr:           0,
    };
    if (summary.total_impressions > 0) {
      summary.avg_ctr = Math.round(summary.total_clicks / summary.total_impressions * 10000) / 100;
    }
    res.json({ summary, ads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/ads/:id  (admin — update / toggle) ────────────────
const AD_UPDATE_FIELDS = ['title', 'advertiser', 'description', 'image_url', 'target_url',
  'ad_type', 'placement', 'budget', 'priority', 'audience', 'cooldown_hours',
  'is_active', 'start_date', 'end_date'];

router.put('/:id', adminSessionAuth, async (req, res) => {
  try {
    const current = await store.pool.query('SELECT * FROM ads WHERE id = $1', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found' });

    const row = current.rows[0];
    for (const k of AD_UPDATE_FIELDS) {
      if (k in req.body) row[k] = req.body[k];
    }
    // Clamp cooldown on update
    if (row.cooldown_hours != null) row.cooldown_hours = Math.min(48, Math.max(1, Number(row.cooldown_hours) || 2));

    const cols = Object.keys(row).filter(c => c !== 'id');
    const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
    const vals = cols.map(c => row[c]);
    vals.push(req.params.id);

    await store.pool.query(`UPDATE ads SET ${sets} WHERE id = $${vals.length}`, vals);
    res.json({ ...row, id: req.params.id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/ads/:id  (admin) ───────────────────────────────
router.delete('/:id', adminSessionAuth, async (req, res) => {
  try {
    const result = await store.pool.query('DELETE FROM ads WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ads/:id/impression  (public — mobile tracking) ──
router.post('/:id/impression', async (req, res) => {
  try {
    await store.pool.query('UPDATE ads SET impressions = impressions + 1 WHERE id = $1', [req.params.id]);
  } catch (err) { console.warn('[ads] impression tracking error:', err.message); }
  res.json({ ok: true });
});

// ── POST /api/ads/:id/click  (public — mobile tracking) ───────
router.post('/:id/click', async (req, res) => {
  try {
    await store.pool.query('UPDATE ads SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
  } catch (err) { console.warn('[ads] click tracking error:', err.message); }
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════
// ── SELF-SERVICE AD REQUESTS (brokers/inmobiliarias) ────────────
// ══════════════════════════════════════════════════════════════════

const { userAuth } = require('./auth');
const { notify: pushNotify } = require('./push');
const { createTransport } = require('./mailer');
const et = require('../utils/email-templates');
const _adMailer = createTransport();
const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora'];
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com';
const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';

// ── Ad pricing tiers ─────────────────────────────────────────────
const AD_PRICES = {
  banner:     { label: 'Banner',           price: 2900,  duration: 7 },  // $29
  card:       { label: 'Tarjeta (Feed)',   price: 4900,  duration: 7 },  // $49
  popup:      { label: 'Popup',            price: 7900,  duration: 7 },  // $79
  fullscreen: { label: 'Pantalla Completa',price: 9900,  duration: 7 },  // $99
};

// ── GET /api/ads/prices — public pricing info ────────────────────
router.get('/prices', (req, res) => {
  const prices = Object.entries(AD_PRICES).map(([type, p]) => ({
    type, label: p.label, price: p.price / 100, duration: p.duration,
  }));
  res.json({ prices });
});

// ── POST /api/ads/checkout — create Stripe checkout for ad ───────
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? require('stripe')(stripeKey) : null;

router.post('/checkout', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes e inmobiliarias pueden comprar anuncios' });
  if (!stripe)
    return res.status(503).json({ error: 'Sistema de pagos no configurado' });

  const { title, description, image_url, target_url, ad_type, placement, start_date, end_date } = req.body;
  if (!title || !image_url)
    return res.status(400).json({ error: 'Título e imagen son requeridos' });

  const tier = AD_PRICES[ad_type] || AD_PRICES.fullscreen;

  // Create the ad record as unpaid
  const adId = uuidv4();
  const ad = {
    id: adId, title,
    advertiser: user.companyName || user.agencyName || user.name || '',
    description: (description || '').slice(0, 500), image_url,
    target_url: target_url || '', ad_type: ad_type || 'fullscreen',
    placement: placement || 'feed', budget: tier.price / 100,
    priority: 5, audience: 'todos', cooldown_hours: 2,
    is_active: false, start_date: start_date || null, end_date: end_date || null,
    impressions: 0, clicks: 0, created_at: new Date().toISOString(),
    requested_by: req.user.sub, request_status: 'pending_payment',
    requester_name: user.name || '', requester_email: user.email || '',
  };

  try {
    const cols = Object.keys(ad);
    const vals = cols.map(c => ad[c]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    await store.pool.query(
      `INSERT INTO ads (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`, vals
    );

    // Create Stripe Checkout Session (one-time payment)
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: `Anuncio ${tier.label} — ${tier.duration} días`,
            description: title.slice(0, 100),
          },
          unit_amount: tier.price,
        },
        quantity: 1,
      }],
      mode: 'payment',
      metadata: { ad_id: adId, user_id: req.user.sub, ad_type },
      success_url: `${BASE_URL}/broker#ad-request?paid=1`,
      cancel_url: `${BASE_URL}/broker#ad-request?cancelled=1`,
    });

    res.json({ url: session.url, ad_id: adId });
  } catch (err) {
    console.error('[ads] Checkout error:', err.message);
    res.status(500).json({ error: 'Error al crear sesión de pago' });
  }
});

// ── POST /api/ads/request — REMOVED ─────────────────────────────────
// Previously created an ad with status='pending_approval' WITHOUT
// charging the advertiser. Both web entry points (broker.html and
// campanas.html) correctly used /checkout (Stripe-gated), but the
// unused /request route was a wide-open bypass: any pro-role token
// could POST here to submit an ad for free, get admin approval,
// and run it without payment. Removed to close the gap. If a
// comped/manual ad is ever needed, it should go through an
// admin-only endpoint that records the comp reason for audit.

// ── GET /api/ads/my-requests — broker sees their submitted ads ──
router.get('/my-requests', userAuth, async (req, res) => {
  try {
    const result = await store.pool.query(
      'SELECT * FROM ads WHERE requested_by = $1 ORDER BY created_at DESC',
      [req.user.sub]
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// ── GET /api/ads/pending — admin sees pending requests ───────────
router.get('/pending', adminSessionAuth, async (req, res) => {
  try {
    const result = await store.pool.query(
      "SELECT * FROM ads WHERE request_status = 'pending_approval' ORDER BY created_at DESC"
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// ── POST /api/ads/:id/approve — admin approves ad request ────────
router.post('/:id/approve', adminSessionAuth, async (req, res) => {
  try {
    const result = await store.pool.query(
      `UPDATE ads SET request_status = 'approved', is_active = true WHERE id = $1 AND request_status = 'pending_approval' RETURNING *`,
      [req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const ad = result.rows[0];

    // Notify the requester
    if (ad.requested_by) {
      pushNotify(ad.requested_by, {
        type: 'status_changed',
        title: 'Anuncio aprobado ✓',
        body: `Tu anuncio "${ad.title}" ha sido aprobado y está activo`,
        url: '/broker',
      });
    }
    res.json({ ok: true, ad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/ads/:id/reject — admin rejects ad request ─────────
router.post('/:id/reject', adminSessionAuth, async (req, res) => {
  const reason = (req.body?.reason || '').trim().slice(0, 500);
  try {
    const result = await store.pool.query(
      `UPDATE ads SET request_status = 'rejected', rejection_reason = $1 WHERE id = $2 AND request_status = 'pending_approval' RETURNING *`,
      [reason, req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Solicitud no encontrada' });
    const ad = result.rows[0];

    if (ad.requested_by) {
      pushNotify(ad.requested_by, {
        type: 'status_changed',
        title: 'Anuncio rechazado',
        body: reason ? `Tu anuncio "${ad.title}" fue rechazado: ${reason}` : `Tu anuncio "${ad.title}" fue rechazado`,
        url: '/broker',
      });
    }
    res.json({ ok: true, ad });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
