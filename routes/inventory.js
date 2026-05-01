const express    = require('express');
const crypto     = require('crypto');
const store      = require('./store');
const { userAuth } = require('./auth');
const { verifyJwtAcceptingPrev } = require('../utils/jwt');

const router = express.Router();

const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora'];
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
  if (!token || !process.env.JWT_SECRET) return null;
  let payload;
  try {
    payload = verifyJwtAcceptingPrev(token);
  } catch {
    return null;
  }
  if (payload.jti && store.isTokenRevoked(payload.jti)) return null;
  return store.getUserById(payload.sub);
}

/** Check if user is affiliated to a listing (via agencies array) — used
 * for READ access. Anyone listed as an agency on the listing, plus team
 * members of the owning inmobiliaria/constructora, can see buyer info. */
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

/** D4: write-protection. Only the developer (constructora role) who
 * created the listing can mutate its unit inventory. Brokers, agencies,
 * and inmobiliaria-team members are read-only — they were previously
 * granted write access through `isAffiliated` which was far too lax. */
function isOwner(user, listing) {
  if (!user || !listing) return false;
  return user.role === 'constructora' && user.id === listing.creator_user_id;
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
// Constructora owner adds a unit to inventory (D4: owner-only write).
router.post('/:listingId/units', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias pueden gestionar inventario' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  if (!isOwner(user, listing))
    return res.status(403).json({ error: 'Solo el desarrollador propietario puede modificar el inventario.', code: 'not_owner' });

  const { unit: payload, error: vErr } = validateUnitPayload(req.body);
  if (vErr) return res.status(400).json({ error: vErr });

  try {
    const result = await store.withTransaction(async (client) => {
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
      await store.saveListing(fresh, client);
      return { ok: true, unit, summary: inventorySummary(inventory) };
    });
    res.status(201).json(result);
  } catch (err) {
    if (err && err.status && err.status !== 500) {
      return res.status(err.status).json({ error: err.message || 'Error' });
    }
    console.error('[inventory] tx failed:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el cambio. Inténtalo de nuevo.' });
  }
});

// ── POST /api/inventory/:listingId/units/batch ────────────────────────────
// Add multiple units at once (for initial setup)
router.post('/:listingId/units/batch', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isOwner(user, listing))
    return res.status(403).json({ error: 'Solo el desarrollador propietario puede modificar el inventario.', code: 'not_owner' });

  const { units } = req.body;
  if (!Array.isArray(units) || !units.length)
    return res.status(400).json({ error: 'Se requiere un array de unidades' });
  if (units.length > MAX_BATCH)
    return res.status(400).json({ error: `Maximo ${MAX_BATCH} unidades por lote` });

  try {
    const result = await store.withTransaction(async (client) => {
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
      await store.saveListing(fresh, client);
      return { ok: true, added, skipped, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    console.error('[inventory] tx failed:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el cambio. Inténtalo de nuevo.' });
  }
});

// ── DELETE /api/inventory/:listingId/units/:unitId ────────────────────────
// Remove a unit (only if available)
router.delete('/:listingId/units/:unitId', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isOwner(user, listing))
    return res.status(403).json({ error: 'Solo el desarrollador propietario puede modificar el inventario.', code: 'not_owner' });

  try {
    const result = await store.withTransaction(async (client) => {
      const fresh = store.getListingById(req.params.listingId);
      const inventory = fresh.unit_inventory || [];
      const idx = inventory.findIndex(u => u.id === req.params.unitId);
      if (idx === -1) throw Object.assign(new Error('Unidad no encontrada'), { status: 404 });
      if (inventory[idx].status !== 'available')
        throw Object.assign(new Error('Solo se pueden eliminar unidades disponibles'), { status: 400 });
      inventory.splice(idx, 1);
      fresh.unit_inventory    = inventory;
      fresh.units_available   = inventory.filter(u => u.status === 'available').length;
      await store.saveListing(fresh, client);
      return { ok: true, success: true, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    if (err && err.status && err.status !== 500) {
      return res.status(err.status).json({ error: err.message || 'Error' });
    }
    console.error('[inventory] tx failed:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el cambio. Inténtalo de nuevo.' });
  }
});

// ── POST /api/inventory/:listingId/units/:unitId/assign ───────────────────
// Assign a unit to an application
router.post('/:listingId/units/:unitId/assign', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isOwner(user, listing))
    return res.status(403).json({ error: 'Solo el desarrollador propietario puede modificar el inventario.', code: 'not_owner' });

  const { applicationId } = req.body;
  if (!applicationId) return res.status(400).json({ error: 'applicationId requerido' });

  try {
    const result = await store.withTransaction(async (client) => {
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
      await store.saveListing(fresh, client);

      app.assigned_unit = { unitId: unit.id, unitLabel: unit.label, unitType: unit.type };
      await store.saveApplication(app, client);

      return { ok: true, unit, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    if (err && err.status && err.status !== 500) {
      return res.status(err.status).json({ error: err.message || 'Error' });
    }
    console.error('[inventory] tx failed:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el cambio. Inténtalo de nuevo.' });
  }
});

// ── POST /api/inventory/:listingId/units/:unitId/release ──────────────────
// Release a unit back to available
router.post('/:listingId/units/:unitId/release', userAuth, async (req, res) => {
  const user = store.getUserById(req.user.sub);
  if (!user || !PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias' });

  const listing = store.getListingById(req.params.listingId);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });
  if (!isOwner(user, listing))
    return res.status(403).json({ error: 'Solo el desarrollador propietario puede modificar el inventario.', code: 'not_owner' });

  try {
    const result = await store.withTransaction(async (client) => {
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
          await store.saveApplication(app, client);
        }
      }

      unit.status = 'available';
      unit.applicationId = null;
      unit.clientName = null;

      fresh.unit_inventory    = inventory;
      fresh.units_available   = inventory.filter(u => u.status === 'available').length;
      await store.saveListing(fresh, client);
      return { ok: true, unit, summary: inventorySummary(inventory) };
    });
    res.json(result);
  } catch (err) {
    if (err && err.status && err.status !== 500) {
      return res.status(err.status).json({ error: err.message || 'Error' });
    }
    console.error('[inventory] tx failed:', err.message);
    res.status(500).json({ error: 'No se pudo guardar el cambio. Inténtalo de nuevo.' });
  }
});

// ── GET /api/inventory/by-owner/:userId ───────────────────────────────────
// D5: project-level inventory aggregates for a constructora owner.
// Used by the constructora dashboard. Owner-only (or admin).
router.get('/by-owner/:userId', userAuth, (req, res) => {
  const caller = store.getUserById(req.user.sub);
  if (!caller) return res.status(401).json({ error: 'No autenticado' });

  const ownerId = req.params.userId;
  const isSelf  = caller.id === ownerId;
  const isAdmin = caller.role === 'admin';
  if (!isSelf && !isAdmin) {
    return res.status(403).json({ error: 'Solo el propietario puede ver estos datos.' });
  }

  const allListings = store.getListings ? store.getListings() : [];
  const listings = allListings.filter(l => l && l.creator_user_id === ownerId);

  let totalUnits = 0, available = 0, reserved = 0, sold = 0;
  const byListing = [];
  const brokerStats = new Map(); // user_id → { name, units_sold, applications_completed }

  for (const listing of listings) {
    const inv = Array.isArray(listing.unit_inventory) ? listing.unit_inventory : [];
    const lAvailable = inv.filter(u => u.status === 'available').length;
    const lReserved  = inv.filter(u => u.status === 'reserved').length;
    const lSold      = inv.filter(u => u.status === 'sold').length;
    totalUnits += inv.length;
    available  += lAvailable;
    reserved   += lReserved;
    sold       += lSold;
    byListing.push({
      listing_id: listing.id,
      title:      listing.title || '',
      total:      inv.length,
      available:  lAvailable,
      reserved:   lReserved,
      sold:       lSold,
    });
  }

  // byBroker + byMonth come from completed applications on the owner's listings.
  // Cheap scan — small per-owner volume, no need for a DB aggregation here.
  const allApps = store.getApplications ? store.getApplications() : [];
  const ownerListingIds = new Set(listings.map(l => l.id));
  const completedApps   = allApps.filter(a =>
    a.status === 'completado' && ownerListingIds.has(a.listing_id)
  );

  for (const app of completedApps) {
    const brokerId = app.broker?.user_id;
    if (!brokerId) continue;
    if (!brokerStats.has(brokerId)) {
      brokerStats.set(brokerId, {
        broker_user_id:         brokerId,
        broker_name:            app.broker?.name || '',
        units_sold:             0,
        applications_completed: 0,
      });
    }
    const s = brokerStats.get(brokerId);
    s.applications_completed += 1;
    if (app.assigned_unit?.unitId) s.units_sold += 1;
  }

  // byMonth — last 12 months of sold/reserved activity
  const months = {};
  const now    = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    months[ym] = { ym, sold: 0, reserved: 0 };
  }
  for (const app of completedApps) {
    if (!app.updated_at) continue;
    const ym = app.updated_at.slice(0, 7);
    if (months[ym]) months[ym].sold += 1;
  }
  // Reserved this month: best-effort count from current inventory (point-in-time)
  // — we can't reconstruct the historical reservation timeline from the JSON
  // blob, so just attribute current `reserved` units to the current month.
  const currentYm = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  if (months[currentYm]) months[currentYm].reserved = reserved;

  res.json({
    totalListings: listings.length,
    totalUnits, available, reserved, sold,
    byListing,
    byBroker: Array.from(brokerStats.values()).sort((a, b) => b.units_sold - a.units_sold),
    byMonth:  Object.values(months),
  });
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
