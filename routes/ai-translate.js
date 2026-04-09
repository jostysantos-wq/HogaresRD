/**
 * ai-translate.js — Claude-powered listing translation
 *
 * Translates listing content (title, description, amenities, tags)
 * from Spanish to English. Results are cached in listing._extra.translations.
 *
 * GET /api/listings/:id/translate?lang=en
 */

'use strict';

const Anthropic = require('@anthropic-ai/sdk');
const store     = require('./store');
const express   = require('express');
const router    = express.Router();

const API_KEY   = process.env.ANTHROPIC_API_KEY;
const anthropic = API_KEY ? new Anthropic({ apiKey: API_KEY }) : null;

// Amenity translations (static — no AI needed)
const AMENITY_MAP = {
  piscina: 'Pool', jacuzzi: 'Jacuzzi', gym: 'Gym', bbq: 'BBQ Area',
  balcon: 'Balcony / Terrace', jardin: 'Garden', ac: 'Air Conditioning',
  planta: 'Backup Generator', cisterna: 'Water Tank', seguridad: '24/7 Security',
  camaras: 'CCTV Cameras', elevador: 'Elevator', amueblado: 'Furnished',
  semi_amueblado: 'Semi-furnished', paneles_solares: 'Solar Panels',
  vista_mar: 'Ocean View', frente_mar: 'Beachfront', cancha: 'Sports Court',
};

// Tag translations (static)
const TAG_MAP = {
  'Vista al mar': 'Ocean View', 'Primera línea de playa': 'Beachfront',
  'A pasos de la playa': 'Steps from the Beach', 'Vista panorámica': 'Panoramic View',
  'Frente al campo de golf': 'Golf Course Frontage', 'Zona montañosa / fresca': 'Mountain / Cool Area',
  'Zona turística': 'Tourist Zone', 'Zona residencial cerrada': 'Gated Community',
  'Centro de la ciudad': 'City Center', 'Barrio tranquilo': 'Quiet Neighborhood',
  'Cerca de autopista': 'Near Highway', 'Zona en desarrollo': 'Developing Area',
  'Con generador': 'Generator', 'Con inversor / batería': 'Inverter / Battery',
  'Con paneles solares': 'Solar Panels', 'Con cisterna': 'Water Tank',
  'Con bomba de agua': 'Water Pump', 'Vigilancia 24 horas': '24-Hour Security',
  'Con verja / seguridad privada': 'Gated / Private Security',
  'Apto para familias': 'Family Friendly', 'Pet friendly': 'Pet Friendly',
  'Cerca de colegios': 'Near Schools', 'Cerca de hospitales': 'Near Hospitals',
  'Cerca de centros comerciales': 'Near Shopping Centers',
  'Cerca de supermercados': 'Near Supermarkets', 'Vida nocturna cercana': 'Nightlife Nearby',
  'Alta rentabilidad': 'High ROI', 'Apto para Airbnb': 'Airbnb Ready',
  'Alquiler vacacional': 'Vacation Rental', 'Zona de revalorización': 'Appreciating Area',
  'Precio de oportunidad': 'Great Deal', 'Proyecto de lujo': 'Luxury Project',
  'Amueblado': 'Furnished', 'Remodelado / Renovado': 'Remodeled / Renovated',
  'Listo para mudarse': 'Move-in Ready', 'Con piscina privada': 'Private Pool',
  'Con piscina comunitaria': 'Community Pool', 'Con terraza / balcón amplio': 'Large Terrace / Balcony',
  'Con área de BBQ': 'BBQ Area', 'Acceso a playa privada': 'Private Beach Access',
};

// Condition translations
const CONDITION_MAP = {
  'Nueva construcción': 'New Construction', 'En planos': 'Pre-construction',
  'Excelente estado': 'Excellent Condition', 'Buen estado': 'Good Condition',
  'Necesita remodelación': 'Needs Renovation',
};

// Type translations
const TYPE_MAP = {
  'Casa': 'House', 'Apartamento': 'Apartment', 'Villa': 'Villa',
  'Penthouse': 'Penthouse', 'Solar / Terreno': 'Land',
  'Local Comercial': 'Commercial', 'Finca': 'Farm',
};

// Project stage translations
const STAGE_MAP = {
  'En planos': 'Pre-construction', 'Inicio de construcción': 'Early Construction',
  'Estructura': 'Structure Phase', 'Acabados': 'Finishing Phase',
  'Listo para entrega': 'Ready for Delivery',
};

/**
 * Translate title + description using Claude (cached).
 */
async function translateListing(listing, targetLang) {
  if (targetLang !== 'en') return null;

  // Check cache
  const cached = listing._extra?.translations?.en;
  if (cached) return cached;

  // Static translations (no AI needed)
  const result = {
    type: TYPE_MAP[listing.type] || listing.type,
    condition: CONDITION_MAP[listing.condition] || listing.condition,
    project_stage: STAGE_MAP[listing.project_stage] || listing.project_stage,
    amenities: (listing.amenities || []).map(a => AMENITY_MAP[a] || a),
    tags: (listing.tags || []).map(t => TAG_MAP[t] || t),
  };

  // AI translate title + description
  if (anthropic && (listing.title || listing.description)) {
    try {
      const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Translate this Dominican Republic real estate listing from Spanish to English. Keep it natural, professional, and appealing to US-based Dominican buyers. Preserve location names (Piantini, Punta Cana, etc.) as-is. Return ONLY valid JSON with "title" and "description" keys.

Title: ${listing.title || ''}
Description: ${listing.description || ''}`,
        }],
      });

      const text = response.content[0]?.text || '';
      // Extract JSON from response
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        result.title = parsed.title || listing.title;
        result.description = parsed.description || listing.description;
      }
    } catch (err) {
      console.error('[ai-translate] Translation error:', err.message);
      // Fall back to original
      result.title = listing.title;
      result.description = listing.description;
    }
  } else {
    result.title = listing.title;
    result.description = listing.description;
  }

  // Cache the translation on the listing
  const extra = listing._extra || {};
  if (!extra.translations) extra.translations = {};
  extra.translations.en = result;
  listing._extra = extra;
  store.saveListing(listing);

  return result;
}

// ── API Endpoint ────────────────────────────────────────────────

// GET /api/listings/:id/translate?lang=en
router.get('/:id/translate', async (req, res) => {
  const { lang } = req.query;
  if (!lang || lang === 'es') return res.json({ lang: 'es', translated: false });

  const listing = store.getListingById(req.params.id);
  if (!listing) return res.status(404).json({ error: 'Listing not found' });

  try {
    const translation = await translateListing(listing, lang);
    if (!translation) return res.json({ lang, translated: false });
    res.json({ lang, translated: true, ...translation });
  } catch (err) {
    console.error('[ai-translate] Endpoint error:', err.message);
    res.status(500).json({ error: 'Translation failed' });
  }
});

module.exports = { router, translateListing };
