const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const router     = express.Router();
const LEADS_FILE = path.join(__dirname, '../data/leads.json');
const ADMIN_KEY  = process.env.ADMIN_KEY || 'hogaresrd-admin-2026';

const VALID_STATUSES = ['pendiente', 'en_proceso', 'comprado', 'no_comprado'];

// ── helpers ────────────────────────────────────────────────────
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]');

function readLeads()      { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
function writeLeads(data) { fs.writeFileSync(LEADS_FILE, JSON.stringify(data, null, 2)); }
function isAdmin(req)     {
  return req.headers['x-admin-key'] === ADMIN_KEY ||
         req.query._key === ADMIN_KEY;
}

// ── POST /api/leads  (public — user submits application) ───────
router.post('/', (req, res) => {
  const {
    listing_id, listing_title, listing_price, listing_type,
    agencies,
    name, phone, email,
    budget, timeline, intent, notes
  } = req.body;

  if (!name || !phone || !listing_id) {
    return res.status(400).json({ error: 'name, phone y listing_id son requeridos' });
  }

  const lead = {
    id:            crypto.randomUUID(),
    listing_id:    listing_id    || '',
    listing_title: listing_title || '',
    listing_price: listing_price || '',
    listing_type:  listing_type  || '',
    agencies:      agencies      || [],
    name:          name.trim(),
    phone:         phone.trim(),
    email:         (email || '').trim(),
    budget:        (budget || '').trim(),
    timeline:      (timeline || '').trim(),
    intent:        intent        || 'comprar',
    notes:         (notes || '').trim(),
    status:        'pendiente',
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString()
  };

  const leads = readLeads();
  leads.unshift(lead);
  writeLeads(leads);
  res.status(201).json({ ok: true, id: lead.id });
});

// ── GET /api/leads  (admin) ────────────────────────────────────
router.get('/', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { status } = req.query;
  let leads = readLeads();
  if (status && VALID_STATUSES.includes(status)) {
    leads = leads.filter(l => l.status === status);
  }
  res.json(leads);
});

// ── GET /api/leads/export  (admin — CSV download) ──────────────
router.get('/export', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const { status } = req.query;
  let leads = readLeads();
  if (status && VALID_STATUSES.includes(status)) {
    leads = leads.filter(l => l.status === status);
  }

  const headers = ['ID','Propiedad','Precio','Tipo','Nombre','Teléfono','Email','Presupuesto','Plazo','Intención','Estado','Notas','Fecha'];
  const rows = leads.map(l => [
    l.id, l.listing_title, l.listing_price, l.listing_type,
    l.name, l.phone, l.email, l.budget, l.timeline, l.intent,
    l.status, l.notes,
    new Date(l.created_at).toLocaleDateString('es-DO')
  ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));

  const csv = [headers.join(','), ...rows].join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="leads-hogaresrd.csv"');
  res.send(csv);
});

// ── PUT /api/leads/:id  (admin — update status / notes) ────────
router.put('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const leads = readLeads();
  const idx   = leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });

  const { status, notes } = req.body;
  if (status && !VALID_STATUSES.includes(status)) {
    return res.status(400).json({ error: 'Invalid status' });
  }
  if (status) leads[idx].status = status;
  if (notes !== undefined) leads[idx].notes = notes;
  leads[idx].updated_at = new Date().toISOString();

  writeLeads(leads);
  res.json(leads[idx]);
});

// ── DELETE /api/leads/:id  (admin) ─────────────────────────────
router.delete('/:id', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Unauthorized' });
  const leads = readLeads();
  const idx   = leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  leads.splice(idx, 1);
  writeLeads(leads);
  res.json({ ok: true });
});

module.exports = router;
