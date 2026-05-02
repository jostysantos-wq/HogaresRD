// ═══════════════════════════════════════════════════════════════════
// HogaresRD — shared dashboard topbar controllers.
//
// Auto-wires two widgets on any page that has the dashboard topbar:
//   1. Search dropdown — finds #topbarSearch and converts it into an
//      auto-complete that filters listings, applications, and
//      conversations.
//   2. Notifications dropdown — finds <a aria-label="Notificaciones"> or
//      a button with that label and turns it into a popover backed by
//      /api/notifications.
//
// Each page just needs <link rel="stylesheet" href="/css/dashboard-topbar.css">
// and <script src="/js/dashboard-topbar.js" defer></script>. No markup
// changes required — the script wraps the existing elements at boot.
// ═══════════════════════════════════════════════════════════════════
(function () {
  'use strict';

  // ── Shared helpers ───────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }
  function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
  function norm(s) {
    return String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  }
  function highlight(text, q) {
    if (!q) return escapeHtml(text);
    const safe = escapeHtml(text);
    const re = new RegExp(escapeRegex(escapeHtml(q)), 'ig');
    return safe.replace(re, m => `<span class="tb-res-mark">${m}</span>`);
  }
  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)     return 'ahora';
    if (diff < 3600)   return Math.floor(diff / 60)    + ' min';
    if (diff < 86400)  return Math.floor(diff / 3600)  + ' h';
    if (diff < 604800) return Math.floor(diff / 86400) + ' d';
    return d.toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
  }

  // ───────────────────────────────────────────────────────────────────
  // Search dropdown
  // ───────────────────────────────────────────────────────────────────
  function wireSearch(input) {
    const wrap = input.closest('.tb-search') || input.parentElement;
    if (!wrap) return;

    // Inject the clear button + results panel if they aren't already present.
    let clearBtn = wrap.querySelector('.tb-search-clear');
    if (!clearBtn) {
      clearBtn = document.createElement('button');
      clearBtn.type = 'button';
      clearBtn.className = 'tb-search-clear';
      clearBtn.id = 'tbSearchClear';
      clearBtn.setAttribute('aria-label', 'Limpiar búsqueda');
      clearBtn.tabIndex = -1;
      clearBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      wrap.appendChild(clearBtn);
    }
    let panel = wrap.querySelector('.tb-results');
    if (!panel) {
      panel = document.createElement('div');
      panel.className = 'tb-results';
      panel.id = 'tbResults';
      panel.setAttribute('role', 'listbox');
      panel.hidden = true;
      wrap.appendChild(panel);
    }

    input.setAttribute('autocomplete', 'off');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', panel.id);
    input.setAttribute('aria-autocomplete', 'list');

    const ICONS = {
      property: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12l9-9 9 9"/><path d="M5 10v10h14V10"/><path d="M9 20v-6h6v6"/></svg>',
      person:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a6 6 0 0112 0v1"/></svg>',
      chat:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>',
    };

    const data = {
      listings: (window.__brokerSearchData && window.__brokerSearchData.listings) || null,
      applications: null,
      conversations: null,
    };
    let loading = false;
    let activeIndex = -1;
    let flatItems = [];
    let debounceTimer = 0;

    // Listings may be published asynchronously by the host page (e.g. the
    // broker dashboard's load() handler). If they arrive after we boot,
    // pick them up.
    window.addEventListener('brokerSearch:listings', () => {
      if (window.__brokerSearchData && Array.isArray(window.__brokerSearchData.listings)) {
        data.listings = window.__brokerSearchData.listings;
        if (!panel.hidden) render(input.value);
      }
    });

    const fmtUSDshort = (n) => {
      if (!Number.isFinite(n)) return '';
      if (n >= 1e6) return `US$ ${(n / 1e6).toFixed(1)}M`;
      if (n >= 1e3) return `US$ ${(n / 1e3).toFixed(0)}K`;
      return `US$ ${n.toLocaleString()}`;
    };

    async function fetchExtras() {
      if (loading) return;
      if (data.applications && data.conversations && data.listings) return;
      loading = true;
      try {
        const tasks = [];
        if (!data.listings) {
          tasks.push(
            fetch('/api/listings?limit=50', { credentials: 'include' })
              .then(r => r.ok ? r.json() : null)
              .then(j => { data.listings = (j && (j.listings || j)) || []; })
              .catch(() => { data.listings = []; })
          );
        }
        if (!data.applications) {
          tasks.push(
            fetch('/api/applications', { credentials: 'include' })
              .then(r => r.ok ? r.json() : [])
              .then(arr => { data.applications = Array.isArray(arr) ? arr : []; })
              .catch(() => { data.applications = []; })
          );
        }
        if (!data.conversations) {
          tasks.push(
            fetch('/api/conversations', { credentials: 'include' })
              .then(r => r.ok ? r.json() : [])
              .then(arr => { data.conversations = Array.isArray(arr) ? arr : []; })
              .catch(() => { data.conversations = []; })
          );
        }
        await Promise.all(tasks);
      } finally {
        loading = false;
      }
    }

    function searchListings(qn) {
      if (!Array.isArray(data.listings)) return [];
      const out = [];
      for (const l of data.listings) {
        const hay = norm([
          l.title, l.location, l.city, l.province, l.id,
          l.propertyType, l.property_type,
        ].filter(Boolean).join(' '));
        if (hay.includes(qn)) out.push(l);
        if (out.length >= 5) break;
      }
      return out;
    }
    function searchApplications(qn) {
      if (!Array.isArray(data.applications)) return [];
      const out = [];
      for (const a of data.applications) {
        const c = a.client || {};
        const hay = norm([
          c.name, c.full_name, c.email, c.phone, a.id, a.status,
          a.listingTitle, a.listing_title,
        ].filter(Boolean).join(' '));
        if (hay.includes(qn)) out.push(a);
        if (out.length >= 5) break;
      }
      return out;
    }
    function searchConversations(qn) {
      if (!Array.isArray(data.conversations)) return [];
      const out = [];
      for (const c of data.conversations) {
        const hay = norm([
          c.clientName, c.clientEmail, c.propertyTitle, c.lastMessage, c.id,
        ].filter(Boolean).join(' '));
        if (hay.includes(qn)) out.push(c);
        if (out.length >= 5) break;
      }
      return out;
    }

    function buildSection(title, items, q) {
      if (!items.length) return '';
      const rows = items.map(it => `
        <a class="tb-res-item" href="${escapeHtml(it.href)}" data-href="${escapeHtml(it.href)}">
          <span class="tb-res-icon">${it.icon}</span>
          <span class="tb-res-body">
            <div class="tb-res-title">${highlight(it.title, q)}</div>
            <div class="tb-res-sub">${highlight(it.sub, q)}</div>
          </span>
        </a>`).join('');
      return `<div class="tb-res-section-h">${title}</div>${rows}`;
    }

    function buildItems(q) {
      const qn = norm(q);
      const out = { listings: [], clients: [], conversations: [] };
      if (!qn) return out;

      out.listings = searchListings(qn).map(l => {
        const isRent = (l.listingType === 'alquiler' || l.listing_type === 'alquiler');
        const loc = [l.location, l.city, l.province].filter(Boolean).join(', ') || 'República Dominicana';
        const price = Number(l.price) || 0;
        const priceText = price ? (isRent ? `${fmtUSDshort(price)}/mes` : fmtUSDshort(price)) : (isRent ? 'Alquiler' : 'Venta');
        return {
          icon: ICONS.property,
          title: l.title || 'Sin título',
          sub: `${priceText} · ${loc}`,
          href: `/listing.html?id=${encodeURIComponent(l.id)}`,
        };
      });

      out.clients = searchApplications(qn).map(a => {
        const c = a.client || {};
        const name = c.name || c.full_name || c.email || 'Cliente';
        const status = a.status ? a.status.replace(/_/g, ' ') : 'aplicación';
        const lt = a.listingTitle || a.listing_title || '';
        const sub = lt ? `${status} · ${lt}` : status;
        return {
          icon: ICONS.person,
          title: name,
          sub,
          href: `/aplicaciones.html?app=${encodeURIComponent(a.id)}`,
        };
      });

      out.conversations = searchConversations(qn).map(c => ({
        icon: ICONS.chat,
        title: c.clientName || 'Conversación',
        sub: c.lastMessage || c.propertyTitle || 'Mensajes',
        href: `/mensajes.html?conv=${encodeURIComponent(c.id)}`,
      }));

      return out;
    }

    function render(q) {
      const trimmed = (q || '').trim();
      wrap.classList.toggle('has-text', trimmed.length > 0);

      if (!trimmed) {
        panel.innerHTML = '<div class="tb-res-empty">Escribe para buscar propiedades, clientes o conversaciones</div>';
        flatItems = [];
        activeIndex = -1;
        return;
      }
      const groups = buildItems(trimmed);
      const total = groups.listings.length + groups.clients.length + groups.conversations.length;
      if (total === 0) {
        const stillLoading = data.applications == null || data.conversations == null || data.listings == null;
        panel.innerHTML = `<div class="tb-res-empty">${stillLoading ? 'Cargando…' : `Sin resultados para “${escapeHtml(trimmed)}”`}</div>`;
        flatItems = [];
        activeIndex = -1;
        return;
      }
      panel.innerHTML =
        buildSection('Propiedades',    groups.listings,      trimmed) +
        buildSection('Clientes',       groups.clients,       trimmed) +
        buildSection('Conversaciones', groups.conversations, trimmed) +
        '<div class="tb-res-hint">↑ ↓ para navegar · Enter para abrir</div>';

      flatItems = Array.from(panel.querySelectorAll('.tb-res-item'));
      activeIndex = flatItems.length ? 0 : -1;
      updateActive();
    }
    function updateActive() {
      flatItems.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
      if (activeIndex >= 0 && flatItems[activeIndex]) {
        flatItems[activeIndex].scrollIntoView({ block: 'nearest' });
      }
    }
    function open()  { panel.hidden = false; input.setAttribute('aria-expanded', 'true'); }
    function close() { panel.hidden = true;  input.setAttribute('aria-expanded', 'false'); activeIndex = -1; }

    input.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      open();
      render(input.value);
      debounceTimer = window.setTimeout(async () => {
        await fetchExtras();
        if (!panel.hidden) render(input.value);
      }, 120);
    });
    input.addEventListener('focus', () => {
      open();
      render(input.value);
      fetchExtras().then(() => { if (!panel.hidden) render(input.value); });
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') {
        if (panel.hidden) { open(); render(input.value); return; }
        if (!flatItems.length) return;
        e.preventDefault();
        activeIndex = (activeIndex + 1) % flatItems.length;
        updateActive();
      } else if (e.key === 'ArrowUp') {
        if (!flatItems.length) return;
        e.preventDefault();
        activeIndex = (activeIndex - 1 + flatItems.length) % flatItems.length;
        updateActive();
      } else if (e.key === 'Enter') {
        if (activeIndex >= 0 && flatItems[activeIndex]) {
          e.preventDefault();
          location.href = flatItems[activeIndex].dataset.href;
        }
      } else if (e.key === 'Escape') {
        if (input.value) { input.value = ''; render(''); return; }
        close();
        input.blur();
      }
    });
    clearBtn.addEventListener('click', () => {
      input.value = '';
      render('');
      input.focus();
    });
    // Capture phase so we still fire even if a sibling toggle (the account
    // menu's settings/avatar buttons) calls e.stopPropagation() during
    // bubble — otherwise opening the account menu wouldn't close us.
    document.addEventListener('click', (e) => {
      if (panel.hidden) return;
      if (!wrap.contains(e.target)) close();
    }, true);
  }

  // ───────────────────────────────────────────────────────────────────
  // Notifications dropdown
  // ───────────────────────────────────────────────────────────────────
  function wireNotifications(bell) {
    // bell may be an <a> link or a <button>. Replace with a button so we
    // can toggle a popover instead of navigating away. Preserve aria-label
    // and the icon-dot child.
    const orig = bell;
    let btn;
    if (orig.tagName === 'A') {
      btn = document.createElement('button');
      btn.type = 'button';
      // Copy classes (but not href).
      btn.className = orig.className + ' tb-notif-btn';
      btn.setAttribute('aria-label', orig.getAttribute('aria-label') || 'Notificaciones');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
      btn.id = orig.id || 'tbNotifBtn';
      // Move children (svg + dot) over.
      while (orig.firstChild) btn.appendChild(orig.firstChild);
      orig.parentNode.replaceChild(btn, orig);
    } else {
      btn = orig;
      btn.classList.add('tb-notif-btn');
      btn.setAttribute('aria-haspopup', 'menu');
      btn.setAttribute('aria-expanded', 'false');
    }

    // Wrap so the dropdown can position absolutely against the button.
    const wrap = document.createElement('div');
    wrap.className = 'tb-notif-wrap';
    wrap.id = 'tbNotifWrap';
    btn.parentNode.insertBefore(wrap, btn);
    wrap.appendChild(btn);

    // Build the dropdown markup.
    const menu = document.createElement('div');
    menu.className = 'tb-notif-menu';
    menu.id = 'tbNotifMenu';
    menu.setAttribute('role', 'menu');
    menu.hidden = true;
    menu.innerHTML = `
      <div class="tb-notif-head">
        <span class="tb-notif-title">Notificaciones</span>
        <button type="button" class="tb-notif-mark" id="tbNotifMark" disabled>Marcar todas leídas</button>
      </div>
      <div class="tb-notif-list" id="tbNotifList">
        <div class="tb-notif-empty">Cargando…</div>
      </div>
      <div class="tb-notif-foot"><a href="/notificaciones">Ver todas</a></div>`;
    wrap.appendChild(menu);

    const list    = menu.querySelector('#tbNotifList');
    const markBtn = menu.querySelector('#tbNotifMark');
    const dot     = btn.querySelector('#notifDot, .tb-icon-dot');

    const NOTIF_EMOJI = {
      application: '📄', applications: '📄',
      tour: '📅', tours: '📅', visit: '📅', visita: '📅',
      payment: '💳', payments: '💳',
      message: '💬', messages: '💬', conversation: '💬',
      commission: '💰', comision: '💰',
      listing: '🏠', listings: '🏠',
      document: '📋', documents: '📋',
      system: '🔔', default: '🔔',
    };
    function notifIcon(n) {
      const k = String(n.category || n.type || 'default').toLowerCase();
      return NOTIF_EMOJI[k] || NOTIF_EMOJI.default;
    }
    function isRead(n) {
      return n.read === true || n.is_read === true || !!n.read_at || !!n.readAt;
    }

    let cache = null;

    function renderList(items) {
      if (!items.length) {
        list.innerHTML = '<div class="tb-notif-empty">Estás al día. No hay notificaciones.</div>';
        return;
      }
      list.innerHTML = items.map(n => {
        const text   = escapeHtml(n.title || n.message || n.body || 'Notificación');
        const time   = escapeHtml(relTime(n.created_at || n.createdAt || n.timestamp));
        const href   = n.url || n.link || '/notificaciones';
        const unread = !isRead(n);
        return `<a class="tb-notif-item ${unread ? 'unread' : ''}" href="${escapeHtml(href)}" data-id="${escapeHtml(n.id || '')}">
          <span class="tb-notif-icon">${notifIcon(n)}</span>
          <span class="tb-notif-body">
            <span class="tb-notif-text">${text}</span>
            ${time ? `<span class="tb-notif-time">${time}</span>` : ''}
          </span>
          ${unread ? '<span class="tb-notif-unread-dot" aria-hidden="true"></span>' : ''}
        </a>`;
      }).join('');
    }

    async function load() {
      try {
        const r = await fetch('/api/notifications?limit=8', { credentials: 'include' });
        if (!r.ok) throw new Error('http ' + r.status);
        const data  = await r.json();
        const items = Array.isArray(data) ? data : (data && data.notifications) || [];
        cache = items;
        renderList(items);
        const anyUnread = items.some(n => !isRead(n));
        markBtn.disabled = !anyUnread;
        if (dot) dot.hidden = !anyUnread;
      } catch (_) {
        list.innerHTML = '<div class="tb-notif-empty">No se pudieron cargar las notificaciones.</div>';
      }
    }

    function setOpen(open) {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      if (open) {
        // Close the account menu if it's open on the same page.
        const acctMenu = document.getElementById('tbMenu');
        if (acctMenu && !acctMenu.hidden) {
          acctMenu.hidden = true;
          document.getElementById('tbSettingsBtn')?.setAttribute('aria-expanded', 'false');
          document.getElementById('tbAvatarBtn')?.setAttribute('aria-expanded', 'false');
        }
        load();
      }
    }

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      setOpen(menu.hidden);
    });

    markBtn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        await fetch('/api/notifications/mark-all-read', { method: 'POST', credentials: 'include' });
      } catch (_) {}
      if (Array.isArray(cache)) {
        cache.forEach(n => { n.read = true; n.read_at = n.read_at || new Date().toISOString(); });
        renderList(cache);
      }
      markBtn.disabled = true;
      if (dot) dot.hidden = true;
    });

    // Capture phase so the account menu's stopPropagation in its toggle
    // doesn't keep us open when the user clicks the settings/avatar
    // buttons.
    document.addEventListener('click', (e) => {
      if (menu.hidden) return;
      if (!wrap.contains(e.target)) setOpen(false);
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !menu.hidden) setOpen(false);
    });

    // Initial unread count — fail silent.
    fetch('/api/notifications/unread-count', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        if (!dot || !d) return;
        const n = Number(d.count ?? d.unread ?? 0);
        if (n > 0) dot.hidden = false;
      })
      .catch(() => {});
  }

  // ───────────────────────────────────────────────────────────────────
  // Active sidebar link visibility
  //
  // The sidebar nav scrolls internally (.sb-nav has overflow-y: auto on a
  // viewport-height parent), so on shorter screens the active row can be
  // below the fold inside the sidebar. On team-only pages (Rendimiento,
  // Miembros, etc.) the active link also starts with `hidden` and is
  // revealed asynchronously after /api/auth/me resolves — by then the
  // user's already looking at a sidebar with no visible selection. Scroll
  // the active link into view (within the nav, not the page).
  // ───────────────────────────────────────────────────────────────────
  function ensureActiveSidebarVisible() {
    const active = document.querySelector('.sidebar .sb-link.active');
    if (!active) return;
    const reveal = () => active.scrollIntoView({ block: 'nearest' });
    if (!active.hidden) { reveal(); return; }
    const obs = new MutationObserver(() => {
      if (!active.hidden) { obs.disconnect(); reveal(); }
    });
    obs.observe(active, { attributes: true, attributeFilter: ['hidden'] });
  }

  // ── Boot ─────────────────────────────────────────────────────────
  function boot() {
    const input = document.getElementById('topbarSearch');
    if (input) wireSearch(input);

    // Match either an <a> or a <button> with the bell aria-label, scoped
    // to the topbar so we don't accidentally hijack the same label
    // elsewhere on the page.
    const topbar = document.querySelector('.topbar') || document;
    const bell = topbar.querySelector('a[aria-label="Notificaciones"], button[aria-label="Notificaciones"]:not(.tb-notif-btn)');
    if (bell) wireNotifications(bell);

    ensureActiveSidebarVisible();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
