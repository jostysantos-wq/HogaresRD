/**
 * routes/paid-ads.js
 * Meta (Facebook + Instagram) Paid Ads integration via Marketing API v19.0
 * Endpoints are mounted at /api/paid-ads
 */

const express = require('express');
const store   = require('./store');
const { userAuth } = require('./auth');

const router = express.Router();

const META_API_VER  = 'v19.0';
const META_GRAPH    = `https://graph.facebook.com/${META_API_VER}`;
const META_DIALOG   = `https://www.facebook.com/${META_API_VER}/dialog/oauth`;
const SCOPES        = 'ads_management,ads_read,business_management';

// In-memory OAuth state → userId map (expires after 10 min)
const oauthStates = new Map();

// ── Broker/agency/inmobiliaria auth ─────────────────────────────
function requireBroker(req, res, next) {
  const user = store.getUserById(req.user?.sub);
  const allowed = ['agency', 'broker', 'inmobiliaria'];
  if (!user || !allowed.includes(user.role)) {
    return res.status(403).json({ error: 'Solo agentes o inmobiliarias pueden acceder' });
  }
  req.brokerUser = user;
  next();
}

// ── Meta Graph API helper ────────────────────────────────────────
async function graph(path, token, method = 'GET', body = null) {
  const sep  = path.includes('?') ? '&' : '?';
  const url  = `${META_GRAPH}${path}${sep}access_token=${token}`;
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  return r.json();
}

// ── GET /meta/configured — check if FB App is set up ────────────
router.get('/meta/configured', userAuth, requireBroker, (req, res) => {
  const configured = !!(process.env.FB_APP_ID && process.env.FB_APP_SECRET);
  res.json({ configured });
});

// ── GET /meta/auth-url — returns Facebook OAuth URL ─────────────
router.get('/meta/auth-url', userAuth, requireBroker, (req, res) => {
  const { FB_APP_ID } = process.env;
  if (!FB_APP_ID) {
    return res.status(400).json({ error: 'FB_APP_ID no está configurado en el servidor.' });
  }
  // Generate a unique state token for this OAuth session
  const state  = require('crypto').randomBytes(16).toString('hex');
  const userId = req.brokerUser.id;
  oauthStates.set(state, { userId, createdAt: Date.now() });
  // Expire old states
  for (const [k, v] of oauthStates) {
    if (Date.now() - v.createdAt > 10 * 60 * 1000) oauthStates.delete(k);
  }

  const callbackUrl = `${process.env.BASE_URL}/api/paid-ads/meta/callback`;
  const url = `${META_DIALOG}?client_id=${FB_APP_ID}&redirect_uri=${encodeURIComponent(callbackUrl)}&scope=${SCOPES}&response_type=code&state=${state}`;
  res.json({ url });
});

// ── GET /meta/callback — OAuth code exchange (no JWT required) ───
router.get('/meta/callback', async (req, res) => {
  const { code, state, error: fbError } = req.query;

  if (fbError) {
    return res.redirect('/broker?fb_ads=error&reason=' + encodeURIComponent(fbError));
  }

  const stateData = oauthStates.get(state);
  if (!stateData) {
    return res.redirect('/broker?fb_ads=error&reason=invalid_state');
  }
  oauthStates.delete(state);

  const { FB_APP_ID, FB_APP_SECRET, BASE_URL } = process.env;
  if (!FB_APP_ID || !FB_APP_SECRET) {
    return res.redirect('/broker?fb_ads=error&reason=not_configured');
  }

  try {
    // 1. Exchange code for short-lived token
    const tokenData = await graph(
      `/oauth/access_token?client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&redirect_uri=${encodeURIComponent(BASE_URL + '/api/paid-ads/meta/callback')}&code=${code}`,
      ''
    ).then(r => r.access_token ? r : Promise.reject(r));

    // 2. Exchange for long-lived token (60 days)
    const longData = await graph(
      `/oauth/access_token?grant_type=fb_exchange_token&client_id=${FB_APP_ID}&client_secret=${FB_APP_SECRET}&fb_exchange_token=${tokenData.access_token}`,
      ''
    );
    const longToken = longData.access_token || tokenData.access_token;

    // 3. Get Facebook user info + ad accounts
    const meData = await graph('/me?fields=id,name', longToken);
    const aaData = await graph('/me/adaccounts?fields=id,name,account_status,currency,balance', longToken);

    // 4. Store in user _extra
    const user = store.getUserById(stateData.userId);
    if (!user) return res.redirect('/broker?fb_ads=error&reason=user_not_found');

    if (!user._extra || typeof user._extra !== 'object') user._extra = {};
    user._extra.fb_ads = {
      connected:      true,
      token:          longToken,
      fb_user_id:     meData.id,
      fb_user_name:   meData.name,
      ad_accounts:    (aaData.data || []).map(a => ({
        id:       a.id,
        name:     a.name,
        status:   a.account_status,
        currency: a.currency,
      })),
      selected_account: (aaData.data || [])[0]?.id || null,
      connected_at:   new Date().toISOString(),
    };
    store.saveUser(user);

    res.redirect('/broker?fb_ads=connected');
  } catch(err) {
    console.error('[PaidAds] OAuth callback error:', err);
    res.redirect('/broker?fb_ads=error&reason=token_exchange_failed');
  }
});

// ── GET /meta/status — connection status + ad accounts ──────────
router.get('/meta/status', userAuth, requireBroker, (req, res) => {
  const fbAds = req.brokerUser._extra?.fb_ads;
  if (!fbAds?.connected) return res.json({ connected: false });

  res.json({
    connected:        true,
    fb_user_name:     fbAds.fb_user_name,
    ad_accounts:      fbAds.ad_accounts || [],
    selected_account: fbAds.selected_account,
    connected_at:     fbAds.connected_at,
  });
});

// ── POST /meta/select-account — choose which ad account to use ───
router.post('/meta/select-account', userAuth, requireBroker, (req, res) => {
  const { account_id } = req.body;
  const user = req.brokerUser;
  if (!user._extra?.fb_ads?.connected) return res.status(400).json({ error: 'No conectado' });

  const accounts = user._extra.fb_ads.ad_accounts || [];
  if (!accounts.find(a => a.id === account_id)) {
    return res.status(400).json({ error: 'Cuenta no encontrada' });
  }
  user._extra.fb_ads.selected_account = account_id;
  store.saveUser(user);
  res.json({ success: true, selected_account: account_id });
});

// ── POST /meta/disconnect — remove connection ────────────────────
router.post('/meta/disconnect', userAuth, requireBroker, (req, res) => {
  const user = req.brokerUser;
  if (user._extra) delete user._extra.fb_ads;
  store.saveUser(user);
  res.json({ success: true });
});

// ── POST /meta/campaigns — create a full Meta campaign ──────────
router.post('/meta/campaigns', userAuth, requireBroker, async (req, res) => {
  const user  = req.brokerUser;
  const fbAds = user._extra?.fb_ads;
  if (!fbAds?.connected || !fbAds.token) {
    return res.status(400).json({ error: 'Cuenta de Facebook Ads no conectada' });
  }

  const {
    listing_id,
    headline,      // max 40 chars
    primary_text,  // max 125 chars
    cta_type,      // LEARN_MORE | GET_QUOTE | CONTACT_US | SHOP_NOW
    budget_type,   // DAILY | LIFETIME
    budget_usd,    // numeric (USD cents on Meta side → we multiply by 100)
    duration_days,
    targeting_preset, // locals | international | tourist | custom
    age_min,
    age_max,
    account_id,
  } = req.body;

  const token     = fbAds.token;
  const adAccount = account_id || fbAds.selected_account;
  if (!adAccount) return res.status(400).json({ error: 'No hay cuenta de anuncios seleccionada' });

  // Look up listing for URL and image
  const listing = store.getListingById(listing_id);
  if (!listing) return res.status(404).json({ error: 'Propiedad no encontrada' });

  const listingUrl = `https://hogaresrd.com/listing/${listing_id}`;
  const imageUrl   = listing.images?.[0] || null;

  try {
    // 1. Create Campaign
    const campaignRes = await graph(`/${adAccount}/campaigns`, token, 'POST', {
      name:      `HogaresRD - ${listing.title?.slice(0,50)} - ${new Date().toLocaleDateString('es-DO')}`,
      objective: 'OUTCOME_TRAFFIC',
      status:    'ACTIVE',
      special_ad_categories: [],
    });
    if (campaignRes.error) throw new Error(campaignRes.error.message);
    const campaignId = campaignRes.id;

    // 2. Build targeting
    const startTime = new Date();
    const endTime   = new Date(startTime.getTime() + duration_days * 86400000);

    const TARGETING_PRESETS = {
      locals: {
        geo_locations: { countries: ['DO'] },
        age_min: 25, age_max: 60,
      },
      international: {
        geo_locations: { countries: ['US', 'CA', 'GB', 'ES', 'FR', 'DE', 'IT', 'PR'] },
        age_min: 30, age_max: 65,
      },
      tourist: {
        geo_locations: {
          countries: ['US', 'CA', 'DO'],
          cities: [
            { key: '2422465', name: 'Punta Cana' },
            { key: '2417059', name: 'La Romana' },
          ],
        },
        age_min: 28, age_max: 55,
      },
      custom: {
        geo_locations: { countries: ['DO'] },
        age_min: parseInt(age_min) || 25,
        age_max: parseInt(age_max) || 65,
      },
    };
    const targeting = TARGETING_PRESETS[targeting_preset] || TARGETING_PRESETS.locals;

    // 3. Create Ad Set
    const budgetCents = Math.round(parseFloat(budget_usd) * 100);
    const adsetBody = {
      name:          `AdSet - ${listing.title?.slice(0, 40)}`,
      campaign_id:   campaignId,
      billing_event: 'IMPRESSIONS',
      optimization_goal: 'LINK_CLICKS',
      bid_strategy:  'LOWEST_COST_WITHOUT_CAP',
      targeting,
      start_time:    startTime.toISOString(),
      end_time:      endTime.toISOString(),
      status:        'ACTIVE',
    };
    if (budget_type === 'DAILY') {
      adsetBody.daily_budget = budgetCents;
    } else {
      adsetBody.lifetime_budget = budgetCents;
    }
    const adsetRes = await graph(`/${adAccount}/adsets`, token, 'POST', adsetBody);
    if (adsetRes.error) throw new Error(adsetRes.error.message);
    const adsetId = adsetRes.id;

    // 4. Create Ad Creative
    const creativeBody = {
      name: `Creative - ${listing.title?.slice(0, 40)}`,
      object_story_spec: {
        page_id: await getPageId(token),
        link_data: {
          link:        listingUrl,
          message:     primary_text?.slice(0, 125) || '',
          name:        headline?.slice(0, 40) || listing.title?.slice(0, 40) || '',
          call_to_action: { type: cta_type || 'LEARN_MORE' },
          ...(imageUrl ? { picture: imageUrl } : {}),
        },
      },
    };
    const creativeRes = await graph(`/${adAccount}/adcreatives`, token, 'POST', creativeBody);
    if (creativeRes.error) throw new Error(creativeRes.error.message);
    const creativeId = creativeRes.id;

    // 5. Create Ad
    const adRes = await graph(`/${adAccount}/ads`, token, 'POST', {
      name:        `Ad - ${listing.title?.slice(0, 40)}`,
      adset_id:    adsetId,
      creative:    { creative_id: creativeId },
      status:      'ACTIVE',
    });
    if (adRes.error) throw new Error(adRes.error.message);
    const adId = adRes.id;

    // 6. Store campaign reference in user record
    if (!user._extra.fb_ads.campaigns) user._extra.fb_ads.campaigns = [];
    const campaignRecord = {
      campaign_id:    campaignId,
      adset_id:       adsetId,
      creative_id:    creativeId,
      ad_id:          adId,
      listing_id,
      listing_title:  listing.title,
      listing_city:   listing.city,
      budget_type,
      budget_usd:     parseFloat(budget_usd),
      duration_days:  parseInt(duration_days),
      targeting_preset,
      status:         'ACTIVE',
      created_at:     new Date().toISOString(),
      end_at:         endTime.toISOString(),
      account_id:     adAccount,
    };
    user._extra.fb_ads.campaigns.push(campaignRecord);
    store.saveUser(user);

    res.json({ success: true, campaign: campaignRecord });
  } catch(err) {
    console.error('[PaidAds] Campaign creation error:', err.message);
    res.status(500).json({ error: err.message || 'Error creando campaña en Meta' });
  }
});

// ── GET /meta/campaigns — list campaigns with live stats ─────────
router.get('/meta/campaigns', userAuth, requireBroker, async (req, res) => {
  const user  = req.brokerUser;
  const fbAds = user._extra?.fb_ads;
  if (!fbAds?.connected) return res.json({ campaigns: [] });

  const stored = fbAds.campaigns || [];
  if (!stored.length) return res.json({ campaigns: [] });

  const token = fbAds.token;

  // Fetch live stats from Meta for each campaign
  const campaigns = await Promise.all(stored.map(async c => {
    try {
      const stats = await graph(
        `/${c.campaign_id}/insights?fields=impressions,clicks,spend,reach,cpm,cpc&date_preset=lifetime`,
        token
      );
      const d = stats.data?.[0] || {};

      // Get campaign status
      const info = await graph(`/${c.campaign_id}?fields=status,effective_status`, token);

      return {
        ...c,
        status:      info.status || c.status,
        impressions: parseInt(d.impressions || 0),
        clicks:      parseInt(d.clicks || 0),
        spend_usd:   parseFloat(d.spend || 0).toFixed(2),
        reach:       parseInt(d.reach || 0),
        cpm:         parseFloat(d.cpm || 0).toFixed(2),
        cpc:         parseFloat(d.cpc || 0).toFixed(2),
        ctr:         d.impressions > 0 ? ((d.clicks / d.impressions) * 100).toFixed(2) : '0.00',
      };
    } catch(e) {
      return { ...c, impressions: 0, clicks: 0, spend_usd: '0.00', reach: 0 };
    }
  }));

  res.json({ campaigns });
});

// ── POST /meta/campaigns/:id/toggle-status — pause/resume ────────
router.post('/meta/campaigns/:id/toggle-status', userAuth, requireBroker, async (req, res) => {
  const user  = req.brokerUser;
  const fbAds = user._extra?.fb_ads;
  if (!fbAds?.connected) return res.status(400).json({ error: 'No conectado' });

  const campaignRecord = (fbAds.campaigns || []).find(c => c.campaign_id === req.params.id);
  if (!campaignRecord) return res.status(404).json({ error: 'Campaña no encontrada' });

  const newStatus = campaignRecord.status === 'ACTIVE' ? 'PAUSED' : 'ACTIVE';
  const r = await graph(`/${req.params.id}`, fbAds.token, 'POST', { status: newStatus });
  if (r.error) return res.status(400).json({ error: r.error.message });

  campaignRecord.status = newStatus;
  store.saveUser(user);
  res.json({ success: true, status: newStatus });
});

// ── DELETE /meta/campaigns/:id ────────────────────────────────────
router.delete('/meta/campaigns/:id', userAuth, requireBroker, async (req, res) => {
  const user  = req.brokerUser;
  const fbAds = user._extra?.fb_ads;
  if (!fbAds?.connected) return res.status(400).json({ error: 'No conectado' });

  const idx = (fbAds.campaigns || []).findIndex(c => c.campaign_id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Campaña no encontrada' });

  // Archive on Meta side
  await graph(`/${req.params.id}`, fbAds.token, 'POST', { status: 'DELETED' }).catch(() => {});

  fbAds.campaigns.splice(idx, 1);
  store.saveUser(user);
  res.json({ success: true });
});

// ── Helper: get first Page ID for the ad account's business ──────
async function getPageId(token) {
  try {
    const pages = await graph('/me/accounts?fields=id&limit=1', token);
    return pages.data?.[0]?.id || '0';
  } catch(e) {
    return '0';
  }
}

module.exports = router;
