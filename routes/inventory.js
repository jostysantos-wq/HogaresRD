const express    = require('express');
const crypto     = require('crypto');
const jwt        = require('jsonwebtoken');
const store      = require('./store');
const { userAuth } = require('./auth');

const router = express.Router();

const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora'];
const JWT_SECRET      = process.env.JWT_SECRET;
const JWT_SECRET_PREV = process.env.JWT_SECRET_PREV || null;
const COOKIE_NAME = 'hrdt';

function uid() { return 'unit_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// Field length caps — prevent DB bloat from malicious/buggy clients
const MAX_LABEL = 40;
const MAX_TYPE  = 80;
const MAX_FLOOR = 20;
const MAX_NOTES = 500;
const MAX_BATCH = 500;

/** Normalize + validate a unit payload. Returns {unit, error} — error is
 * null when valid. Trims + caps every string field. */
function validateUnitPayload(raw) {
  const label = (raw?.label || '').trim();
  if (!label) return { unit: null, error: 'La etiqueta de la unidad es requerida' };
  if (label.length > MAX_LABEL)
    return { unit: null, error: `La etiqueta no puede exceder ${MAX_LABEL} caracteres` };
  return {
    unit: {
      label,
      type:  (raw?.type  || '').trim().slice(0, MAX_TYPE),
      floor: (raw?.floor || '').trim().slice(0, MAX_FLOOR),
      notes: (raw?.notes || '').trim().slice(0, MAX_NOTES),
    },
    error: null,
  };
}

/** Try to identify the user from cookie/Bearer token. Returns null if not
 * authenticated — does NOT block the request. */
function getOptionalUser(req) {
  const cookieToken = req.cookies?.[COOKIE_NAME];
  const headerToken = (req.headers['authorization'] || '').replace('Bearer ', '').trim();
  const token = cookieToken || headerToken;
  if (!token || !JWT_SECRET) return null;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch {
    if (!JWT_SECRET_PREV) return null;
    try { payload = jwt.verify(token, JWT_SECRET_PREV); } catch { return null; }
  }
  if (payload.jti && store.isTokenRevoked(payload.jti)) return null;
  return store.getUserById(payload.sub);
}

/** Check if user is affiliated to a listing (via agencies array) */
function isAffiliated(user, listing) {
  if (!user || !listing.agencies || !Array.isArray(listing.agencies)) return false;
  // Direct match
  if (listing.agencies.some(a => a.user_id === user.id)) return true;
  // Inmobiliaria match — check if any of the listing's agents are under this inmobiliaria
  if (user.role === 'inmobiliaria' || user.role === 'constructora') {
    const teamIds = new Set(store.getUsersByInmobiliaria(user.id).map(b => b.id));
    teamIds.add(user.id);
    return listing.agencies.some(a => a.user_id && teamIds.has(a.user_id));
  }
  return false;
}

/** Strip buyer PII (clientName, clientEmail, clientPhone, applicationId)
 * from inventory units. Used when the caller isn't affiliated to the
 * listing — general public shouldn't see who bought what. */
function stripBuyerInfo(units) {
  return units.map(u => {
    const { clientName, clientEmail, clientPhone, applicationId, ...safe } = u;
    return safe;
  });
}

// ── GET /api/inventory/:listingId ─────────────────────────────────────────
// Public: returns the unit inventory for a listing. Only affiliated pros
// (broker/inmobiliaria/constructora) see buyer names + applicationIds;
// everyone else sees anonymized units (just status + label + floor).
router.get('/:listingId', (req, res) => {
  const listing = store.getListingById(req.params.listingId);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const units = listing.unit_inventory || [];
  const summary = {
    total:     units.length,
    available: units.filter(u => u.status === 'available').length,
    reserved:  units.filter(u => u.status === 'reserved').length,
    sold:      units.filter(u => u.status === 'sold').length,
  };

  const user = getOptionalUser(req);
  const canSeeBuyers = user && isAffiliated(user, listing);
  const inventory = canSeeBuyers ? units : stripBuyerInfo(units);

  res.json({ inventory, summary });
});

// ── POST /api/inventory/:listingId/units ──────────────────────────────────
// Broker/inmobiliaria adds a unit to inventory
router.post('/:listingId/units', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias pueden gestionar inventario' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  if (!isAffiliated(user, listing))
    return res.status(403).json({ error: 'No estas afiliado a esta propiedad' });

  const { unit: payload, error: vErr } = validateUnitPayload(req.body);
  if (vErr) return res.status(400).json({ error: vErr });

  try {
    const result = store.withTransaction(() => {
      // Re-read listing inside the tx to avoid stale state
      const fresh = store.getListingById(req.params.listingId);
      const inventory = fresh.unit_inventory || [];
      if (inventory.some(u => u.label.toLowerCase() === payload.label.toLowerCase())) {
        throw Object.assign(new Error(`La unidad "${payload.label}" ya existe`), { status: 400 });
      }
      const unit = {
        id:            uid(),
        ...payload,
        status:        'available',
        applicationId: null,
        clientName:    null,
        createdAt:     new Date().toISOString(),
      };
      inventory.push(unit);
      fresh.unit_inventory    = inventory;
      fresh.units_available   = inventory.filter(u => u.status === 'available').length;
      store.saveListing(fresh);
      return { unit, summary: inventorySummary(inventory) };
    });
    res.status(201).json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error' });
  }
});

// ── POST /api/inventory/:listingId/units/batch ────────────────────────────
// Add multiple units at once (for initial setup)
router.post('/:listingId/units/batch', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isAffiliated(user, listing))
    return res.status(403).json({ error: 'No estas afiliado a esta propiedad' });

  const { units } = req.body;
  if (!Array.isArray(units) || !units.length)
    return res.status(400).json({ error: 'Se requiere un array de unidades' });
  if (units.length > MAX_BATCH)
    return res.status(400).json({ error: `Maximo ${MAX_BATCH} unidades por lote` });

  try {
    const result = store.withTransaction(() => {
      const fresh = store.getListingById(req.params.listingId);
      const inventory = fresh.unit_inventory || [];
      const existingLabels = new Set(inventory.map(u => u.label.toLowerCase()));
      const added   = [];
      const skipped = [];

      units.forEach((raw, i) => {
        const { unit: payload, error: vErr } = validateUnitPayload(raw);
        if (vErr) {
          skipped.push({ index: i, label: raw?.label || '', reason: vErr });
          return;
        }
        if (existingLabels.has(payload.label.toLowerCase())) {
          skipped.push({ index: i, label: payload.label, reason: 'duplicado' });
          return;
        }
        const unit = {
          id:            uid(),
          ...payload,
          status:        'available',
          applicationId: null,
          clientName:    null,
          createdAt:     new Date().toISOString(),
        };
        inventory.push(unit);
        existingLabels.add(payload.label.toLowerCase());
        added.push(unit);
      });

      fresh.unit_inventory    = inventory;
      fresh.units_available   = inventory.filter(u => u.status === 'available').length;
      store.saveListing(fresh);
      return { added, skipped, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message || 'Error' });
  }
});

// ── DELETE /api/inventory/:listingId/units/:unitId ────────────────────────
// Remove a unit (only if available)
router.delete('/:listingId/units/:unitId', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isAffiliated(user, listing))
    return res.status(403).json({ error: 'No estas afiliado a esta propiedad' });

  try {
    const result = store.withTransaction(() => {
      const fresh = store.getListingById(req.params.listingId);
      const inventory = fresh.unit_inventory || [];
      const idx = inventory.findIndex(u => u.id === req.params.unitId);
      if (idx === -1) throw Object.assign(new Error('Unidad no encontrada'), { status: 404 });
      if (inventory[idx].status !== 'available')
        throw Object.assign(new Error('Solo se pueden eliminar unidades disponibles'), { status: 400 });
      inventory.splice(idx, 1);
      fresh.unit_inventory    = inventory;
      fresh.units_available   = inventory.filter(u => u.status === 'available').length;
      store.saveListing(fresh);
      return { success: true, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error' });
  }
});

// ── POST /api/inventory/:listingId/units/:unitId/assign ───────────────────
// Assign a unit to an application
router.post('/:listingId/units/:unitId/assign', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isAffiliated(user, listing))
    return res.status(403).json({ error: 'No estas afiliado a esta propiedad' });

  const { applicationId } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'applicationId requerido' });

  try {
    const result = store.withTransaction(() => {
      const app = store.getApplicationById(applicationId);
      if (!app) throw Object.assign(new Error('Aplicacion no encontrada'), { status: 404 });

      const fresh = store.getListingById(req.params.listingId);
      const inventory = fresh.unit_inventory || [];
      const unit = inventory.find(u => u.id === req.params.unitId);
      if (!unit) throw Object.assign(new Error('Unidad no encontrada'), { status: 404 });
      if (unit.status !== 'available')
        throw Object.assign(new Error(`Unidad "${unit.label}" no esta disponible (estado: ${unit.status})`), { status: 400 });

      // Release any previously assigned unit on this application
      if (app.assigned_unit?.unitId) {
        const prevUnit = inventory.find(u => u.id === app.assigned_unit.unitId);
        if (prevUnit && prevUnit.status === 'reserved') {
          prevUnit.status = 'available';
          prevUnit.applicationId = null;
          prevUnit.clientName = null;
        }
      }

      unit.status = 'reserved';
      unit.applicationId = applicationId;
      unit.clientName = app.client_name || app.client?.name || '';

      fresh.unit_inventory    = inventory;
      fresh.units_available   = inventory.filter(u => u.status === 'available').length;
      store.saveListing(fresh);

      app.assigned_unit = { unitId: unit.id, unitLabel: unit.label, unitType: unit.type };
      store.saveApplication(app);

      return { unit, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error' });
  }
});

// ── POST /api/inventory/:listingId/units/:unitId/release ──────────────────
// Release a unit back to available
router.post('/:listingId/units/:unitId/release', userAuth, (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isAffiliated(user, listing))
    return res.status(403).json({ error: 'No estas afiliado a esta propiedad' });

  try {
    const result = store.withTransaction(() => {
      const fresh = store.getListingById(req.params.listingId);
      const inventory = fresh.unit_inventory || [];
      const unit = inventory.find(u => u.id === req.params.unitId);
      if (!unit) throw Object.assign(new Error('Unidad no encontrada'), { status: 404 });
      if (unit.status === 'sold') {
        throw Object.assign(
          new Error('Unidades vendidas no pueden liberarse. Contacta a soporte para anular la venta.'),
          { status: 400 }
        );
      }

      if (unit.applicationId) {
        const app = store.getApplicationById(unit.applicationId);
        if (app) {
          app.assigned_unit = null;
          store.saveApplication(app);
        }
      }

      unit.status = 'available';
      unit.applicationId = null;
      unit.clientName = null;

      fresh.unit_inventory    = inventory;
      fresh.units_available   = inventory.filter(u => u.status === 'available').length;
      store.saveListing(fresh);
      return { unit, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message || 'Error' });
  }
});

// ── Helper ────────────────────────────────────────────────────────────────
function inventorySummary(inventory) {
  return {
    total:     inventory.length,
    available: inventory.filter(u => u.status === 'available').length,
    reserved:  inventory.filter(u => u.status === 'reserved').length,
    sold:      inventory.filter(u => u.status === 'sold').length,
  };
}

module.exports = router;
