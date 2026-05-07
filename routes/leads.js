const express  = require('express');
const crypto   = require('crypto');
const store    = require('./store');
const { isReferrerAffiliatedWithListing } = require('../utils/affiliation');

// Short-window dedup: a double-click on the inquiry form would otherwise
// create two leads, fire two cascades, and pop two notifications for the
// same agents. Key on (listing_id, phone, 60s) — the same shape
// applications use. In-memory is fine for our PM2 fork-mode topology
// since all requests hit the same process.
const _recentLeadKeys = new Map(); // key → expiresAt ms
function _claimLeadKey(key) {
  const now = Date.now();
  for (const [k, exp] of _recentLeadKeys) if (exp <= now) _recentLeadKeys.delete(k);
  if (_recentLeadKeys.has(key)) return false;
  _recentLeadKeys.set(key, now + 60 * 1000);
  return true;
}

const router     = express.Router();
const { adminSessionAuth } = require('./admin-auth');

const VALID_STATUSES = ['pendiente', 'en_proceso', 'comprado', 'no_comprado'];

// All routes except POST / require admin session
// POST / is public (moved before adminSessionAuth middleware)

// ── POST /api/leads  (public — user submits lead) ────────────
const rateLimit = require('express-rate-limit');
const { sanitizeShortText, sanitizeLongText, sanitizeAgencies } = require('../utils/sanitize');
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

  // Dedup a double-click: same listing + same phone within 60s gets
  // the same response shape as the original, no second cascade.
  const dedupKey = `${listing_id}|${String(phone).trim().toLowerCase()}`;
  if (!_claimLeadKey(dedupKey)) {
    return res.status(202).json({ ok: true, duplicate: true, accepted: true });
  }

  // Round-2 audit fix: every text field below originates from a public
  // form (anyone can POST to /api/leads). Strip < > + control chars
  // before storage so the admin renderer can never run a stored XSS,
  // and clamp lengths so leads.json can't be inflated to MB-scale.
  const lead = {
    id:            crypto.randomUUID(),
    listing_id:    sanitizeShortText(listing_id, 50),
    listing_title: sanitizeShortText(listing_title, 200),
    listing_price: sanitizeShortText(String(listing_price || ''), 20),
    listing_type:  sanitizeShortText(listing_type, 40),
    agencies:      JSON.stringify(sanitizeAgencies(agencies)),
    name:          sanitizeShortText(name, 120),
    phone:         sanitizeShortText(phone, 40),
    email:         sanitizeShortText(email, 120),
    budget:        sanitizeShortText(String(budget || ''), 40),
    timeline:      sanitizeShortText(timeline, 60),
    intent:        sanitizeShortText(intent || 'comprar', 30),
    financing:     sanitizeShortText(financing, 30),
    pre_approved:  pre_approved === true || pre_approved === 'true' ? 1 : 0,
    contact_method: sanitizeShortText(contact_method || 'whatsapp', 30),
    notes:         sanitizeLongText(notes, 2000),
    status:        'pendiente',
    ref_token:     bodyRefToken || req.cookies?.hrd_ref || null,
    referred_by:   null,
    created_at:    new Date().toISOString(),
    updated_at:    new Date().toISOString()
  };

  // Resolve referring agent or org (inmobiliaria/constructora).
  //
  // Routing policy mirrors the application flow (Option B): only an
  // affiliated referrer can take direct assignment / org-scoped cascade.
  // An outside agent's general ref link DOES record `referred_by` for
  // analytics, but the lead falls through to normal cascade so the
  // listing's actual broker gets it. This prevents lead theft via
  // generic affiliate links on listings the referrer doesn't own.
  let refUser = null;
  let orgScope = null;
  let refAffiliated = false;
  if (lead.ref_token) {
    refUser = store.getUserByRefToken(lead.ref_token);
    if (refUser) {
      lead.referred_by = refUser.id;
      const refRole  = (refUser.role || '').toLowerCase();
      const listing  = store.getListingById(lead.listing_id);
      refAffiliated  = listing ? isReferrerAffiliatedWithListing(refUser, listing) : false;
      if (refAffiliated && ['agency', 'broker'].includes(refRole)) {
        // Affiliated individual broker → direct assign, skip cascade.
        lead.status = 'en_proceso';
      } else if (refAffiliated && ['inmobiliaria', 'constructora'].includes(refRole)) {
        // Affiliated org → cascade scoped to that org's team.
        orgScope = refUser.id;
      }
      // Non-affiliated referrer falls through: `referred_by` stays
      // recorded for the agent's analytics, but cascade dispatches
      // normally so the listing's real team gets the inquiry.
    }
  }

  const cols = Object.keys(lead);
  const vals = cols.map(c => lead[c]);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
  store.pool.query(
    `INSERT INTO leads (${cols.map(c => `"${c}"`).join(', ')}) VALUES (${placeholders})`,
    vals
  ).catch(err => console.error('[leads] Insert error:', err.message));

  res.status(201).json({ ok: true, id: lead.id });

  // Start cascade if enabled
  // - Affiliated broker ref → skip cascade (direct assign via referred_by)
  // - Affiliated inmobiliaria ref → cascade scoped to that org's team
  // - Outside ref OR no ref → normal cascade
  const cascadeEngine = require('./cascade-engine');
  const skipCascade = refAffiliated && refUser && ['agency', 'broker'].includes((refUser.role || '').toLowerCase());
  if (cascadeEngine.isEnabled() && !skipCascade && lead.listing_id) {
    cascadeEngine.startCascade('lead', lead.id, lead.listing_id, {
      name: lead.name || '', phone: lead.phone || '', email: lead.email || '',
    }, orgScope);
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
      // Resolve referred_by to agent name for admin display
      if (r.referred_by) {
        const agent = store.getUserById(r.referred_by);
        r.agent_name = agent?.name || null;
        r.agent_email = agent?.email || null;
      }
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

// ── PUT /api/leads/:id/assign  (admin — assign agent to lead) ──
router.put('/:id/assign', async (req, res) => {
  try {
    const { agent_id } = req.body;
    if (!agent_id) return res.status(400).json({ error: 'agent_id requerido' });
    const agent = store.getUserById(agent_id);
    if (!agent) return res.status(404).json({ error: 'Agente no encontrado' });

    const result = await store.pool.query(
      `UPDATE leads SET referred_by = $1, status = CASE WHEN status = 'pendiente' THEN 'en_proceso' ELSE status END, updated_at = $2 WHERE id = $3 RETURNING *`,
      [agent_id, new Date().toISOString(), req.params.id]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Lead no encontrado' });

    // Notify the assigned agent
    const { notify: pushNotify } = require('./push');
    pushNotify(agent_id, {
      type: 'new_application',
      title: 'Nuevo lead asignado',
      body: `${result.rows[0].name} — ${result.rows[0].listing_title}`,
      url: '/broker',
    });

    const lead = result.rows[0];
    lead.agent_name = agent.name;
    lead.agent_email = agent.email;
    res.json(lead);
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
