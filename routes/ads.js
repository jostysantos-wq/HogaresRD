const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');
const multer   = require('multer');
const sharp    = require('sharp');
function uuidv4() { return crypto.randomUUID(); }

const router   = express.Router();
const ADS_FILE = path.join(__dirname, '../data/ads.json');
const { adminSessionAuth } = require('./admin-auth');

// ── Image upload config ───────────────────────────────────────
const ADS_UPLOAD_DIR = path.join(__dirname, '../public/uploads/ads');
if (!fs.existsSync(ADS_UPLOAD_DIR)) fs.mkdirSync(ADS_UPLOAD_DIR, { recursive: true });

const adUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (_, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Solo JPG, PNG, WEBP o GIF'));
  },
});

// ── helpers ────────────────────────────────────────────────────
if (!fs.existsSync(ADS_FILE)) fs.writeFileSync(ADS_FILE, '[]');

function readAds()       { return JSON.parse(fs.readFileSync(ADS_FILE, 'utf8')); }
function writeAds(data)  { fs.writeFileSync(ADS_FILE, JSON.stringify(data, null, 2)); }

// ── GET /api/ads/active  (public — used by the mobile app) ─────
router.get('/active', (req, res) => {
  const now = new Date();
  const active = readAds().filter(ad => {
    if (!ad.is_active) return false;
    if (ad.start_date && new Date(ad.start_date) > now) return false;
    if (ad.end_date   && new Date(ad.end_date)   < now) return false;
    return true;
  });
  res.json(active);
});

// ── GET /api/ads  (admin) ──────────────────────────────────────
router.get('/', adminSessionAuth, (req, res) => {
  res.json(readAds());
});

// ── POST /api/ads/upload  (admin — upload ad image) ────────────
router.post('/upload', adminSessionAuth, adUpload.single('image'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No se recibió ninguna imagen' });
  try {
    const fname = `ad_${Date.now()}_${crypto.randomBytes(4).toString('hex')}.webp`;
    await sharp(req.file.buffer)
      .resize(1200, 628, { fit: 'cover' }) // standard ad ratio
      .webp({ quality: 85 })
      .toFile(path.join(ADS_UPLOAD_DIR, fname));
    res.json({ url: `/uploads/ads/${fname}` });
  } catch (e) {
    res.status(500).json({ error: 'Error al procesar imagen: ' + e.message });
  }
});

// ── POST /api/ads  (admin — create) ───────────────────────────
router.post('/', adminSessionAuth, (req, res) => {
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
    ad_type:     ad_type || 'fullscreen',  // banner, card, fullscreen
    placement:   placement || 'feed',       // feed, sidebar, listing-page
    budget:      budget ? Number(budget) : null,
    priority:    Math.min(10, Math.max(1, Number(priority) || 5)),
    audience:    audience || 'todos',       // compradores, arrendatarios, agentes, todos
    is_active:   false,
    start_date:  start_date || null,
    end_date:    end_date   || null,
    impressions: 0,
    clicks:      0,
    created_at:  new Date().toISOString()
  };
  const ads = readAds();
  ads.push(ad);
  writeAds(ads);
  res.status(201).json(ad);
});

// ── PUT /api/ads/:id  (admin — update / toggle) ────────────────
router.put('/:id', adminSessionAuth, (req, res) => {
  const ads = readAds();
  const idx = ads.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  ads[idx] = { ...ads[idx], ...req.body, id: ads[idx].id };
  writeAds(ads);
  res.json(ads[idx]);
});

// ── DELETE /api/ads/:id  (admin) ───────────────────────────────
router.delete('/:id', adminSessionAuth, (req, res) => {
  const ads = readAds();
  const idx = ads.findIndex(a => a.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  ads.splice(idx, 1);
  writeAds(ads);
  res.json({ ok: true });
});

// ── POST /api/ads/:id/impression  (public — mobile tracking) ──
router.post('/:id/impression', (req, res) => {
  const ads = readAds();
  const idx = ads.findIndex(a => a.id === req.params.id);
  if (idx !== -1) {
    ads[idx].impressions = (ads[idx].impressions || 0) + 1;
    writeAds(ads);
  }
  res.json({ ok: true });
});

// ── POST /api/ads/:id/click  (public — mobile tracking) ───────
router.post('/:id/click', (req, res) => {
  const ads = readAds();
  const idx = ads.findIndex(a => a.id === req.params.id);
  if (idx !== -1) {
    ads[idx].clicks = (ads[idx].clicks || 0) + 1;
    writeAds(ads);
  }
  res.json({ ok: true });
});

module.exports = router;
