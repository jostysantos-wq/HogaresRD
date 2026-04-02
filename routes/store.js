const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  users:          path.join(DATA_DIR, 'users.json'),
  activity:       path.join(DATA_DIR, 'activity.json'),
  submissions:    path.join(DATA_DIR, 'submissions.json'),
  applications:   path.join(DATA_DIR, 'applications.json'),
  revokedTokens:  path.join(DATA_DIR, 'revoked_tokens.json'),
  conversations:  path.join(DATA_DIR, 'conversations.json'),
  metaLeads:      path.join(DATA_DIR, 'meta_leads.json'),
  availability:   path.join(DATA_DIR, 'availability.json'),
  tours:          path.join(DATA_DIR, 'tours.json'),
  twofa_sessions: path.join(DATA_DIR, 'twofa_sessions.json'),
};

const ACTIVITY_CAP = 200;

function read(file)       { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function write(file, data){ fs.writeFileSync(file, JSON.stringify(data, null, 2)); }

// ── Users ──────────────────────────────────────────────────────────────────
function getUsers()               { return read(FILES.users); }
function getUserById(id)          { return getUsers().find(u => u.id === id) || null; }
function getUserByEmail(email)    { return getUsers().find(u => u.email.toLowerCase() === email.toLowerCase()) || null; }
function getUserByRefToken(token) { return getUsers().find(u => u.refToken === token) || null; }

function saveUser(user) {
  const users = getUsers();
  const idx   = users.findIndex(u => u.id === user.id);
  if (idx === -1) users.push(user);
  else users[idx] = user;
  write(FILES.users, users);
}

// ── Activity ───────────────────────────────────────────────────────────────
function getActivityByUser(userId, limit = 200) {
  return read(FILES.activity).filter(e => e.userId === userId).slice(-limit);
}

// Returns all view_listing events from the last N milliseconds (for trending)
function getListingActivity(sinceMs) {
  return read(FILES.activity).filter(e =>
    e.type === 'view_listing' && e.listingId && new Date(e.timestamp) >= sinceMs
  );
}

function appendActivity(event) {
  const all        = read(FILES.activity);
  all.push(event);
  const userEvents = all.filter(e => e.userId === event.userId);
  if (userEvents.length > ACTIVITY_CAP) {
    const toRemove = userEvents.length - ACTIVITY_CAP;
    let removed    = 0;
    const trimmed  = all.filter(e => {
      if (e.userId === event.userId && removed < toRemove) { removed++; return false; }
      return true;
    });
    write(FILES.activity, trimmed);
  } else {
    write(FILES.activity, all);
  }
}

// ── Listings ───────────────────────────────────────────────────────────────
function getListings(filters = {}) {
  return read(FILES.submissions).filter(s => {
    if (s.status !== 'approved') return false;
    if (filters.province    && s.province !== filters.province) return false;
    if (filters.city        && s.city     !== filters.city)     return false;
    if (filters.type        && s.type     !== filters.type)     return false;
    if (filters.condition   && s.condition !== filters.condition) return false;
    if (filters.priceMax    && Number(s.price) > Number(filters.priceMax)) return false;
    if (filters.priceMin    && Number(s.price) < Number(filters.priceMin)) return false;
    if (filters.bedroomsMin && Number(s.bedrooms) < Number(filters.bedroomsMin)) return false;
    return true;
  });
}

function getListingById(id) {
  return read(FILES.submissions).find(s => s.id === id) || null;
}

function saveListing(listing) {
  const all = read(FILES.submissions);
  const idx = all.findIndex(s => s.id === listing.id);
  if (idx === -1) all.push(listing);
  else all[idx] = listing;
  write(FILES.submissions, all);
}

// ── Applications ──────────────────────────────────────────────────────────
function ensureFile(file) {
  if (!fs.existsSync(file)) fs.writeFileSync(file, '[]');
}
ensureFile(FILES.applications);

function getApplications()           { return read(FILES.applications); }
function getApplicationById(id)      { return getApplications().find(a => a.id === id) || null; }
function getApplicationsByBroker(uid) { return getApplications().filter(a => a.broker && a.broker.user_id === uid); }
function getApplicationsByClient(uidOrEmail) {
  return getApplications().filter(a =>
    a.client.user_id === uidOrEmail || (a.client.email && a.client.email.toLowerCase() === uidOrEmail.toLowerCase())
  );
}
function saveApplication(app) {
  const all = getApplications();
  const idx = all.findIndex(a => a.id === app.id);
  if (idx === -1) all.unshift(app);
  else all[idx] = app;
  write(FILES.applications, all);
}

// ── Revoked tokens (session invalidation) ─────────────────────────────────
// Each entry: { jti, exp, revokedAt }
// `exp` is a Unix timestamp (seconds).  Entries are pruned when they would
// have expired naturally anyway — the JWT is already invalid at that point.

function _readRevoked() {
  try {
    if (!fs.existsSync(FILES.revokedTokens)) return [];
    return JSON.parse(fs.readFileSync(FILES.revokedTokens, 'utf8'));
  } catch { return []; }
}

function _writeRevoked(tokens) {
  fs.writeFileSync(FILES.revokedTokens, JSON.stringify(tokens, null, 2));
}

function revokeToken(jti, exp) {
  if (!jti) return;
  const now   = Math.floor(Date.now() / 1000);
  // Prune expired entries while we have the file open
  const live  = _readRevoked().filter(t => t.exp > now);
  live.push({ jti, exp, revokedAt: new Date().toISOString() });
  _writeRevoked(live);
}

function isTokenRevoked(jti) {
  if (!jti) return false;
  const now = Math.floor(Date.now() / 1000);
  return _readRevoked().some(t => t.jti === jti && t.exp > now);
}

// ── Meta Leads ────────────────────────────────────────────────────────────
ensureFile(FILES.metaLeads);

function getMetaLeads() { return read(FILES.metaLeads); }

function appendMetaLead(lead) {
  const all = getMetaLeads();
  // Deduplicate by leadgenId
  if (lead.leadgenId && all.some(l => l.leadgenId === lead.leadgenId)) return;
  all.unshift(lead);
  write(FILES.metaLeads, all);
}

// ── Conversations ─────────────────────────────────────────────────────────
ensureFile(FILES.conversations);

function getConversations()       { return read(FILES.conversations); }
function getConversationById(id)  { return getConversations().find(c => c.id === id) || null; }

function getConversationsByClient(clientId) {
  return getConversations().filter(c => c.clientId === clientId);
}

function getConversationsForBroker(brokerId) {
  // Broker sees convs assigned to them OR unassigned
  return getConversations().filter(c => !c.brokerId || c.brokerId === brokerId);
}

function saveConversation(conv) {
  const all = getConversations();
  const idx = all.findIndex(c => c.id === conv.id);
  if (idx === -1) all.unshift(conv);
  else all[idx] = conv;
  write(FILES.conversations, all);
}

// ── Multi-role helpers ─────────────────────────────────────────────────────
function getUsersByRole(role) {
  return getUsers().filter(u => u.role === role);
}

function getUsersByInmobiliaria(inmobiliariaId) {
  return getUsers().filter(u =>
    (u.role === 'broker' || u.role === 'agency' || u.role === 'secretary') &&
    u.inmobiliaria_id === inmobiliariaId
  );
}

function getSecretariesByInmobiliaria(inmobiliariaId) {
  return getUsers().filter(u =>
    u.role === 'secretary' && u.inmobiliaria_id === inmobiliariaId
  );
}

function getApplicationsByInmobiliaria(inmobiliariaId) {
  return getApplications().filter(a => a.inmobiliaria_id === inmobiliariaId);
}

// ── Availability ──────────────────────────────────────────────────────────
ensureFile(FILES.availability);

function getAvailability()                   { return read(FILES.availability); }
function getAvailabilityByBroker(brokerId)   { return getAvailability().filter(a => a.broker_id === brokerId); }

function saveAvailabilitySlot(slot) {
  const all = getAvailability();
  const idx = all.findIndex(a => a.id === slot.id);
  if (idx === -1) all.push(slot);
  else all[idx] = slot;
  write(FILES.availability, all);
}

function deleteAvailabilitySlot(id) {
  const all = getAvailability().filter(a => a.id !== id);
  write(FILES.availability, all);
}

// ── Tours ─────────────────────────────────────────────────────────────────
ensureFile(FILES.tours);

function getTours()                    { return read(FILES.tours); }
function getTourById(id)               { return getTours().find(t => t.id === id) || null; }
function getToursByBroker(brokerId)    { return getTours().filter(t => t.broker_id === brokerId); }
function getToursByClient(clientId)    { return getTours().filter(t => t.client_id === clientId); }
function getToursByListing(listingId)  { return getTours().filter(t => t.listing_id === listingId); }

function getBookedSlots(brokerId, date) {
  return getTours().filter(t =>
    t.broker_id === brokerId &&
    t.requested_date === date &&
    (t.status === 'confirmed' || t.status === 'pending')
  );
}

function saveTour(tour) {
  const all = getTours();
  const idx = all.findIndex(t => t.id === tour.id);
  if (idx === -1) all.unshift(tour);
  else all[idx] = tour;
  write(FILES.tours, all);
}

// ── 2FA Sessions ─────────────────────────────────────────────────────────
ensureFile(FILES.twofa_sessions);

function getTwoFASessions()              { return read(FILES.twofa_sessions); }
function getTwoFASession(id)             { return getTwoFASessions().find(s => s.id === id) || null; }

function saveTwoFASession(session) {
  const all = getTwoFASessions();
  const idx = all.findIndex(s => s.id === session.id);
  if (idx === -1) all.push(session);
  else all[idx] = session;
  write(FILES.twofa_sessions, all);
}

function deleteTwoFASession(id) {
  const all = getTwoFASessions().filter(s => s.id !== id);
  write(FILES.twofa_sessions, all);
}

function cleanExpiredTwoFASessions() {
  const now = new Date();
  const all = getTwoFASessions().filter(s => new Date(s.expiresAt) > now);
  write(FILES.twofa_sessions, all);
}

module.exports = {
  getUsers, getUserById, getUserByEmail, getUserByRefToken, saveUser,
  getActivityByUser, getListingActivity, appendActivity,
  getListings, getListingById, saveListing,
  getApplications, getApplicationById, getApplicationsByBroker,
  getApplicationsByClient, getApplicationsByInmobiliaria, saveApplication,
  getConversations, getConversationById, getConversationsByClient,
  getConversationsForBroker, saveConversation,
  getMetaLeads, appendMetaLead,
  getUsersByRole, getUsersByInmobiliaria, getSecretariesByInmobiliaria,
  revokeToken, isTokenRevoked,
  getAvailability, getAvailabilityByBroker, saveAvailabilitySlot, deleteAvailabilitySlot,
  getTours, getTourById, getToursByBroker, getToursByClient, getToursByListing,
  getBookedSlots, saveTour,
  getTwoFASessions, getTwoFASession, saveTwoFASession, deleteTwoFASession, cleanExpiredTwoFASessions,
};
