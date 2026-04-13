/**
 * Cookie Consent Banner — CCPA-compliant minimal notice.
 * Self-initializing: just include <script src="/js/cookie-consent.js"></script>
 * on any page. Shows once; remembers dismissal in localStorage.
 */
(function () {
  'use strict';
  var KEY = 'hrd_cookie_consent';
  if (localStorage.getItem(KEY)) return;

  var banner = document.createElement('div');
  banner.id = 'cookie-consent';
  banner.setAttribute('role', 'dialog');
  banner.setAttribute('aria-label', 'Aviso de cookies');
  banner.innerHTML =
    '<div style="display:flex;align-items:center;justify-content:center;gap:1rem;flex-wrap:wrap;">' +
      '<span>Este sitio usa cookies para mejorar tu experiencia. ' +
        '<a href="/privacidad" style="color:inherit;text-decoration:underline;">Privacidad</a> · ' +
        '<a href="/privacidad#do-not-sell" style="color:inherit;text-decoration:underline;font-weight:600;">No Vender Mis Datos</a></span>' +
      '<button id="cookie-accept" style="background:#2563eb;color:#fff;border:none;padding:0.4rem 1.2rem;border-radius:6px;cursor:pointer;font-size:0.82rem;white-space:nowrap;">Aceptar</button>' +
    '</div>';

  var s = banner.style;
  s.position = 'fixed';
  s.bottom = '0';
  s.left = '0';
  s.right = '0';
  s.background = 'rgba(30,30,30,0.95)';
  s.color = '#eee';
  s.padding = '0.85rem 1.5rem';
  s.fontSize = '0.82rem';
  s.lineHeight = '1.5';
  s.zIndex = '99999';
  s.textAlign = 'center';
  s.boxShadow = '0 -2px 12px rgba(0,0,0,0.25)';

  document.body.appendChild(banner);

  document.getElementById('cookie-accept').addEventListener('click', function () {
    localStorage.setItem(KEY, '1');
    banner.remove();
  });
})();
