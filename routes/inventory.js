const express    = require('express');
const crypto     = require('crypto');
const store      = require('./store');
const { userAuth } = require('./auth');

const router = express.Router();

const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora'];

function uid() { return 'unit_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

/** Check if user is affiliated to a listing (via agencies array) */
function isAffiliated(user, listing) {
  if (!listing.agencies || !Array.isArray(listing.agencies)) return false;
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

// ── GET /api/inventory/:listingId ─────────────────────────────────────────
// Public: returns the unit inventory for a listing
router.get('/:listingId', (req, res) => {
  const listing = store.getListingById(req.params.listingId);
  if (!listing || listing.status !== 'approved')
    return res.status(404).json({ error: 'Propiedad no encontrada' });

  const inventory = listing.unit_inventory || [];
  const summary = {
    total:     inventory.length,
    available: inventory.filter(u => u.status === 'available').length,
    reserved:  inventory.filter(u => u.status === 'reserved').length,
    sold:      inventory.filter(u => u.status === 'sold').length,
  };

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

  const { label, type, floor, notes } = req.body;
  if (!label || !label.trim())
    return res.status(400).json({ error: 'La etiqueta de la unidad es requerida' });

  // Check for duplicate label
  const inventory = listing.unit_inventory || [];
  if (inventory.some(u => u.label.toLowerCase() === label.trim().toLowerCase()))
    return res.status(400).json({ error: `La unidad "${label.trim()}" ya existe` });

  const unit = {
    id:            uid(),
    label:         label.trim(),
    type:          type?.trim() || '',
    floor:         floor?.trim() || '',
    notes:         notes?.trim() || '',
    status:        'available',
    applicationId: null,
    clientName:    null,
    createdAt:     new Date().toISOString(),
  };

  inventory.push(unit);
  listing.unit_inventory = inventory;

  // Update units_available count
  listing.units_available = inventory.filter(u => u.status === 'available').length;

  store.saveListing(listing);
  res.status(201).json({ unit, summary: inventorySummary(inventory) });
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

  const inventory = listing.unit_inventory || [];
  const existingLabels = new Set(inventory.map(u => u.label.toLowerCase()));
  const added = [];

  for (const u of units) {
    if (!u.label?.trim()) continue;
    const lbl = u.label.trim();
    if (existingLabels.has(lbl.toLowerCase())) continue;
    const unit = {
      id:            uid(),
      label:         lbl,
      type:          u.type?.trim() || '',
      floor:         u.floor?.trim() || '',
      notes:         u.notes?.trim() || '',
      status:        'available',
      applicationId: null,
      clientName:    null,
      createdAt:     new Date().toISOString(),
    };
    inventory.push(unit);
    existingLabels.add(lbl.toLowerCase());
    added.push(unit);
  }

  listing.unit_inventory = inventory;
  listing.units_available = inventory.filter(u => u.status === 'available').length;
  store.saveListing(listing);

  res.json({ added: added.length, summary: inventorySummary(inventory) });
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

  const inventory = listing.unit_inventory || [];
  const idx = inventory.findIndex(u => u.id === req.params.unitId);
  if (idx === -1) return res.status(404).json({ error: 'Unidad no encontrada' });
  if (inventory[idx].status !== 'available')
    return res.status(400).json({ error: 'Solo se pueden eliminar unidades disponibles' });

  inventory.splice(idx, 1);
  listing.unit_inventory = inventory;
  listing.units_available = inventory.filter(u => u.status === 'available').length;
  store.saveListing(listing);

  res.json({ success: true, summary: inventorySummary(inventory) });
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

  const app = store.getApplicationById(applicationId);
  if (!app) return res.status(404).json({ error: 'Aplicacion no encontrada' });

  const inventory = listing.unit_inventory || [];
  const unit = inventory.find(u => u.id === req.params.unitId);
  if (!unit) return res.status(404).json({ error: 'Unidad no encontrada' });
  if (unit.status !== 'available')
    return res.status(400).json({ error: `Unidad "${unit.label}" no esta disponible (estado: ${unit.status})` });

  // Release any previously assigned unit on this application
  if (app.assigned_unit?.unitId) {
    const prevUnit = inventory.find(u => u.id === app.assigned_unit.unitId);
    if (prevUnit && prevUnit.status === 'reserved') {
      prevUnit.status = 'available';
      prevUnit.applicationId = null;
      prevUnit.clientName = null;
    }
  }

  // Assign the new unit
  unit.status = 'reserved';
  unit.applicationId = applicationId;
  unit.clientName = app.client_name || app.client?.name || '';

  listing.unit_inventory = inventory;
  listing.units_available = inventory.filter(u => u.status === 'available').length;
  store.saveListing(listing);

  // Update the application with the assigned unit
  app.assigned_unit = { unitId: unit.id, unitLabel: unit.label, unitType: unit.type };
  store.saveApplication(app);

  res.json({ unit, summary: inventorySummary(inventory) });
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

  const inventory = listing.unit_inventory || [];
  const unit = inventory.find(u => u.id === req.params.unitId);
  if (!unit) return res.status(404).json({ error: 'Unidad no encontrada' });

  // Clear application link
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

  listing.unit_inventory = inventory;
  listing.units_available = inventory.filter(u => u.status === 'available').length;
  store.saveListing(listing);

  res.json({ unit, summary: inventorySummary(inventory) });
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
