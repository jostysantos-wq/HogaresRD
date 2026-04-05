const express    = require('express');
const store      = require('./store');
const { userAuth } = require('./auth');
const { logSec } = require('./security-log');

const router = express.Router();

// All endpoints require logged-in broker / agency (compat) / inmobiliaria
router.use(userAuth, (req, res, next) => {
  const user = store.getUserById(req.user.sub);
  const allowed = ['agency', 'broker', 'inmobiliaria', 'constructora', 'secretary'];
  if (!user || !allowed.includes(user.role)) {
    logSec('role_violation', req, {
      userId:       req.user.sub,
      actualRole:   user?.role || 'unknown',
      requiredRole: 'broker|agency|inmobiliaria',
    });
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias pueden acceder' });
  }
  req.brokerUser = user;
  next();
});

// ── Helpers ──────────────────────────────────────────────────────
// Returns applications scoped to the caller's role:
//   inmobiliaria → all apps whose broker was affiliated at the time
//   broker / agency → only their own apps
function brokerApps(user) {
  if (user.role === 'inmobiliaria' || user.role === 'constructora')
    return store.getApplicationsByInmobiliaria(user.id);
  if (user.role === 'secretary')
    return store.getApplicationsByInmobiliaria(user.inmobiliaria_id);
  return store.getApplicationsByBroker(user.id);
}

function parseRange(range) {
  const now = new Date();
  if (range === '7d')   return new Date(now - 7  * 86400000);
  if (range === '30d')  return new Date(now - 30 * 86400000);
  if (range === '90d')  return new Date(now - 90 * 86400000);
  if (range === '12m')  return new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  return null; // all time
}

function dayKey(d) { return d.toISOString().slice(0, 10); }
function monthKey(d) { return d.toISOString().slice(0, 7); }

function findEvent(app, type, status) {
  return app.timeline_events?.find(e =>
    e.type === type && (!status || e.data?.to === status)
  );
}

// ══════════════════════════════════════════════════════════════════
// ── GET /analytics ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/analytics', (req, res) => {
  const apps = brokerApps(req.brokerUser);
  const since = parseRange(req.query.range || '12m');

  // Applications by day (last 30 days)
  const last30 = new Date(Date.now() - 30 * 86400000);
  const byDay = {};
  for (let d = new Date(last30); d <= new Date(); d.setDate(d.getDate() + 1)) {
    byDay[dayKey(d)] = 0;
  }
  apps.forEach(a => {
    const dk = dayKey(new Date(a.created_at));
    if (dk in byDay) byDay[dk]++;
  });

  // Applications by month (last 12 months)
  const byMonth = {};
  const now = new Date();
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    byMonth[monthKey(d)] = 0;
  }
  apps.forEach(a => {
    const mk = monthKey(new Date(a.created_at));
    if (mk in byMonth) byMonth[mk]++;
  });

  // Pipeline counts
  const pipeline = {};
  apps.forEach(a => { pipeline[a.status] = (pipeline[a.status] || 0) + 1; });

  // Conversion rate
  const completed = apps.filter(a => a.status === 'completado').length;
  const conversion_rate = apps.length ? +(completed / apps.length).toFixed(3) : 0;

  // Average days to close
  const closeTimes = apps.filter(a => a.status === 'completado').map(a => {
    const ev = findEvent(a, 'status_change', 'completado');
    if (!ev) return null;
    return (new Date(ev.created_at) - new Date(a.created_at)) / 86400000;
  }).filter(Boolean);
  const avg_days_to_close = closeTimes.length
    ? +(closeTimes.reduce((s, v) => s + v, 0) / closeTimes.length).toFixed(1)
    : 0;

  // Top listings
  const listingCounts = {};
  apps.forEach(a => {
    const k = a.listing_id;
    if (!listingCounts[k]) listingCounts[k] = { listing_id: k, title: a.listing_title, count: 0 };
    listingCounts[k].count++;
  });
  const top_listings = Object.values(listingCounts).sort((a, b) => b.count - a.count).slice(0, 10);

  // New this week / month
  const weekAgo = new Date(Date.now() - 7 * 86400000);
  const monthAgo = new Date(now.getFullYear(), now.getMonth(), 1);
  const new_this_week = apps.filter(a => new Date(a.created_at) >= weekAgo).length;
  const new_this_month = apps.filter(a => new Date(a.created_at) >= monthAgo).length;

  res.json({
    total: apps.length,
    new_this_week,
    new_this_month,
    applications_by_day: Object.entries(byDay).map(([date, count]) => ({ date, count })),
    applications_by_month: Object.entries(byMonth).map(([month, count]) => ({ month, count })),
    pipeline,
    conversion_rate,
    avg_days_to_close,
    top_listings,
  });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /sales ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/sales', (req, res) => {
  if (req.brokerUser.role === 'secretary')
    return res.status(403).json({ error: 'Acceso restringido para secretarias' });
  const apps = brokerApps(req.brokerUser);

  const completedApps = apps.filter(a =>
    ['completado', 'pago_aprobado'].includes(a.status)
  );

  const completed_sales = completedApps.map(a => {
    const ev = findEvent(a, 'status_change', 'completado') ||
               findEvent(a, 'status_change', 'pago_aprobado');
    return {
      id: a.id,
      client_name: a.client.name,
      client_email: a.client.email,
      listing_id: a.listing_id,
      listing_title: a.listing_title,
      listing_price: Number(a.listing_price) || 0,
      listing_type: a.listing_type,
      completed_at: ev?.created_at || a.updated_at,
      payment_amount: a.payment?.amount || a.listing_price,
      payment_status: a.payment?.verification_status || 'none',
    };
  });

  const total_revenue = completed_sales.reduce((s, c) => s + c.listing_price, 0);

  // Monthly revenue (last 12 months)
  const now = new Date();
  const monthlyRev = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthlyRev[monthKey(d)] = { revenue: 0, count: 0 };
  }
  completed_sales.forEach(s => {
    const mk = monthKey(new Date(s.completed_at));
    if (monthlyRev[mk]) {
      monthlyRev[mk].revenue += s.listing_price;
      monthlyRev[mk].count++;
    }
  });

  // Sales by property type
  const salesByType = {};
  completed_sales.forEach(s => {
    const t = s.listing_type || 'otro';
    salesByType[t] = (salesByType[t] || 0) + 1;
  });

  // Active pipeline value
  const activeApps = apps.filter(a => !['completado', 'pago_aprobado', 'rechazado'].includes(a.status));
  const active_pipeline_value = activeApps.reduce((s, a) => s + (Number(a.listing_price) || 0), 0);

  const avg_sale_price = completed_sales.length
    ? Math.round(total_revenue / completed_sales.length)
    : 0;

  res.json({
    completed_sales,
    total_revenue,
    monthly_revenue: Object.entries(monthlyRev).map(([month, d]) => ({
      month, revenue: d.revenue, count: d.count,
    })),
    avg_sale_price,
    sales_by_type: salesByType,
    active_pipeline_value,
    total_sales: completed_sales.length,
    active_count: activeApps.length,
  });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /documents/archive ──────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/documents/archive', (req, res) => {
  const apps = brokerApps(req.brokerUser);
  const { status, type, search, page = 1, limit = 20 } = req.query;

  let docs = [];
  apps.forEach(a => {
    if (status && a.status !== status) return;
    (a.documents_uploaded || []).forEach(d => {
      docs.push({
        app_id: a.id,
        app_status: a.status,
        client_name: a.client.name,
        client_email: a.client.email,
        listing_title: a.listing_title,
        listing_id: a.listing_id,
        doc_id: d.id,
        type: d.type,
        original_name: d.original_name,
        filename: d.filename,
        size: d.size,
        uploaded_at: d.uploaded_at,
        review_status: d.review_status,
        review_note: d.review_note,
        request_id: d.request_id,
      });
    });
  });

  // Filters
  if (type) docs = docs.filter(d => d.type === type);
  if (search) {
    const q = search.toLowerCase();
    docs = docs.filter(d =>
      d.original_name.toLowerCase().includes(q) ||
      d.client_name.toLowerCase().includes(q) ||
      d.listing_title.toLowerCase().includes(q) ||
      d.type.toLowerCase().includes(q)
    );
  }

  // Sort newest first
  docs.sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));

  const total = docs.length;
  const p = Math.max(1, parseInt(page));
  const l = Math.min(100, Math.max(1, parseInt(limit)));
  const pages = Math.ceil(total / l) || 1;
  const paginated = docs.slice((p - 1) * l, p * l);

  // Stats
  const totalByType = {};
  docs.forEach(d => { totalByType[d.type] = (totalByType[d.type] || 0) + 1; });

  res.json({ documents: paginated, total, page: p, pages, totalByType });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /audit ──────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/audit', (req, res) => {
  const apps = brokerApps(req.brokerUser);
  const { search, type, from, to, app_id, page = 1, limit = 50 } = req.query;

  let events = [];
  apps.forEach(a => {
    if (app_id && a.id !== app_id) return;
    (a.timeline_events || []).forEach(e => {
      events.push({
        event_id: e.id,
        app_id: a.id,
        client_name: a.client.name,
        listing_title: a.listing_title,
        listing_id: a.listing_id,
        type: e.type,
        description: e.description,
        actor: e.actor,
        actor_name: e.actor_name,
        data: e.data,
        created_at: e.created_at,
      });
    });
  });

  // Filters
  if (type) events = events.filter(e => e.type === type);
  if (from) events = events.filter(e => new Date(e.created_at) >= new Date(from));
  if (to)   events = events.filter(e => new Date(e.created_at) <= new Date(to + 'T23:59:59'));
  if (search) {
    const q = search.toLowerCase();
    events = events.filter(e =>
      e.description.toLowerCase().includes(q) ||
      e.actor_name.toLowerCase().includes(q) ||
      e.client_name.toLowerCase().includes(q) ||
      e.listing_title.toLowerCase().includes(q)
    );
  }

  // Sort newest first
  events.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

  const total = events.length;
  const p = Math.max(1, parseInt(page));
  const l = Math.min(200, Math.max(1, parseInt(limit)));
  const pages = Math.ceil(total / l) || 1;
  const paginated = events.slice((p - 1) * l, p * l);

  // Event type counts
  const typeCounts = {};
  events.forEach(e => { typeCounts[e.type] = (typeCounts[e.type] || 0) + 1; });

  res.json({ events: paginated, total, page: p, pages, typeCounts });
});

// ══════════════════════════════════════════════════════════════════
// ── GET /accounting ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════
router.get('/accounting', (req, res) => {
  if (req.brokerUser.role === 'secretary')
    return res.status(403).json({ error: 'Acceso restringido para secretarias' });
  const apps = brokerApps(req.brokerUser);
  const commissionRate = parseFloat(req.query.commission_rate) || 0.03; // 3% default

  const completedApps = apps.filter(a =>
    ['completado', 'pago_aprobado'].includes(a.status)
  );
  const pendingApps = apps.filter(a =>
    !['completado', 'pago_aprobado', 'rechazado'].includes(a.status)
  );

  const total_completed_value = completedApps.reduce((s, a) => s + (Number(a.listing_price) || 0), 0);
  const total_pending_value = pendingApps.reduce((s, a) => s + (Number(a.listing_price) || 0), 0);

  // Payment details
  const payments = apps.filter(a => a.payment && a.payment.verification_status !== 'none').map(a => ({
    app_id: a.id,
    client_name: a.client.name,
    client_email: a.client.email,
    listing_title: a.listing_title,
    listing_id: a.listing_id,
    listing_price: Number(a.listing_price) || 0,
    payment_amount: Number(a.payment.amount) || Number(a.listing_price) || 0,
    payment_status: a.payment.verification_status,
    receipt_uploaded_at: a.payment.receipt_uploaded_at,
    verified_at: a.payment.verified_at,
    verified_by: a.payment.verified_by,
    payment_notes: a.payment.notes,
    commission: Math.round((Number(a.listing_price) || 0) * commissionRate),
    app_status: a.status,
  }));

  // Monthly commissions (from completed sales)
  const now = new Date();
  const monthlyComm = {};
  for (let i = 11; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    monthlyComm[monthKey(d)] = { completed_value: 0, commission: 0, count: 0 };
  }
  completedApps.forEach(a => {
    const ev = findEvent(a, 'status_change', 'completado') ||
               findEvent(a, 'status_change', 'pago_aprobado');
    const mk = monthKey(new Date(ev?.created_at || a.updated_at));
    if (monthlyComm[mk]) {
      const price = Number(a.listing_price) || 0;
      monthlyComm[mk].completed_value += price;
      monthlyComm[mk].commission += Math.round(price * commissionRate);
      monthlyComm[mk].count++;
    }
  });

  // All apps with financial summary
  const all_financial = apps.map(a => ({
    app_id: a.id,
    client_name: a.client.name,
    listing_title: a.listing_title,
    listing_price: Number(a.listing_price) || 0,
    status: a.status,
    commission: Math.round((Number(a.listing_price) || 0) * commissionRate),
    payment_status: a.payment?.verification_status || 'none',
    created_at: a.created_at,
  }));

  res.json({
    summary: {
      total_completed_value,
      total_pending_value,
      estimated_commission: Math.round(total_completed_value * commissionRate),
      pending_commission: Math.round(total_pending_value * commissionRate),
      commission_rate: commissionRate,
      total_apps: apps.length,
      completed_count: completedApps.length,
      pending_count: pendingApps.length,
    },
    payments,
    monthly_commissions: Object.entries(monthlyComm).map(([month, d]) => ({
      month, ...d,
    })),
    all_financial,
  });
});

module.exports = router;
