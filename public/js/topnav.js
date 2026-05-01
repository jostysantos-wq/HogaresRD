/* ═══════════════════════════════════════════════════════════════════
 * topnav.js — Builds the shared editorial pill nav
 *
 * Usage:
 *   <link rel="stylesheet" href="/css/topnav.css">
 *   <div id="topnav-mount"></div>
 *   <script src="/js/topnav.js" defer></script>
 *
 * The script also auto-removes legacy <nav>...</nav> blocks on the
 * page so we don't render two navs side-by-side during the migration.
 *
 * Active link is derived from window.location.pathname.
 * Auth state comes from /api/auth/me (cached for 60s in sessionStorage).
 * ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const LINKS = [
    { href: '/home',                          label: 'Inicio',    match: ['/', '/home'] },
    { href: '/comprar',                       label: 'Comprar',   match: ['/comprar', '/mapa'] },
    { href: '/comprar?type=alquiler',         label: 'Alquilar',  match: ['/alquilar'] },
    { href: '/busquedas-guardadas',           label: 'Favoritos', match: ['/busquedas-guardadas'] },
    { href: '/comprar?type=proyecto',         label: 'Proyectos', match: ['/nuevos-proyectos'] },
    { href: '/blog',                          label: 'Blog',      match: ['/blog', '/post'] },
  ];

  const ICONS = {
    msg:    '<svg viewBox="0 0 24 24"><path d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/></svg>',
    bell:   '<svg viewBox="0 0 24 24"><path d="M12 22a2 2 0 002-2h-4a2 2 0 002 2zm6-6V11a6 6 0 00-5-5.91V4a1 1 0 10-2 0v1.09A6 6 0 006 11v5l-2 2v1h16v-1l-2-2z"/></svg>',
    caret:  '<svg viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>',
    logo:   '<svg viewBox="120 70 280 290" fill="none">' +
            '<line x1="154" y1="88" x2="154" y2="340" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '<line x1="358" y1="88" x2="358" y2="340" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '<line x1="182" y1="238" x2="256" y2="188" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '<line x1="256" y1="188" x2="330" y2="238" stroke="#fff" stroke-width="22" stroke-linecap="square"/>' +
            '</svg>',
    // Outline icons for the account menu rows (1.5px stroke style)
    dashboard: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
    home:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7v9a2 2 0 0 1-2 2h-4v-7h-6v7H5a2 2 0 0 1-2-2v-9z"/></svg>',
    file:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/></svg>',
    bellOl:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    heart:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 1 0-7.78 7.78L12 21.23l8.84-8.84a5.5 5.5 0 0 0 0-7.78z"/></svg>',
    settings:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>',
    help:      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    extLink:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
    logout:    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>',
  };

  const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora', 'secretary'];

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function activeFor(path) {
    const p = (path || '/').split('?')[0];
    return LINKS.find(l => l.match.some(m => m === p || (m !== '/' && p.startsWith(m + '/'))))
        || LINKS.find(l => l.match.includes(p));
  }

  function buildLinks() {
    const here = activeFor(window.location.pathname);
    return LINKS.map(l => {
      const isActive = here && here.href === l.href;
      return `<a class="nav-link${isActive ? ' active' : ''}" href="${l.href}">${l.label}</a>`;
    }).join('');
  }

  function buildShell() {
    const wrap = document.getElementById('topnav-mount');
    if (!wrap) return null;
    wrap.outerHTML = `
      <nav class="topnav-v2" aria-label="Principal">
        <div class="nav-inner">
          <a class="logo" href="/home" aria-label="HogaresRD">
            <div class="logo-icon">${ICONS.logo}</div>
            <span class="logo-text">Hogares<em>RD</em></span>
          </a>
          <div class="nav-center">
            <div class="nav-links">${buildLinks()}</div>
          </div>
          <div class="nav-actions" id="tnv-actions">
            <!-- lang toggle injected by /js/i18n.js if loaded -->
            <!-- auth UI populated below -->
          </div>
        </div>
      </nav>`;
    return document.querySelector('nav.topnav-v2');
  }

  function renderGuest(actions) {
    actions.insertAdjacentHTML('beforeend',
      '<a href="/submit" class="btn-tn-ghost">Publicar</a>' +
      '<a href="/login" class="btn-tn-dark">Iniciar sesión</a>'
    );
  }

  // Map notification types/categories to a small visual icon for the dropdown.
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

  function relTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'ahora';
    if (diff < 3600) return Math.floor(diff / 60) + ' min';
    if (diff < 86400) return Math.floor(diff / 3600) + ' h';
    if (diff < 604800) return Math.floor(diff / 86400) + ' d';
    return d.toLocaleDateString('es-DO', { day: 'numeric', month: 'short' });
  }

  function renderUser(actions, user) {
    const name = user.name || 'Usuario';
    const email = user.email || '';
    const initials = name.split(' ').map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase() || 'U';
    const isPro = PRO_ROLES.includes(user.role);
    const dashHref = isPro ? '/broker-dashboard.html' : '/my-applications';

    actions.insertAdjacentHTML('beforeend',
      // Messages icon + dropdown
      `<button class="nav-icon" type="button" id="tnv-msg-btn" aria-label="Mensajes" aria-haspopup="menu" aria-expanded="false">${ICONS.msg}<span class="nav-icon-dot" id="tnv-msg-dot" hidden></span></button>` +
      `<div class="nav-pop nav-msg-menu" id="tnv-msg-menu" role="menu" hidden>` +
        `<div class="nav-pop-head">` +
          `<span class="nav-pop-title">Mensajes</span>` +
        `</div>` +
        `<div class="nav-pop-list" id="tnv-msg-list">` +
          `<div class="nav-pop-empty">Cargando…</div>` +
        `</div>` +
        `<div class="nav-pop-foot"><a href="/mensajes">Abrir bandeja de mensajes</a></div>` +
      `</div>` +
      // Bell icon + dropdown
      `<button class="nav-icon" type="button" id="tnv-bell-btn" aria-label="Notificaciones" aria-haspopup="menu" aria-expanded="false">${ICONS.bell}<span class="nav-icon-dot" id="tnv-bell-dot" hidden></span></button>` +
      `<div class="nav-pop nav-notif-menu" id="tnv-notif-menu" role="menu" hidden>` +
        `<div class="nav-pop-head">` +
          `<span class="nav-pop-title">Notificaciones</span>` +
          `<button class="nav-pop-mark" type="button" id="tnv-notif-mark" disabled>Marcar todas leídas</button>` +
        `</div>` +
        `<div class="nav-pop-list" id="tnv-notif-list">` +
          `<div class="nav-pop-empty">Cargando…</div>` +
        `</div>` +
        `<div class="nav-pop-foot"><a href="/notificaciones">Ver todas</a></div>` +
      `</div>` +
      // User chip + account dropdown
      `<button class="nav-user" type="button" aria-label="Cuenta" aria-haspopup="menu" aria-expanded="false" id="tnv-user-btn">` +
        `<span class="nav-user-avatar">${escapeHtml(initials)}</span>` +
        `<span class="nav-user-meta">` +
          `<span class="nav-user-name">${escapeHtml(name.split(' ')[0])}</span>` +
          `<span class="nav-user-mail">${escapeHtml(email)}</span>` +
        `</span>` +
        `<svg class="nav-user-caret" viewBox="0 0 24 24"><path d="M7 10l5 5 5-5z"/></svg>` +
      `</button>` +
      `<div class="nav-pop nav-user-menu" id="tnv-user-menu" role="menu" hidden>` +
        `<div class="nav-um-head">` +
          `<div class="nav-um-avatar">` +
            `<span>${escapeHtml(initials)}</span>` +
            `<span class="nav-um-presence" aria-label="En línea"></span>` +
          `</div>` +
          `<div class="nav-um-id">` +
            `<span class="nav-um-name">${escapeHtml(name)}</span>` +
            `<span class="nav-um-status">${escapeHtml(email || 'En línea')}</span>` +
          `</div>` +
        `</div>` +
        `<div class="nav-um-section">` +
          `<a class="nav-um-item" href="${dashHref}" role="menuitem">` +
            `<span class="nav-um-icon">${ICONS.dashboard}</span>` +
            `<span class="nav-um-label">Mi panel</span>` +
          `</a>` +
          (isPro
            ? `<a class="nav-um-item" href="/mis-propiedades" role="menuitem"><span class="nav-um-icon">${ICONS.home}</span><span class="nav-um-label">Mis propiedades</span></a>`
            : `<a class="nav-um-item" href="/my-applications" role="menuitem"><span class="nav-um-icon">${ICONS.file}</span><span class="nav-um-label">Mis aplicaciones</span></a>`
          ) +
          `<a class="nav-um-item" href="/notificaciones" role="menuitem">` +
            `<span class="nav-um-icon">${ICONS.bellOl}</span>` +
            `<span class="nav-um-label">Notificaciones</span>` +
          `</a>` +
        `</div>` +
        `<div class="nav-um-section">` +
          `<a class="nav-um-item" href="/busquedas-guardadas" role="menuitem">` +
            `<span class="nav-um-icon">${ICONS.heart}</span>` +
            `<span class="nav-um-label">Favoritos y búsquedas</span>` +
          `</a>` +
          `<a class="nav-um-item" href="/configuracion" role="menuitem">` +
            `<span class="nav-um-icon">${ICONS.settings}</span>` +
            `<span class="nav-um-label">Configuración</span>` +
          `</a>` +
          `<a class="nav-um-item" href="/contacto" role="menuitem">` +
            `<span class="nav-um-icon">${ICONS.help}</span>` +
            `<span class="nav-um-label">Ayuda</span>` +
            `<span class="nav-um-meta">${ICONS.extLink}</span>` +
          `</a>` +
        `</div>` +
        `<div class="nav-um-section">` +
          `<button type="button" class="nav-um-item danger" id="tnv-logout" role="menuitem">` +
            `<span class="nav-um-icon">${ICONS.logout}</span>` +
            `<span class="nav-um-label">Cerrar sesión</span>` +
          `</button>` +
        `</div>` +
      `</div>`
    );

    const userBtn  = document.getElementById('tnv-user-btn');
    const userMenu = document.getElementById('tnv-user-menu');
    const bellBtn  = document.getElementById('tnv-bell-btn');
    const bellMenu = document.getElementById('tnv-notif-menu');
    const msgBtn   = document.getElementById('tnv-msg-btn');
    const msgMenu  = document.getElementById('tnv-msg-menu');

    function closeAll() {
      if (userMenu) { userMenu.hidden = true; userBtn?.setAttribute('aria-expanded', 'false'); }
      if (bellMenu) { bellMenu.hidden = true; bellBtn?.setAttribute('aria-expanded', 'false'); }
      if (msgMenu)  { msgMenu.hidden  = true; msgBtn?.setAttribute('aria-expanded', 'false');  }
    }

    function wireToggle(btn, menu, onOpen) {
      if (!btn || !menu) return;
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const willOpen = menu.hidden;
        closeAll();
        if (willOpen) {
          menu.hidden = false;
          btn.setAttribute('aria-expanded', 'true');
          if (typeof onOpen === 'function') onOpen();
        }
      });
    }

    wireToggle(userBtn, userMenu);
    wireToggle(bellBtn, bellMenu, loadNotifications);
    wireToggle(msgBtn,  msgMenu,  loadMessages);

    document.addEventListener('click', (e) => {
      if (userMenu && !userMenu.hidden && !userMenu.contains(e.target) && !userBtn.contains(e.target)) {
        userMenu.hidden = true; userBtn.setAttribute('aria-expanded', 'false');
      }
      if (bellMenu && !bellMenu.hidden && !bellMenu.contains(e.target) && !bellBtn.contains(e.target)) {
        bellMenu.hidden = true; bellBtn.setAttribute('aria-expanded', 'false');
      }
      if (msgMenu && !msgMenu.hidden && !msgMenu.contains(e.target) && !msgBtn.contains(e.target)) {
        msgMenu.hidden = true; msgBtn.setAttribute('aria-expanded', 'false');
      }
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAll();
    });

    // Logout
    const logout = document.getElementById('tnv-logout');
    if (logout) {
      logout.addEventListener('click', async () => {
        try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch (_) {}
        try { localStorage.removeItem('hogaresrd_user'); } catch (_) {}
        try { sessionStorage.removeItem('tnv_me'); } catch (_) {}
        location.href = '/home';
      });
    }

    // ── Notification panel ───────────────────────────────────────
    let notifCache = null;
    async function loadNotifications() {
      const list = document.getElementById('tnv-notif-list');
      if (!list) return;
      try {
        const r = await fetch('/api/notifications?limit=8', { credentials: 'include' });
        if (!r.ok) throw new Error('http ' + r.status);
        const data = await r.json();
        const items = Array.isArray(data) ? data : (data?.notifications || []);
        notifCache = items;
        if (!items.length) {
          list.innerHTML = '<div class="nav-pop-empty">Estás al día. No hay notificaciones nuevas.</div>';
        } else {
          list.innerHTML = items.map(n => {
            const text  = escapeHtml(n.message || n.title || n.body || '');
            const time  = escapeHtml(relTime(n.created_at || n.createdAt || n.timestamp));
            const href  = n.link || n.url || '/notificaciones';
            const cls   = n.read ? 'nav-pop-item' : 'nav-pop-item unread';
            return `<a class="${cls}" href="${escapeHtml(href)}">` +
                     `<span class="nav-pop-icon emoji">${notifIcon(n)}</span>` +
                     `<span class="nav-pop-body">` +
                       `<span class="nav-pop-text">${text}</span>` +
                       `<span class="nav-pop-time">${time}</span>` +
                     `</span>` +
                   `</a>`;
          }).join('');
        }
        const mark = document.getElementById('tnv-notif-mark');
        const anyUnread = items.some(n => !n.read);
        if (mark) mark.disabled = !anyUnread;
      } catch (_) {
        list.innerHTML = '<div class="nav-pop-empty">No se pudieron cargar las notificaciones.</div>';
      }
    }

    const markBtn = document.getElementById('tnv-notif-mark');
    if (markBtn) {
      markBtn.addEventListener('click', async () => {
        try {
          await fetch('/api/notifications/mark-all-read', { method: 'POST', credentials: 'include' });
        } catch (_) {}
        const dot = document.getElementById('tnv-bell-dot');
        if (dot) dot.hidden = true;
        markBtn.disabled = true;
        if (Array.isArray(notifCache)) {
          notifCache.forEach(n => { n.read = true; });
          loadNotifications();
        }
      });
    }

    // ── Messages panel ───────────────────────────────────────────
    async function loadMessages() {
      const list = document.getElementById('tnv-msg-list');
      if (!list) return;
      try {
        const r = await fetch('/api/conversations', { credentials: 'include' });
        if (!r.ok) throw new Error('http ' + r.status);
        const data = await r.json();
        const all = Array.isArray(data) ? data : (data?.conversations || []);
        // Show conversations where THIS user has unread messages, OR the most
        // recent few if none are unread (so the panel always has content).
        const enriched = all.filter(c => !c.archived).map(c => {
          const meIsBroker = c.brokerId && c.brokerId === user.id;
          const unread = meIsBroker ? (c.unreadBroker || 0) : (c.unreadClient || 0);
          const otherName = meIsBroker
            ? (c.clientName || 'Cliente')
            : (c.brokerName || c.inmobiliariaName || 'HogaresRD');
          const otherAvatar = meIsBroker ? c.clientAvatar : c.brokerAvatar;
          return { ...c, _unread: unread, _otherName: otherName, _otherAvatar: otherAvatar };
        });
        const unreadFirst = enriched
          .sort((a, b) => {
            if ((b._unread > 0) - (a._unread > 0) !== 0) return (b._unread > 0) - (a._unread > 0);
            return new Date(b.updatedAt || b.lastMessageAt || 0) - new Date(a.updatedAt || a.lastMessageAt || 0);
          })
          .slice(0, 6);

        if (!unreadFirst.length) {
          list.innerHTML = '<div class="nav-pop-empty">Aún no tienes conversaciones.</div>';
          return;
        }
        list.innerHTML = unreadFirst.map(c => {
          const initials = (c._otherName || 'U').split(' ').map(n => n[0]).filter(Boolean).slice(0, 2).join('').toUpperCase();
          const avatar = c._otherAvatar
            ? `<img src="${escapeHtml(c._otherAvatar)}" alt="">`
            : escapeHtml(initials);
          const time = escapeHtml(relTime(c.lastMessageAt || c.updatedAt || c.createdAt));
          const text = escapeHtml(c.lastMessage || 'Nueva conversación');
          const cls  = c._unread > 0 ? 'nav-pop-item unread' : 'nav-pop-item';
          const badge = c._unread > 0
            ? `<span class="nav-pop-badge">${c._unread > 9 ? '9+' : c._unread}</span>`
            : '';
          return `<a class="${cls}" href="/mensajes?conv=${encodeURIComponent(c.id)}">` +
                   `<span class="nav-pop-icon">${avatar}</span>` +
                   `<span class="nav-pop-body">` +
                     `<span class="nav-pop-row">` +
                       `<span class="nav-pop-name">${escapeHtml(c._otherName)}</span>` +
                       `<span class="nav-pop-time">${time}</span>` +
                     `</span>` +
                     `<span class="nav-pop-text">${text}</span>` +
                   `</span>` +
                   badge +
                 `</a>`;
        }).join('');
      } catch (_) {
        list.innerHTML = '<div class="nav-pop-empty">No se pudieron cargar los mensajes.</div>';
      }
    }

    // Unread dots — best-effort, fail silent
    fetch('/api/notifications/unread-count', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const dot = document.getElementById('tnv-bell-dot');
        if (dot && d && Number(d.count || d.unread || 0) > 0) dot.hidden = false;
      })
      .catch(() => {});
    fetch('/api/conversations/unread', { credentials: 'include' })
      .then(r => r.ok ? r.json() : null)
      .then(d => {
        const dot = document.getElementById('tnv-msg-dot');
        if (dot && d && Number(d.count || 0) > 0) dot.hidden = false;
      })
      .catch(() => {});
  }

  async function fetchMe() {
    // 60-second sessionStorage cache to avoid /api/auth/me on every page load
    try {
      const cached = sessionStorage.getItem('tnv_me');
      if (cached) {
        const { at, user } = JSON.parse(cached);
        if (Date.now() - at < 60_000) return user;
      }
    } catch (_) {}

    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (!r.ok) {
        try { sessionStorage.setItem('tnv_me', JSON.stringify({ at: Date.now(), user: null })); } catch (_) {}
        return null;
      }
      const data = await r.json();
      const user = data?.user || data;
      const ok = user && user.id ? user : null;
      try { sessionStorage.setItem('tnv_me', JSON.stringify({ at: Date.now(), user: ok })); } catch (_) {}
      return ok;
    } catch (_) {
      return null;
    }
  }

  function killLegacyNav() {
    // Remove the page's old <nav>...</nav> if it sits at the top of <body>
    // and isn't the new one we just built. Bottom-of-page mobile nav is left
    // alone (it has the .mobile-bottom-nav class).
    document.querySelectorAll('body > nav').forEach(n => {
      if (n.classList.contains('topnav-v2')) return;
      if (n.classList.contains('mobile-bottom-nav')) return;
      n.remove();
    });
    // Some pages wrap the legacy nav in a <header>
    document.querySelectorAll('body > header').forEach(h => {
      if (h.querySelector('nav.topnav-v2')) return;
      // Only remove if it visually appears to be a nav header (has a <nav> inside)
      if (h.querySelector('nav')) h.remove();
    });
  }

  async function init() {
    const nav = buildShell();
    if (!nav) return;

    killLegacyNav();

    const actions = document.getElementById('tnv-actions');
    const user = await fetchMe();

    if (user) renderUser(actions, user);
    else renderGuest(actions);

    // i18n.js auto-injects #langToggle into .nav-actions on its own init.
    // If i18n.js loaded BEFORE us, re-trigger injection now that the mount
    // exists.
    if (window.i18n && typeof window.i18n.injectToggle === 'function') {
      try { window.i18n.injectToggle(); } catch (_) {}
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
