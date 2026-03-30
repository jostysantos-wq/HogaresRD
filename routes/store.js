const fs   = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILES = {
  users:        path.join(DATA_DIR, 'users.json'),
  activity:     path.join(DATA_DIR, 'activity.json'),
  submissions:  path.join(DATA_DIR, 'submissions.json'),
  applications: path.join(DATA_DIR, 'applications.json'),
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

module.exports = {
  getUsers, getUserById, getUserByEmail, getUserByRefToken, saveUser,
  getActivityByUser, getListingActivity, appendActivity,
  getListings, getListingById, saveListing,
  getApplications, getApplicationById, getApplicationsByBroker, getApplicationsByClient, saveApplication,
};
