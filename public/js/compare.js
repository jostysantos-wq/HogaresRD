// HogaresRD — Property Comparison Tool
// Shared module: manages compare selection in localStorage and renders the floating bar.

(function () {
  const MAX_COMPARE = 3;
  const STORAGE_KEY = 'hogaresrd_compare';

  // ── State ──────────────────────────────────────────────────
  function getCompareIds() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
    catch { return []; }
  }
  function setCompareIds(ids) {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(ids.slice(0, MAX_COMPARE))); }
    catch {}
    render();
  }

  function isInCompare(id) { return getCompareIds().includes(id); }

  function toggleCompare(id) {
    let ids = getCompareIds();
    const idx = ids.indexOf(id);
    if (idx >= 0) {
      ids.splice(idx, 1);
    } else {
      if (ids.length >= MAX_COMPARE) {
        showToast(`Puedes comparar hasta ${MAX_COMPARE} propiedades`);
        return false;
      }
      ids.push(id);
    }
    setCompareIds(ids);
    updateAllButtons();
    return true;
  }

  function clearCompare() {
    setCompareIds([]);
    updateAllButtons();
  }

  // ── Toast notification ─────────────────────────────────────
  function showToast(msg) {
    let toast = document.getElementById('compare-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'compare-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.add('visible');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => toast.classList.remove('visible'), 2500);
  }

  // ── Update compare buttons state ──────────────────────────
  function updateAllButtons() {
    const ids = getCompareIds();
    document.querySelectorAll('.compare-btn[data-compare-id]').forEach(btn => {
      const id = btn.dataset.compareId;
      const active = ids.includes(id);
      btn.classList.toggle('active', active);
      const label = btn.querySelector('.compare-label');
      if (label) label.textContent = active ? 'Comparando' : 'Comparar';
    });
  }

  // ── Nav link visibility ─────────────────────────────────────
  function updateNavLink() {
    const link = document.getElementById('navCompareLink');
    if (link) {
      const ids = getCompareIds();
      link.style.display = ids.length ? '' : 'none';
      link.textContent = ids.length ? `Comparar (${ids.length})` : 'Comparar';
    }
  }

  // ── Floating comparison bar ────────────────────────────────
  function render() {
    const ids = getCompareIds();
    let bar = document.getElementById('compare-bar');
    updateNavLink();

    if (!ids.length) {
      if (bar) bar.classList.remove('visible');
      return;
    }

    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'compare-bar';
      document.body.appendChild(bar);
    }

    const slots = [];
    for (let i = 0; i < MAX_COMPARE; i++) {
      if (ids[i]) {
        slots.push(`
          <div class="compare-slot filled" data-id="${ids[i]}">
            <span class="compare-slot-label">Propiedad ${i + 1}</span>
            <button class="compare-slot-remove" onclick="window.HogaresCompare.toggle('${ids[i]}')" title="Quitar">&times;</button>
          </div>`);
      } else {
        slots.push(`<div class="compare-slot empty"><span class="compare-slot-label">+ Agregar</span></div>`);
      }
    }

    bar.innerHTML = `
      <div class="compare-bar-inner">
        <div class="compare-bar-title">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M10 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h5V3zm4 0v18h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-5z"/></svg>
          Comparar (${ids.length}/${MAX_COMPARE})
        </div>
        <div class="compare-bar-slots">${slots.join('')}</div>
        <div class="compare-bar-actions">
          <button class="compare-bar-btn clear" onclick="window.HogaresCompare.clear()">Limpiar</button>
          <a class="compare-bar-btn go" href="/comparar?ids=${ids.join(',')}">Comparar ahora</a>
        </div>
      </div>`;
    bar.classList.add('visible');
  }

  // ── Inject styles ──────────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('compare-styles')) return;
    const style = document.createElement('style');
    style.id = 'compare-styles';
    style.textContent = `
      /* Compare button on cards */
      .compare-btn {
        position: absolute; bottom: 0.75rem; left: 0.75rem;
        display: flex; align-items: center; gap: 0.3rem;
        background: rgba(0,0,0,0.55); color: #fff;
        border: 1.5px solid rgba(255,255,255,0.3);
        border-radius: 50px; padding: 0.25rem 0.65rem;
        font-size: 0.72rem; font-weight: 600;
        cursor: pointer; transition: all 0.2s; z-index: 5;
        backdrop-filter: blur(4px);
      }
      .compare-btn:hover { background: rgba(0,56,168,0.85); border-color: rgba(255,255,255,0.6); }
      .compare-btn.active { background: var(--accent, #0038A8); border-color: var(--accent, #0038A8); }
      .compare-btn svg { width: 13px; height: 13px; fill: currentColor; flex-shrink: 0; }

      /* Floating bar */
      #compare-bar {
        position: fixed; bottom: -120px; left: 50%; transform: translateX(-50%);
        z-index: 9999; transition: bottom 0.35s cubic-bezier(0.4,0,0.2,1);
        width: 95%; max-width: 780px;
      }
      #compare-bar.visible { bottom: 1.5rem; }
      .compare-bar-inner {
        background: var(--bg-card, #fff); border: 1px solid var(--border, #d0dcea);
        border-radius: 16px; box-shadow: 0 12px 40px rgba(0,0,0,0.2);
        padding: 1rem 1.25rem; display: flex; align-items: center; gap: 1rem;
        flex-wrap: wrap;
      }
      .compare-bar-title {
        display: flex; align-items: center; gap: 0.4rem;
        font-size: 0.9rem; font-weight: 700; color: var(--text, #001840);
        white-space: nowrap; flex-shrink: 0;
      }
      .compare-bar-slots { display: flex; gap: 0.5rem; flex: 1; }
      .compare-slot {
        flex: 1; min-width: 0; padding: 0.5rem 0.75rem;
        border-radius: 10px; font-size: 0.78rem; font-weight: 600;
        display: flex; align-items: center; justify-content: space-between;
        gap: 0.3rem;
      }
      .compare-slot.filled {
        background: var(--accent-light, #dce8ff); color: var(--accent, #0038A8);
        border: 1px solid var(--accent, #0038A8);
      }
      .compare-slot.empty {
        background: var(--bg, #f0f4f9); color: var(--text-muted, #4d6a8a);
        border: 1.5px dashed var(--border, #d0dcea);
      }
      .compare-slot-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .compare-slot-remove {
        background: none; border: none; color: var(--accent, #0038A8);
        font-size: 1.1rem; font-weight: 700; cursor: pointer; line-height: 1;
        padding: 0 0.2rem; flex-shrink: 0;
      }
      .compare-bar-actions { display: flex; gap: 0.5rem; flex-shrink: 0; }
      .compare-bar-btn {
        padding: 0.5rem 1rem; border-radius: 8px;
        font-size: 0.82rem; font-weight: 700;
        cursor: pointer; text-decoration: none; border: none;
        transition: background 0.2s, color 0.2s;
      }
      .compare-bar-btn.clear {
        background: none; color: var(--text-muted, #4d6a8a);
        border: 1px solid var(--border, #d0dcea);
      }
      .compare-bar-btn.clear:hover { background: var(--bg, #f0f4f9); }
      .compare-bar-btn.go {
        background: var(--accent, #0038A8); color: #fff;
        display: inline-flex; align-items: center;
      }
      .compare-bar-btn.go:hover { background: var(--accent-hover, #002c8a); }

      /* Toast */
      #compare-toast {
        position: fixed; bottom: -60px; left: 50%; transform: translateX(-50%);
        background: #333; color: #fff; padding: 0.65rem 1.25rem;
        border-radius: 10px; font-size: 0.85rem; font-weight: 600;
        z-index: 99999; transition: bottom 0.3s; white-space: nowrap;
        box-shadow: 0 4px 16px rgba(0,0,0,0.3);
      }
      #compare-toast.visible { bottom: 6rem; }

      /* Responsive */
      @media (max-width: 640px) {
        .compare-bar-inner { flex-direction: column; align-items: stretch; }
        .compare-bar-title { justify-content: center; }
        .compare-bar-actions { justify-content: center; }
        .compare-slot { padding: 0.4rem 0.6rem; font-size: 0.72rem; }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Helper: build compare button HTML for card overlays ────
  function buttonHTML(listingId) {
    const active = isInCompare(listingId);
    return `<button class="compare-btn${active ? ' active' : ''}" data-compare-id="${listingId}" onclick="event.preventDefault();event.stopPropagation();window.HogaresCompare.toggle('${listingId}')">
      <svg viewBox="0 0 24 24"><path d="M10 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h5V3zm4 0v18h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2h-5z"/></svg>
      <span class="compare-label">${active ? 'Comparando' : 'Comparar'}</span>
    </button>`;
  }

  // ── Init ───────────────────────────────────────────────────
  injectStyles();
  render();

  // Expose global API
  window.HogaresCompare = {
    toggle: toggleCompare,
    clear: clearCompare,
    get: getCompareIds,
    isIn: isInCompare,
    buttonHTML: buttonHTML,
    updateAll: updateAllButtons,
    MAX: MAX_COMPARE,
  };
})();
