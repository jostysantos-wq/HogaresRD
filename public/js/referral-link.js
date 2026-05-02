// ═══════════════════════════════════════════════════════════════════
// HogaresRD — referral link propagation.
//
// When a visitor lands on the site through an affiliate link
// (/r/<token> or any URL with ?ref=<token>), the server sets an
// hrd_ref cookie. This helper exposes that token to client code so
// listing-card builders on /comprar, /home, /ciudad, /mapa,
// /nuevos-proyectos, and /comparar can append `?ref=<token>` to every
// internal /listing/<id> link they emit. Without it, a referred
// client who clicks any listing card from the marketplace loses
// attribution and the URL no longer credits the originating agent.
//
// Public API:
//   HRD_REF.getRefToken() → string|null   — current ref (URL > cookie)
//   HRD_REF.withRef(href) → string        — same href + ?ref=… if available
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  function readToken() {
    try {
      const url = new URLSearchParams(location.search).get('ref');
      if (url && /^[a-f0-9]{16}$/i.test(url)) return url;
    } catch {}
    try {
      const m = document.cookie.match(/(?:^|;\s*)hrd_ref=([a-f0-9]{16})\b/i);
      if (m) return m[1];
    } catch {}
    return null;
  }

  const TOKEN = readToken();

  function withRef(href) {
    if (!TOKEN) return href;
    if (typeof href !== 'string' || !href) return href;
    // If the URL already carries a ref, leave it alone.
    if (/[?&]ref=[a-f0-9]{16}\b/i.test(href)) return href;
    const sep = href.includes('?') ? '&' : '?';
    return href + sep + 'ref=' + encodeURIComponent(TOKEN);
  }

  window.HRD_REF = { getRefToken: () => TOKEN, withRef };
})();
