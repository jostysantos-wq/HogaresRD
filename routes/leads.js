const express  = require('express');
const crypto   = require('crypto');
const store    = require('./store');

const router     = express.Router();
const { adminSessionAuth } = require('./admin-auth');

const VALID_STATUSES = ['pendiente', 'en_proceso', 'comprado', 'no_comprado'];

// All routes except POST / require admin session
// POST / is public (moved before adminSessionAuth middleware)

// ── POST /api/leads  (public — user submits lead) ────────────
const rateLimit = require('express-rate-limit');
const leadLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 5, standardHeaders: false, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intenta de nuevo en una hora.' } });
router.post('/', leadLimiter, (req, res) => {
  const {
    listing_id, listing_title, listing_price, listing_type,
    agencies,
    name, phone, email,
    budget, timeline, intent, notes,
    financing, pre_approved, contact_method,
    ref_token: bodyRefToken
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
    agencies:      JSON.stringify(agencies || []),
    name:          name.trim(),
    phone:         phone.trim(),
    email:         (email || '').trim(),
    budget:        (budget || '').trim(),
    timeline:      (timeline || '').trim(),
    intent:        intent        || 'comprar',
    financing:     financing     || '',
    pre_approved:  pre_approved === true || pre_approved === 'true' ? 1 : 0,
    contact_method: contact_method || 'whatsapp',
    notes:         (notes || '').trim(),
    status:        'pendiente',
    ref_token:     bodyRefToken || req.cookies?.hrd_ref || null,
    referred_by:   null,
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString()
  };

  // Resolve referring agent
  if (lead.ref_token) {
    const agent = store.getUserByRefToken(lead.ref_token);
    if (agent) lead.referred_by = agent.id;
  }

  const cols = Object.keys(lead);
  const vals = cols.map(c => lead[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  store.pool.query(
    `INSERT INTO leads (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
    vals
  ).catch(err => console.error('[leads] Insert error:', err.message));

  res.status(201).json({ ok: true, id: lead.id });

  // Start cascade if enabled and not a referral
  const cascadeEngine = require('./cascade-engine');
  if (cascadeEngine.isEnabled() && !lead.referred_by && lead.listing_id) {
    cascadeEngine.startCascade('lead', lead.id, lead.listing_id, {
      name: lead.name || '', phone: lead.phone || '', email: lead.email || '',
    });
  }
});

// Admin routes below
router.use(adminSessionAuth);

// ── GET /api/leads  (admin) ────────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM leads ORDER BY created_at DESC';
    const params = [];
    if (status && VALID_STATUSES.includes(status)) {
      sql = 'SELECT * FROM leads WHERE status = $1 ORDER BY created_at DESC';
      params.push(status);
    }
    const result = await store.pool.query(sql, params);
    const leads = result.rows.map(r => {
      if (typeof r.agencies === 'string') r.agencies = JSON.parse(r.agencies);
      return r;
    });
    res.json(leads);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/leads/export  (admin — CSV) ──────────────────────
router.get('/export', async (req, res) => {
  try {
    const { status } = req.query;
    let sql = 'SELECT * FROM leads ORDER BY created_at DESC';
    const params = [];
    if (status && VALID_STATUSES.includes(status)) {
      sql = 'SELECT * FROM leads WHERE status = $1 ORDER BY created_at DESC';
      params.push(status);
    }
    const result = await store.pool.query(sql, params);
    const leads = result.rows;

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
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/leads/:id  (admin — update status / notes) ────────
router.put('/:id', async (req, res) => {
  try {
    const { status, notes } = req.body;
    if (status && !VALID_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    const updates = [];
    const params = [];
    let idx = 1;
    if (status) { updates.push(`status = $${idx++}`); params.push(status); }
    if (notes !== undefined) { updates.push(`notes = $${idx++}`); params.push(notes); }
    updates.push(`updated_at = $${idx++}`); params.push(new Date().toISOString());
    params.push(req.params.id);

    const result = await store.pool.query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = $${idx} RETURNING *`,
      params
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/leads/:id  (admin) ─────────────────────────────
router.delete('/:id', async (req, res) => {
  try {
    const result = await store.pool.query('DELETE FROM leads WHERE id = $1', [req.params.id]);
    if (result.rowCount === 0) return res.status(404).json({ error: 'Not found' });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
