/* ═══════════════════════════════════════════════════════════════════
 * ai-chat.js — Asistente IA slide-in panel
 *
 * Wires every `.tb-ai` button on the dashboard pages to open a
 * shared chat drawer pinned to the right edge. Sends to /api/chat
 * (Claude Haiku, system prompt is set server-side).
 *
 * Public API:
 *   window.aiChat.open()
 *   window.aiChat.close()
 *   window.aiChat.toggle()
 * ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  const ICON_BOT = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2l1.6 4.4L18 8l-4.4 1.6L12 14l-1.6-4.4L6 8l4.4-1.6L12 2zm6 10l1 2.5 2.5 1-2.5 1L18 19l-1-2.5L14.5 15.5l2.5-1L18 12zm-12 0l1 2.5L9.5 15.5 7 16.5 6 19l-1-2.5L2.5 15.5l2.5-1L6 12z"/></svg>';
  const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
  const ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M2 21l21-9L2 3v7l15 2-15 2z"/></svg>';

  const SUGGESTIONS = [
    '¿Cómo aumento mis cierres este mes?',
    'Resumen de mi pipeline',
    '¿Qué documentos pido en una venta?',
    'Estrategia de seguimiento de leads',
  ];

  const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora', 'secretary'];

  let state = {
    mounted: false,
    open: false,
    history: [],
    user: null,
    seedSent: false,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function ensureMounted() {
    if (state.mounted) return;
    state.mounted = true;

    const overlay = document.createElement('div');
    overlay.className = 'ai-chat-overlay';
    overlay.id = 'aiChatOverlay';

    const panel = document.createElement('aside');
    panel.className = 'ai-chat-panel';
    panel.id = 'aiChatPanel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Asistente IA');
    panel.innerHTML = `
      <div class="ai-chat-head">
        <div class="ai-chat-avatar">${ICON_BOT}</div>
        <div class="ai-chat-id">
          <span class="ai-chat-title">Asistente IA</span>
          <span class="ai-chat-sub">Pregúntale sobre tus aplicaciones, ventas o el mercado</span>
        </div>
        <button class="ai-chat-close" type="button" aria-label="Cerrar">${ICON_CLOSE}</button>
      </div>
      <div class="ai-chat-msgs" id="aiChatMsgs"></div>
      <div class="ai-chat-suggestions" id="aiChatSugs">
        ${SUGGESTIONS.map(s => `<button type="button" class="ai-chat-chip">${escapeHtml(s)}</button>`).join('')}
      </div>
      <form class="ai-chat-composer" id="aiChatForm">
        <textarea id="aiChatInput" rows="1" placeholder="Escribe tu pregunta…" maxlength="2000"></textarea>
        <button class="ai-chat-send" type="submit" aria-label="Enviar">${ICON_SEND}</button>
      </form>
    `;

    document.body.appendChild(overlay);
    document.body.appendChild(panel);

    overlay.addEventListener('click', close);
    panel.querySelector('.ai-chat-close').addEventListener('click', close);

    const form = panel.querySelector('#aiChatForm');
    const input = panel.querySelector('#aiChatInput');
    form.addEventListener('submit', (e) => { e.preventDefault(); send(input.value); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(input.value); }
    });
    input.addEventListener('input', () => {
      input.style.height = 'auto';
      input.style.height = Math.min(140, input.scrollHeight) + 'px';
    });

    panel.querySelectorAll('.ai-chat-chip').forEach(btn => {
      btn.addEventListener('click', () => send(btn.textContent.trim()));
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.open) close();
    });

    // Prefetch the user (quietly)
    fetchMe();
  }

  async function fetchMe() {
    if (state.user) return state.user;
    try {
      const r = await fetch('/api/auth/me', { credentials: 'include' });
      if (r.ok) {
        const data = await r.json();
        state.user = data?.user || data;
      }
    } catch (_) {}
    return state.user;
  }

  function appendBot(text) {
    const msgs = document.getElementById('aiChatMsgs');
    const div = document.createElement('div');
    div.className = 'ai-chat-msg bot';
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }
  function appendUser(text) {
    const msgs = document.getElementById('aiChatMsgs');
    const div = document.createElement('div');
    div.className = 'ai-chat-msg user';
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }
  function appendError(text) {
    const msgs = document.getElementById('aiChatMsgs');
    const div = document.createElement('div');
    div.className = 'ai-chat-msg error';
    div.textContent = text;
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
  }
  function appendTyping() {
    const msgs = document.getElementById('aiChatMsgs');
    const div = document.createElement('div');
    div.className = 'ai-chat-typing';
    div.id = 'aiChatTyping';
    div.innerHTML = '<span></span><span></span><span></span>';
    msgs.appendChild(div);
    msgs.scrollTop = msgs.scrollHeight;
    return div;
  }
  function removeTyping() {
    const t = document.getElementById('aiChatTyping');
    if (t) t.remove();
  }

  function seedWelcome() {
    if (state.seedSent) return;
    state.seedSent = true;
    const name = state.user?.name?.split(' ')[0] || '';
    const greeting = name
      ? `¡Hola, ${name}! 👋 Soy tu asistente IA de HogaresRD. ¿En qué te puedo ayudar hoy?`
      : '¡Hola! 👋 Soy tu asistente IA de HogaresRD. Pregúntame sobre tus aplicaciones, estrategias de venta o el mercado dominicano.';
    appendBot(greeting);
  }

  function hideSuggestions() {
    const el = document.getElementById('aiChatSugs');
    if (el) el.hidden = true;
  }

  async function send(textRaw) {
    const text = (textRaw || '').trim();
    if (!text) return;

    const input = document.getElementById('aiChatInput');
    const sendBtn = document.querySelector('.ai-chat-send');
    input.value = '';
    input.style.height = 'auto';

    appendUser(text);
    state.history.push({ role: 'user', content: text });
    hideSuggestions();
    sendBtn.disabled = true;

    const typing = appendTyping();

    // Build broker context — server uses brokerName + role + stats
    const ctx = {};
    if (state.user) {
      if (state.user.name) ctx.brokerName = state.user.name;
      if (state.user.role) ctx.userRole = state.user.role;
    }

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: state.history.slice(0, -1),
          context: ctx,
        }),
      });
      removeTyping();
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        appendError(data.error || 'Error al conectar con el asistente. Intenta de nuevo.');
        state.history.pop();
      } else {
        appendBot(data.reply || 'No pude generar una respuesta. Intenta de nuevo.');
        state.history.push({ role: 'assistant', content: data.reply });
      }
    } catch (_) {
      removeTyping();
      appendError('Error de conexión. Verifica tu red e intenta de nuevo.');
      state.history.pop();
    }

    sendBtn.disabled = false;
    input.focus();
  }

  async function open() {
    ensureMounted();
    if (state.open) return;
    state.open = true;
    document.getElementById('aiChatOverlay').classList.add('open');
    document.getElementById('aiChatPanel').classList.add('open');
    await fetchMe();
    seedWelcome();
    setTimeout(() => document.getElementById('aiChatInput')?.focus(), 220);
  }

  function close() {
    if (!state.open) return;
    state.open = false;
    document.getElementById('aiChatOverlay')?.classList.remove('open');
    document.getElementById('aiChatPanel')?.classList.remove('open');
  }

  function toggle() {
    state.open ? close() : open();
  }

  // Auto-wire any `.tb-ai` trigger on the page (existing dashboard
  // pages use this class on the topbar AI link). Override the link
  // navigation so it opens the panel instead.
  function autoWire() {
    document.addEventListener('click', (e) => {
      const trigger = e.target.closest('.tb-ai, [data-ai-chat]');
      if (!trigger) return;
      e.preventDefault();
      open();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoWire);
  } else {
    autoWire();
  }

  window.aiChat = { open, close, toggle };
})();
