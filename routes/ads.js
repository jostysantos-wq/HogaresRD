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

// ── GET /api/ads/active  (public — used by the mobile app) ─────
router.get('/active', async (req, res) => {
  try {
    const now = new Date().toISOString();
    const result = await store.pool.query(
      `SELECT * FROM ads WHERE is_active = true
       AND (start_date IS NULL OR start_date <= $1)
       AND (end_date IS NULL OR end_date >= $1)`,
      [now]
    );
    res.json(result.rows);
  } catch (err) {
    res.json([]);
  }
});

// ── POST /api/ads/upload  (admin — upload ad image) ────────────
router.post('/upload', adminSessionAuth, adUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
  try {
    const fname = `ad_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webp`;
    await sharp(req.file.buffer)
      .resize(1200, 628, { fit: 'cover' })
      .webp({ quality: 85 })
      .toFile(path.join(ADS_UPLOAD_DIR, fname));
    res.json({ url: `/uploads/ads/${fname}` });
  } catch (e) {
    res.status(500).json({ error: 'Error al procesar imagen: ' + e.message });
  }
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
          ad_type, placement, description, budget, priority, audience } = req.body;
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

// ── PUT /api/ads/:id  (admin — update / toggle) ────────────────
router.put('/:id', adminSessionAuth, async (req, res) => {
  try {
    // Get current ad
    const current = await store.pool.query('SELECT * FROM ads WHERE id = $1', [req.params.id]);
    if (!current.rows.length) return res.status(404).json({ error: 'Not found' });

    const updated = { ...current.rows[0], ...req.body, id: req.params.id };
    const cols = Object.keys(updated).filter(c => c !== 'id');
    const sets = cols.map((c, i) => `"${c}" = $${i + 1}`).join(', ');
    const vals = cols.map(c => updated[c]);
    vals.push(req.params.id);

    await store.pool.query(`UPDATE ads SET ${sets} WHERE id = $${vals.length}`, vals);
    res.json(updated);
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
  } catch {}
  res.json({ ok: true });
});

// ── POST /api/ads/:id/click  (public — mobile tracking) ───────
router.post('/:id/click', async (req, res) => {
  try {
    await store.pool.query('UPDATE ads SET clicks = clicks + 1 WHERE id = $1', [req.params.id]);
  } catch {}
  res.json({ ok: true });
});

module.exports = router;
