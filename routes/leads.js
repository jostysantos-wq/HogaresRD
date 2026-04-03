const express  = require('express');
const fs       = require('fs');
const path     = require('path');
const crypto   = require('crypto');

const router     = express.Router();
const LEADS_FILE = path.join(__dirname, '../data/leads.json');
const { adminSessionAuth } = require('./admin-auth');

const VALID_STATUSES = ['pendiente', 'en_proceso', 'comprado', 'no_comprado'];

// All routes in this file require an admin session
router.use(adminSessionAuth);

// ── helpers ────────────────────────────────────────────────────
if (!fs.existsSync(LEADS_FILE)) fs.writeFileSync(LEADS_FILE, '[]');

function readLeads()      { return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8')); }
function writeLeads(data) { fs.writeFileSync(LEADS_FILE, JSON.stringify(data, null, 2)); }

// ── POST /api/leads  (public — user submits application) ───────
router.post('/', (req, res) => {
  const {
    listing_id, listing_title, listing_price, listing_type,
    agencies,
    name, phone, email,
    budget, timeline, intent, notes,
    financing, pre_approved, contact_method
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
    financing:     financing     || '',
    pre_approved:  pre_approved === true || pre_approved === 'true' ? true : false,
    contact_method: contact_method || 'whatsapp',
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

  const { status } = req.query;
  let leads = readLeads();
  if (status && VALID_STATUSES.includes(status)) {
    leads = leads.filter(l => l.status === status);
  }
  res.json(leads);
});

// ── GET /api/leads/export  (admin — CSV download) ──────────────
router.get('/export', (req, res) => {

  const { status } = req.query;
  let leads = readLeads();
  if (status && VALID_STATUSES.includes(status)) {
    leads = leads.filter(l => l.status === status);
  }

  const headers = ['ID','Propiedad','Precio','Tipo','Nombre','Teléfono','Email','Presupuesto','Plazo','Intención','Financiamiento','Pre-aprobado','Contacto Preferido','Estado','Notas','Fecha'];
  const rows = leads.map(l => [
    l.id, l.listing_title, l.listing_price, l.listing_type,
    l.name, l.phone, l.email, l.budget, l.timeline, l.intent,
    l.financing || '', l.pre_approved ? 'Sí' : 'No', l.contact_method || '',
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

  const leads = readLeads();
  const idx   = leads.findIndex(l => l.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  leads.splice(idx, 1);
  writeLeads(leads);
  res.json({ ok: true });
});

module.exports = router;
