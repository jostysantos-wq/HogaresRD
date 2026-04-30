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

// Subscription gate — new signups must have paid before accessing any
// broker-dashboard endpoint. Legacy trial users (paywallRequired=false)
// retain access until their trial expires naturally.
router.use((req, res, next) => {
  const user = req.brokerUser;
  if (!user) return next();

  // Secretaries inherit from their inmobiliaria (they don't pay individually)
  if (user.role === 'secretary') return next();

  const status = user.subscriptionStatus || 'none';
  const paywallRequired = user.paywallRequired === true;

  // Legacy trial users — active trial and not flagged for paywall
  const trialActive = status === 'trial' && user.trialEndsAt &&
                      new Date(user.trialEndsAt) > new Date();
  if (!paywallRequired && trialActive) return next();

  // Stripe-managed trialing/active users
  if (['active', 'trialing'].includes(status)) return next();

  // Everyone else is blocked
  return res.status(402).json({
    error: 'Se requiere suscripcion activa',
    needsSubscription: true,
  });
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

// ── D8: CSV export helpers ──────────────────────────────────────────
// RFC 4180-correct: quote fields containing `,`, `"`, CR or LF; double
// up internal quotes. UTF-8 BOM at the top so Excel opens accents OK.
function csvEscape(v) {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : String(v);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function streamCsv(res, filename, columns, rows) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition',
    `attachment; filename="${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`);
  // UTF-8 BOM so Excel opens "ñ" / accents correctly
  res.write('﻿');
  res.write(columns.map(c => csvEscape(c.label)).join(',') + '\r\n');
  for (const row of rows) {
    res.write(columns.map(c => csvEscape(row[c.key])).join(',') + '\r\n');
  }
  res.end();
}

// XLSX export — TODO: native zip writer using zlib + central directory
// proved out-of-scope for this pass (no precedent in the codebase, and
// the OOXML by-hand approach pulls in ~150 lines of zip plumbing). CSV
// covers the immediate spreadsheet-export need; revisit when the dashboard
// asks for multi-sheet workbooks. Constraint: cannot add npm deps.

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
  // Compute the "month start" anchored to Dominican Republic time (UTC-4,
  // no DST) so the count matches what users see on their local calendars,
  // regardless of the server's configured timezone.
  const TZ_OFFSET_MS = -4 * 3600 * 1000;
  const drNow = new Date(Date.now() + TZ_OFFSET_MS);
  const monthAgo = new Date(Date.UTC(drNow.getUTCFullYear(), drNow.getUTCMonth(), 1) - TZ_OFFSET_MS);
  const weekAgo = new Date(Date.now() - 7 * 86400000);
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

  // Only count sales whose payment was actually verified. An app marked
  // 'completado' or 'pago_aprobado' with a missing/rejected payment proof
  // would otherwise inflate revenue. Single-payment flows live on
  // app.payment.verification_status; installment plans are 'paid' once
  // every installment is approved.
  const isPaymentVerified = (a) => {
    if (a.payment?.verification_status === 'approved') return true;
    const insts = a.payment_plan?.installments;
    if (Array.isArray(insts) && insts.length > 0) {
      return insts.every(i => i.status === 'approved');
    }
    return false;
  };

  const completedApps = apps.filter(a =>
    ['completado', 'pago_aprobado'].includes(a.status) && isPaymentVerified(a)
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

  // D8: CSV export of completed sales
  if (req.query.format === 'csv') {
    return streamCsv(res, `ventas-${new Date().toISOString().slice(0, 10)}.csv`, [
      { key: 'completed_at',   label: 'Fecha' },
      { key: 'client_name',    label: 'Cliente' },
      { key: 'client_email',   label: 'Email Cliente' },
      { key: 'listing_title',  label: 'Propiedad' },
      { key: 'listing_type',   label: 'Tipo' },
      { key: 'listing_price',  label: 'Precio' },
      { key: 'payment_amount', label: 'Pago' },
      { key: 'payment_status', label: 'Estado pago' },
    ], completed_sales);
  }
  if (req.query.format === 'xlsx') {
    // TODO: see /audit XLSX note — ship CSV today, XLSX in a follow-up.
    res.setHeader('X-Export-Fallback', 'csv');
  }

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
  const { search, type, from, to, app_id, page = 1, limit = 50, format } = req.query;

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

  // D8: CSV export — return ALL filtered events (not paginated) so the
  // exported file is the full audit trail the user is looking at.
  if (format === 'csv') {
    return streamCsv(res, `audit-${new Date().toISOString().slice(0, 10)}.csv`, [
      { key: 'created_at',    label: 'Fecha' },
      { key: 'type',          label: 'Tipo' },
      { key: 'description',   label: 'Descripción' },
      { key: 'actor_name',    label: 'Actor' },
      { key: 'client_name',   label: 'Cliente' },
      { key: 'listing_title', label: 'Propiedad' },
      { key: 'app_id',        label: 'Aplicación' },
    ], events);
  }
  if (format === 'xlsx') {
    // TODO: ship XLSX once the by-hand OOXML writer lands. CSV covers
    // the export need today; this branch falls through to JSON so the
    // client can detect-and-fall-back gracefully.
    res.setHeader('X-Export-Fallback', 'csv');
  }

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

// ── GET /team-performance — Inmobiliaria director team metrics ───────────
router.get('/team-performance', (req, res) => {
  const user = req.brokerUser;
  // Only inmobiliaria/constructora directors can view team performance
  if (!['inmobiliaria', 'constructora'].includes(user.role)) {
    return res.status(403).json({ error: 'Solo directores de inmobiliaria pueden ver el rendimiento del equipo.' });
  }

  const since = parseRange(req.query.range);
  const teamMembers = store.getUsersByInmobiliaria(user.id);
  const teamIds = new Set(teamMembers.map(m => m.id));
  teamIds.add(user.id); // include the director themselves

  // Conversations scoped to this inmobiliaria
  const allConvs = store.getConversationsByInmobiliaria(user.id);
  const convs = since
    ? allConvs.filter(c => c.createdAt >= since.toISOString())
    : allConvs;

  // Lead queue items scoped to this org (inmobiliaria or constructora)
  const allLeads = store.getLeadQueue().filter(q => {
    // Prefer the new org_scope_id column; legacy rows still carry the
    // value in _extra.inmobiliaria_scope until they get rewritten.
    let scope = q.org_scope_id || null;
    if (!scope) {
      const extra = typeof q._extra === 'string' ? (function() { try { return JSON.parse(q._extra); } catch { return {}; } })() : (q._extra || {});
      scope = extra.inmobiliaria_scope || null;
    }
    return scope === user.id || teamIds.has(q.claimed_by);
  });
  const leads = since
    ? allLeads.filter(q => q.created_at >= since.toISOString())
    : allLeads;

  // Applications scoped to this inmobiliaria
  const apps = store.getApplicationsByInmobiliaria(user.id);
  const filteredApps = since
    ? apps.filter(a => a.created_at >= since.toISOString())
    : apps;

  // Contribution scores for team members
  const allScores = store.getContributionScores().filter(c => teamIds.has(c.user_id));

  // Per-agent stats
  const agents = [];
  for (const member of teamMembers) {
    const agentConvs = convs.filter(c => c.brokerId === member.id);
    const openConvs = agentConvs.filter(c => !c.closed && !c.archived);
    const closedConvs = agentConvs.filter(c => c.closed || c.archived);
    const agentApps = filteredApps.filter(a => a.broker?.user_id === member.id);
    const agentScores = allScores.filter(c => c.user_id === member.id);
    const totalResponses = agentScores.reduce((sum, c) => sum + (c.response_count || 0), 0);
    const avgResponseMs = totalResponses > 0
      ? Math.round(agentScores.reduce((sum, c) => sum + (c.avg_response_ms || 0) * (c.response_count || 0), 0) / totalResponses)
      : null;
    const agentClaims = leads.filter(q => q.claimed_by === member.id && q.status === 'claimed');

    // Agent activity status: active if logged in within last 3 days
    const lastLogin = member.lastLoginAt ? new Date(member.lastLoginAt) : null;
    const daysSinceLogin = lastLogin ? Math.floor((Date.now() - lastLogin.getTime()) / 86400000) : null;

    agents.push({
      userId: member.id,
      name: member.name || '',
      role: member.role,
      avatarUrl: member.avatarUrl || null,
      lastLoginAt: member.lastLoginAt || null,
      daysSinceLogin,
      isActive: daysSinceLogin !== null && daysSinceLogin <= 3,
      conversations_handled: agentConvs.length,
      open_conversations: openConvs.length,
      closed_conversations: closedConvs.length,
      applications_count: agentApps.length,
      avg_response_ms: avgResponseMs,
      avg_response_min: avgResponseMs ? +(avgResponseMs / 60000).toFixed(1) : null,
      total_responses: totalResponses,
      leads_claimed: agentClaims.length,
    });
  }

  // Aggregate stats
  const claimedLeads = leads.filter(q => q.status === 'claimed');
  const unclaimedLeads = leads.filter(q => q.status === 'active');
  const allResponseMs = agents.filter(a => a.avg_response_ms).map(a => a.avg_response_ms);
  const avgSpeedToLead = allResponseMs.length
    ? Math.round(allResponseMs.reduce((a, b) => a + b, 0) / allResponseMs.length)
    : null;

  // Best performer (most conversations handled)
  const bestPerformer = agents.length
    ? agents.reduce((best, a) => a.conversations_handled > (best?.conversations_handled || 0) ? a : best, null)
    : null;

  // Leads by day (last 30 days)
  const leadsByDay = {};
  for (const q of leads) {
    const day = (q.created_at || '').slice(0, 10);
    if (day) leadsByDay[day] = (leadsByDay[day] || 0) + 1;
  }
  const leadsByDayArr = Object.entries(leadsByDay)
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Org-wide summary metrics
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const leadsThisMonth = leads.filter(q => (q.created_at || '') >= monthStart).length;
  const completedApps = filteredApps.filter(a => a.status === 'completado');
  const conversionRate = filteredApps.length
    ? Math.round((completedApps.length / filteredApps.length) * 100) : 0;
  const activePipelineValue = filteredApps
    .filter(a => !['completado', 'rechazado'].includes(a.status))
    .reduce((sum, a) => sum + (Number(a.listing_price) || 0), 0);
  const totalRevenue = completedApps.reduce((sum, a) => sum + (Number(a.listing_price) || 0), 0);
  const activeAgents = agents.filter(a => a.isActive).length;
  const inactiveAgents = agents.filter(a => !a.isActive).length;

  res.json({
    team_size: teamMembers.length,
    agents,
    aggregate: {
      total_leads: leads.length,
      leads_this_month: leadsThisMonth,
      claimed_count: claimedLeads.length,
      claimed_pct: leads.length ? Math.round((claimedLeads.length / leads.length) * 100) : 0,
      unclaimed_count: unclaimedLeads.length,
      avg_speed_to_lead_ms: avgSpeedToLead,
      avg_speed_to_lead_min: avgSpeedToLead ? +(avgSpeedToLead / 60000).toFixed(1) : null,
      total_conversations: convs.length,
      total_applications: filteredApps.length,
      completed_applications: completedApps.length,
      conversion_rate: conversionRate,
      active_pipeline_value: activePipelineValue,
      total_revenue: totalRevenue,
      active_agents: activeAgents,
      inactive_agents: inactiveAgents,
    },
    best_performer: bestPerformer,
    leads_by_day: leadsByDayArr,
  });
});

// ── POST /api/broker/team-broadcast — Director sends message to all team agents ──
router.post('/team-broadcast', async (req, res) => {
  const user = req.brokerUser;
  if (!['inmobiliaria', 'constructora'].includes(user.role))
    return res.status(403).json({ error: 'Solo directores pueden enviar anuncios al equipo.' });

  const { message } = req.body;
  if (!message || typeof message !== 'string' || message.trim().length < 1)
    return res.status(400).json({ error: 'Mensaje requerido.' });

  const teamMembers = store.getUsersByInmobiliaria(user.id);
  const secretaries = store.getSecretariesByInmobiliaria(user.id);
  const allMembers = [...teamMembers, ...secretaries];

  if (!allMembers.length)
    return res.json({ ok: true, sent: 0 });

  const { notify: pushNotify } = require('./push');
  const { createTransport } = require('./mailer');
  const mailer = createTransport();
  const et = require('../utils/email-templates');
  let sent = 0;

  for (const member of allMembers) {
    // Push notification
    try {
      pushNotify(member.id, {
        type: 'team_broadcast',
        title: `Anuncio de ${user.companyName || user.name}`,
        body: message.trim().slice(0, 200),
        url: '/broker',
      });
    } catch {}

    // Email notification. mailer.sendMail returns a Promise, so a sync
    // try/catch around it caught only validation throws — async network
    // / SMTP failures fell through as unhandledRejection and (after the
    // recent error-tracker hardening) get dropped silently. Use .catch
    // so failures land in the error log with the failing recipient.
    if (member.email) {
      mailer.sendMail({
        to: member.email,
        subject: `Anuncio del equipo — ${user.companyName || user.name}`,
        department: 'noreply',
        html: et.layout({
          title: 'Anuncio del Equipo',
          subtitle: user.companyName || user.name,
          body: `<p>${message.trim().replace(/\n/g, '<br>')}</p>`,
          cta: { label: 'Ir al Dashboard', url: 'https://hogaresrd.com/broker' },
        }),
      }).catch(err => console.error(`[broker-dashboard] Team broadcast email failed for ${member.email}:`, err.message));
    }
    sent++;
  }

  res.json({ ok: true, sent });
});

module.exports = router;
