/**
 * HogaresRD — Meta Pixel client
 * Fetches the Pixel ID from the server, initialises the Facebook Pixel SDK,
 * fires PageView automatically, and exposes window.MetaPixel for custom events.
 *
 * Include on every page:
 *   <script src="/js/pixel.js" defer></script>
 */
(function () {
  'use strict';

  // ── Load the Facebook Pixel SDK (standard snippet) ────────────────────
  /* eslint-disable */
  !function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?
  n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;
  n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;
  t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}
  (window,document,'script','https://connect.facebook.net/en_US/fbevents.js');
  /* eslint-enable */

  // ── Fetch Pixel ID from server and initialise ──────────────────────────
  fetch('/api/config/meta')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (cfg) {
      if (!cfg || !cfg.pixelId) return; // not configured — silently skip
      window.fbq('init', cfg.pixelId);
      window.fbq('track', 'PageView');
    })
    .catch(function () {});

  // ── Public API ─────────────────────────────────────────────────────────
  /**
   * window.MetaPixel.track(eventName, data, eventId?)
   *   eventId should match the server-side CAPI call for deduplication.
   *
   * window.MetaPixel.trackCustom(eventName, data, eventId?)
   */
  window.MetaPixel = {
    track: function (eventName, data, eventId) {
      if (!window.fbq) return;
      window.fbq('track', eventName, data || {}, eventId ? { eventID: eventId } : {});
    },
    trackCustom: function (eventName, data, eventId) {
      if (!window.fbq) return;
      window.fbq('trackCustom', eventName, data || {}, eventId ? { eventID: eventId } : {});
    },
  };
})();
