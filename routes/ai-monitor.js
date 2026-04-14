/**
 * ai-monitor.js — AI-powered listing health monitor
 *
 * Runs daily (cron) or on-demand from admin panel.
 * Two-phase approach to minimize API costs:
 *   Phase 1: Rule-based checks (free — expired dates, missing fields, duplicates)
 *   Phase 2: AI check via Claude Haiku (only on flagged + sample of clean listings)
 *
 * Results stored per-listing as `monitorFlags` and globally as a scan summary.
 */

'use strict';

const store = require('./store');
const { createTransport } = require('./mailer');
const et = require('../utils/email-templates');

const Anthropic = require('@anthropic-ai/sdk');
const API_KEY = process.env.ANTHROPIC_API_KEY;
const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;
const MODEL = 'claude-haiku-4-5';

const transporter = createTransport();
const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'Jostysantos@gmail.com';

// In-memory scan results (survives until PM2 restart)
let _lastScan = null;
let _scanRunning = false;

// ── Rule-based checks (Phase 1 — no API cost) ─────────────────────────

function checkExpiredDeliveryDates(listings) {
  const today = new Date().toISOString().slice(0, 10);
  const flags = [];
  for (const l of listings) {
    if (!l.delivery_date) continue;
    // delivery_date can be "2024-06" or "2024-06-15"
    const dateStr = l.delivery_date.length <= 7 ? l.delivery_date + '-28' : l.delivery_date;
    if (dateStr < today) {
      flags.push({
        listingId: l.id, type: 'expired_delivery',
        severity: 'high',
        message: `Fecha de entrega vencida: ${l.delivery_date}. Actualizar con fotos reales y nueva fecha.`,
      });
    }
  }
  return flags;
}

function checkLowPhotos(listings) {
  const flags = [];
  for (const l of listings) {
    const count = Array.isArray(l.images) ? l.images.length : 0;
    if (count === 0) {
      flags.push({ listingId: l.id, type: 'no_photos', severity: 'high', message: 'Sin fotos — la propiedad no tiene imágenes.' });
    } else if (count < 3) {
      flags.push({ listingId: l.id, type: 'low_photos', severity: 'medium', message: `Solo ${count} foto(s). Se recomiendan al menos 5.` });
    }
  }
  return flags;
}

function checkMissingFields(listings) {
  const flags = [];
  for (const l of listings) {
    const missing = [];
    if (!l.description || l.description.length < 20) missing.push('descripción');
    if (!l.price || Number(l.price) <= 0) missing.push('precio');
    if (!l.province && !l.city) missing.push('ubicación');
    if (!l.bedrooms && !['Solar / Terreno', 'Local Comercial', 'Finca'].includes(l.property_type))
      missing.push('habitaciones');
    if (missing.length) {
      flags.push({
        listingId: l.id, type: 'missing_fields', severity: missing.length > 1 ? 'high' : 'medium',
        message: `Campos incompletos: ${missing.join(', ')}.`,
      });
    }
  }
  return flags;
}

function checkStaleListings(listings) {
  const flags = [];
  const cutoff90 = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const cutoff180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString();
  for (const l of listings) {
    const lastUpdate = l.updatedAt || l.approvedAt || l.submittedAt;
    if (!lastUpdate) continue;
    if (lastUpdate < cutoff180) {
      flags.push({ listingId: l.id, type: 'very_stale', severity: 'high',
        message: 'Publicación sin actualizar hace más de 6 meses. Verificar si sigue disponible.' });
    } else if (lastUpdate < cutoff90) {
      flags.push({ listingId: l.id, type: 'stale', severity: 'medium',
        message: 'Publicación sin actualizar hace más de 3 meses.' });
    }
  }
  return flags;
}

function checkDuplicates(listings) {
  const flags = [];
  const seen = new Map(); // key: normalized title+city → listing

  for (const l of listings) {
    const titleWords = (l.title || '').toLowerCase().replace(/[^a-záéíóúñü\s]/g, '').split(/\s+/).filter(w => w.length > 3);
    const key = `${(l.city || '').toLowerCase()}_${titleWords.sort().join('_')}`;
    if (!key || titleWords.length < 2) continue;

    if (seen.has(key)) {
      const other = seen.get(key);
      const priceDiff = Math.abs(Number(l.price) - Number(other.price)) / Math.max(Number(l.price), 1);
      if (priceDiff < 0.15) {
        flags.push({
          listingId: l.id, type: 'possible_duplicate', severity: 'high',
          message: `Posible duplicado de "${other.title}" (ID: ${other.id}). Mismo título, ciudad y precio similar.`,
        });
      }
    } else {
      seen.set(key, l);
    }
  }
  return flags;
}

// ── AI-powered check (Phase 2) ─────────────────────────────────────────

async function aiQualityCheck(listings) {
  if (!anthropic || !listings.length) return [];

  // Prepare a compact summary for Claude (keep tokens low)
  const batch = listings.slice(0, 15).map(l => ({
    id: l.id,
    title: l.title || '',
    price: l.price || 0,
    city: l.city || '',
    province: l.province || '',
    bedrooms: l.bedrooms || '',
    bathrooms: l.bathrooms || '',
    area: l.area_const || '',
    description: (l.description || '').slice(0, 200),
    imageCount: Array.isArray(l.images) ? l.images.length : 0,
    type: l.type || '',
    condition: l.condition || '',
    delivery_date: l.delivery_date || '',
  }));

  const prompt = `Eres un analista de calidad de anuncios inmobiliarios para HogaresRD (República Dominicana).

Revisa estos anuncios y detecta problemas. Responde SOLO con un JSON array válido, sin markdown ni explicaciones.

Para cada anuncio con problemas, reporta:
{ "id": "listing_id", "issues": [{ "type": "tipo", "severity": "low|medium|high", "message": "descripción en español" }] }

Tipos de problemas a buscar:
- pricing_anomaly: precio parece demasiado alto o bajo para la zona y tipo de propiedad
- spam_content: descripción parece spam, texto placeholder, o relleno genérico
- misleading_info: título o descripción no coincide con los detalles de la propiedad
- quality_concern: cualquier otro problema de calidad que afecte la experiencia del comprador

Si un anuncio no tiene problemas, NO lo incluyas en el resultado.

Anuncios a revisar:
${JSON.stringify(batch, null, 2)}`;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content?.[0]?.text || '[]';
    // Extract JSON array from response (Claude sometimes wraps it)
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return [];

    const results = JSON.parse(jsonMatch[0]);
    const flags = [];
    for (const r of results) {
      if (!r.id || !Array.isArray(r.issues)) continue;
      for (const issue of r.issues) {
        flags.push({
          listingId: r.id,
          type: issue.type || 'ai_quality',
          severity: issue.severity || 'medium',
          message: issue.message || 'Problema de calidad detectado por IA',
        });
      }
    }
    return flags;
  } catch (err) {
    console.error('[ai-monitor] Claude API error:', err.message);
    return [];
  }
}

// ── Main scan function ─────────────────────────────────────────────────

async function runMonitorScan() {
  if (_scanRunning) {
    console.log('[ai-monitor] Scan already running — skipping');
    return _lastScan;
  }
  _scanRunning = true;
  const startTime = Date.now();

  try {
    console.log('[ai-monitor] Starting listing health scan...');
    const listings = store.getListings({});
    console.log(`[ai-monitor] Scanning ${listings.length} approved listings`);

    // Phase 1: Rule-based checks
    const allFlags = [
      ...checkExpiredDeliveryDates(listings),
      ...checkLowPhotos(listings),
      ...checkMissingFields(listings),
      ...checkStaleListings(listings),
      ...checkDuplicates(listings),
    ];

    console.log(`[ai-monitor] Phase 1 (rules): ${allFlags.length} issues found`);

    // Phase 2: AI check on flagged listings + random sample
    const flaggedIds = new Set(allFlags.map(f => f.listingId));
    const flaggedListings = listings.filter(l => flaggedIds.has(l.id));
    // Also sample some clean listings for AI to check
    const cleanListings = listings.filter(l => !flaggedIds.has(l.id));
    const sample = cleanListings.sort(() => Math.random() - 0.5).slice(0, 5);
    const aiInput = [...flaggedListings, ...sample];

    if (aiInput.length > 0 && anthropic) {
      const aiFlags = await aiQualityCheck(aiInput);
      allFlags.push(...aiFlags);
      console.log(`[ai-monitor] Phase 2 (AI): ${aiFlags.length} additional issues found`);
    }

    // Group flags by listing
    const byListing = {};
    for (const f of allFlags) {
      if (!byListing[f.listingId]) byListing[f.listingId] = [];
      byListing[f.listingId].push(f);
    }

    // Save flags on each listing
    for (const [id, flags] of Object.entries(byListing)) {
      const listing = store.getListingById(id);
      if (!listing) continue;
      listing.monitorFlags = flags;
      listing.lastMonitorScan = new Date().toISOString();
      store.saveListing(listing);
    }

    // Clear flags on clean listings
    for (const l of listings) {
      if (!byListing[l.id] && l.monitorFlags?.length) {
        l.monitorFlags = [];
        l.lastMonitorScan = new Date().toISOString();
        store.saveListing(l);
      }
    }

    // Build summary
    const typeCounts = {};
    for (const f of allFlags) {
      typeCounts[f.type] = (typeCounts[f.type] || 0) + 1;
    }

    const summary = {
      scannedAt: new Date().toISOString(),
      duration: Date.now() - startTime,
      totalListings: listings.length,
      totalFlags: allFlags.length,
      flaggedListings: Object.keys(byListing).length,
      byType: typeCounts,
      bySeverity: {
        high: allFlags.filter(f => f.severity === 'high').length,
        medium: allFlags.filter(f => f.severity === 'medium').length,
        low: allFlags.filter(f => f.severity === 'low').length,
      },
      aiEnabled: !!anthropic,
      flags: allFlags,
    };

    _lastScan = summary;
    console.log(`[ai-monitor] Scan complete: ${summary.flaggedListings} listing(s) flagged, ${summary.totalFlags} total issues`);

    // Email admin if there are high-severity issues
    const highCount = summary.bySeverity.high;
    if (highCount > 0) {
      const rows = Object.entries(byListing)
        .filter(([, flags]) => flags.some(f => f.severity === 'high'))
        .slice(0, 10)
        .map(([id, flags]) => {
          const listing = store.getListingById(id);
          return et.infoRow(
            et.esc(listing?.title || id),
            flags.map(f => `${f.severity === 'high' ? '🔴' : '🟡'} ${et.esc(f.message)}`).join('<br>')
          );
        }).join('');

      transporter.sendMail({
        to: ADMIN_EMAIL,
        subject: `⚠️ Monitor: ${highCount} problema(s) crítico(s) detectado(s) — HogaresRD`,
        html: et.layout({
          title: 'Reporte del Monitor de Propiedades',
          headerColor: '#b45309',
          body: et.alertBox(`Se encontraron ${summary.totalFlags} problemas en ${summary.flaggedListings} propiedad(es). ${highCount} son de alta prioridad.`, 'warning')
            + et.infoTable(
                et.infoRow('Propiedades escaneadas', String(summary.totalListings))
              + et.infoRow('Problemas encontrados', String(summary.totalFlags))
              + et.infoRow('Alta prioridad', String(highCount))
            )
            + '<h3 style="margin:1rem 0 0.5rem;">Detalle</h3>'
            + et.infoTable(rows)
            + et.button('Ver en Admin', `${BASE_URL}/${process.env.ADMIN_PATH || 'admin'}`),
        }),
      }).catch(e => console.error('[ai-monitor] Email error:', e.message));
    }

    return summary;
  } catch (err) {
    console.error('[ai-monitor] Scan error:', err.message);
    return { error: err.message, scannedAt: new Date().toISOString() };
  } finally {
    _scanRunning = false;
  }
}

function getLastScan() { return _lastScan; }
function isScanRunning() { return _scanRunning; }

module.exports = { runMonitorScan, getLastScan, isScanRunning };
