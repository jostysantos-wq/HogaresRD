const express      = require('express');
const rateLimit    = require('express-rate-limit');
const router       = express.Router();
// nodemailer replaced by central mailer.js (Resend HTTP API)
const store        = require('./store');

const msgRateLimiter = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'Demasiados mensajes. Espera un momento.' },
  standardHeaders: true, legacyHeaders: false,
});
const notify       = require('../utils/twilio');
const { notify: pushNotify } = require('./push');

const BASE_URL = process.env.BASE_URL || 'https://hogaresrd.com';

const { createTransport } = require('./mailer');
const transporter = createTransport();

function _sendMail(to, subject, html) {
  if (!to) return;
  transporter.sendMail({ to, subject, html, department: 'noreply' }).catch(err => console.error('[conv-mail]', err.message));
}


const PRO_ROLES = ['agency', 'broker', 'inmobiliaria', 'constructora'];

// ── Auth helpers ──────────────────────────────────────────────────────────
function getUser(req) { return req.user || null; }

function requireLogin(req, res, next) {
  if (!getUser(req)) return res.status(401).json({ error: 'No autenticado' });
  next();
}

function uid() {
  return 'conv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}
function msgId() {
  return 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// ── POST /api/conversations ───────────────────────────────────────────────
// Client starts a conversation about a listing.
// One conversation per client per listing — returns existing if already open.
router.post('/', requireLogin, (req, res) => {
  const user = getUser(req);
  const { propertyId, propertyTitle, propertyImage, message, refToken: bodyRefToken } = req.body;

  if (!propertyId || !message?.trim()) {
    return res.status(400).json({ error: 'Propiedad y mensaje requeridos.' });
  }

  // One conversation per client per listing
  const existing = store.getConversations().find(
    c => c.clientId === user.sub && c.propertyId === propertyId
  );

  if (existing) {
    // Append message to existing conversation
    const msg = {
      id:         msgId(),
      senderId:   user.sub,
      senderRole: 'client',
      senderName: user.name,
      text:       message.trim(),
      timestamp:  new Date().toISOString(),
    };
    existing.messages.push(msg);
    existing.lastMessage  = message.trim();
    existing.updatedAt    = new Date().toISOString();
    existing.unreadBroker = (existing.unreadBroker || 0) + 1;
    store.saveConversation(existing);
    return res.json({ conversation: existing });
  }

  // Resolve referring agent from refToken (body param or cookie)
  const refTk = bodyRefToken || req.cookies?.hrd_ref || null;
  let assignedBrokerId = null;
  let assignedBrokerName = null;
  let inmobiliariaId = null;

  if (refTk) {
    const refAgent = store.getUserByRefToken(refTk);
    if (refAgent) {
      if (['agency', 'broker'].includes(refAgent.role)) {
        // Individual agent — pre-assign conversation to them
        assignedBrokerId = refAgent.id;
        assignedBrokerName = refAgent.name;
      } else if (['inmobiliaria', 'constructora'].includes(refAgent.role)) {
        // Org link — leave brokerId null so ALL org agents see it
        // Store inmobiliaria_id so we can restrict visibility
        inmobiliariaId = refAgent.id;
      }
    }
  }

  // Create new conversation
  const msg = {
    id:         msgId(),
    senderId:   user.sub,
    senderRole: 'client',
    senderName: user.name,
    text:       message.trim(),
    timestamp:  new Date().toISOString(),
  };

  const conv = {
    id:             uid(),
    propertyId,
    propertyTitle:  propertyTitle || 'Propiedad',
    propertyImage:  propertyImage || null,
    clientId:       user.sub,
    clientName:     user.name,
    brokerId:       assignedBrokerId,   // pre-assigned from ref link, or null
    brokerName:     assignedBrokerName,
    inmobiliariaId: inmobiliariaId,      // set when org link used (for team visibility)
    refToken:       refTk || null,
    createdAt:      new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
    lastMessage:    message.trim(),
    unreadBroker:   1,
    unreadClient:   0,
    messages:       [msg],
  };

  store.saveConversation(conv);

  // Start cascade if enabled and no refToken assignment
  const cascadeEngine = require('./cascade-engine');
  if (cascadeEngine.isEnabled() && !assignedBrokerId && !inmobiliariaId && propertyId) {
    cascadeEngine.startCascade('conversation', conv.id, propertyId, {
      name: user.name || '',
    });
    // Cascade handles notifications — skip legacy notification block
    return res.status(201).json({ id: conv.id, created: true });
  }

  // Push notification to assigned broker or org team (legacy)
  const { notify: pushNotify } = require('./push');
  if (assignedBrokerId) {
    pushNotify(assignedBrokerId, {
      type: 'new_message',
      title: 'Nuevo mensaje de cliente',
      body: `${user.name}: ${message.trim().slice(0, 80)}`,
      url: '/mensajes',
    });
  } else if (inmobiliariaId) {
    // Notify all agents in the org
    const teamMembers = store.getUsersByInmobiliaria(inmobiliariaId);
    for (const member of teamMembers) {
      pushNotify(member.id, {
        type: 'new_message',
        title: 'Nuevo mensaje de cliente',
        body: `${user.name}: ${message.trim().slice(0, 80)}`,
        url: '/mensajes',
      });
    }
    // Also notify the inmobiliaria owner
    pushNotify(inmobiliariaId, {
      type: 'new_message',
      title: 'Nuevo mensaje de cliente',
      body: `${user.name}: ${message.trim().slice(0, 80)}`,
      url: '/mensajes',
    });
  }

  res.status(201).json({ conversation: conv });
});

// ── GET /api/conversations ────────────────────────────────────────────────
// Client: their own. Broker/agency/inmobiliaria: assigned to them or unassigned.
// ?archived=true returns only archived conversations. Default excludes them.
router.get('/', requireLogin, (req, res) => {
  const user = getUser(req);
  let convs;

  if (user.role === 'user') {
    convs = store.getConversationsByClient(user.sub);
  } else if (PRO_ROLES.includes(user.role)) {
    convs = store.getConversationsForBroker(user.sub);
    // Also include UNCLAIMED org conversations (inmobiliariaId matches, brokerId still null)
    // Once a conversation is claimed by any agent, only that agent sees it
    const fullUser = store.getUserById(user.sub);
    const inmId = ['inmobiliaria', 'constructora'].includes(fullUser?.role)
      ? fullUser.id : fullUser?.inmobiliaria_id;
    if (inmId) {
      const allConvs = store.getConversations();
      const orgConvs = allConvs.filter(c =>
        c.inmobiliariaId === inmId && !c.brokerId && !convs.some(x => x.id === c.id)
      );
      convs = convs.concat(orgConvs);
    }
  } else {
    convs = store.getConversations(); // admin sees all
  }

  const wantArchived = req.query.archived === 'true';
  convs = convs.filter(c => wantArchived ? !!c.archived : !c.archived);

  // Determine if this user is an org owner (level 3 — full oversight)
  const fullUserForList = PRO_ROLES.includes(user.role) ? store.getUserById(user.sub) : null;
  const isOrgOwner = fullUserForList && ['inmobiliaria', 'constructora'].includes(fullUserForList.role);

  // Return without full message array for list view (just metadata)
  const list = convs.map(({ messages, ...meta }) => {
    const isUnclaimed = meta.inmobiliariaId && !meta.brokerId;
    const isMyConv = meta.brokerId === user.sub || meta.clientId === user.sub;

    // Unclaimed org conversations: redact details for non-owners
    if (isUnclaimed && !isMyConv && !isOrgOwner) {
      const firstName = (meta.clientName || '').split(' ')[0];
      return {
        ...meta,
        clientName:   firstName,
        clientEmail:  null,
        lastMessage:  'Nuevo mensaje pendiente',
        messageCount: messages.length,
        claimRequired: true,
      };
    }

    return { ...meta, messageCount: messages.length };
  });

  res.json(list);
});

// ── GET /api/conversations/unread ─────────────────────────────────────────
// Quick unread count for badge in nav.
router.get('/unread', requireLogin, (req, res) => {
  const user = getUser(req);
  let convs;

  if (user.role === 'user') {
    convs = store.getConversationsByClient(user.sub);
    const count = convs.reduce((n, c) => n + (c.unreadClient || 0), 0);
    return res.json({ count });
  }

  if (PRO_ROLES.includes(user.role)) {
    convs = store.getConversationsForBroker(user.sub);
    // Include unclaimed org conversations in unread count
    const fullUser = store.getUserById(user.sub);
    const inmId = ['inmobiliaria', 'constructora'].includes(fullUser?.role)
      ? fullUser.id : fullUser?.inmobiliaria_id;
    if (inmId) {
      const orgConvs = store.getConversations().filter(c =>
        c.inmobiliariaId === inmId && !c.brokerId && !convs.some(x => x.id === c.id)
      );
      convs = convs.concat(orgConvs);
    }
    const count = convs.reduce((n, c) => n + (c.unreadBroker || 0), 0);
    return res.json({ count });
  }

  res.json({ count: 0 });
});

// ── GET /api/conversations/:id ────────────────────────────────────────────
router.get('/:id', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  // Access check
  const isBroker = PRO_ROLES.includes(user.role);
  const isClient = conv.clientId === user.sub;
  const isOwner  = conv.brokerId === user.sub;
  // Org members can access unclaimed org conversations (to claim them)
  const fullUser = isBroker ? store.getUserById(user.sub) : null;
  const userInmId = fullUser ? (['inmobiliaria', 'constructora'].includes(fullUser.role) ? fullUser.id : fullUser.inmobiliaria_id) : null;
  const isOrgUnclaimed = isBroker && conv.inmobiliariaId && conv.inmobiliariaId === userInmId && !conv.brokerId;
  // Pros can access: assigned to them, unassigned (no brokerId), or unclaimed org conversations
  const brokerHasAccess = isBroker && (isOwner || (!conv.brokerId && !conv.inmobiliariaId) || isOrgUnclaimed);

  if (!isClient && !brokerHasAccess) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  // For unclaimed org conversations: non-owner agents see a claim prompt, not the messages
  const isOrgOwnerUser = fullUser && ['inmobiliaria', 'constructora'].includes(fullUser.role);
  if (isOrgUnclaimed && !isOrgOwnerUser) {
    const firstName = (conv.clientName || '').split(' ')[0];
    return res.json({
      id:             conv.id,
      propertyId:     conv.propertyId,
      propertyTitle:  conv.propertyTitle,
      propertyImage:  conv.propertyImage,
      clientName:     firstName,
      inmobiliariaId: conv.inmobiliariaId,
      messageCount:   conv.messages.length,
      createdAt:      conv.createdAt,
      claimRequired:  true,
      messages:       [], // hidden until claimed
    });
  }

  // Since the request comes with ?since= for polling, return only new messages
  const since = req.query.since ? new Date(req.query.since) : null;
  const messages = since
    ? conv.messages.filter(m => new Date(m.timestamp) > since)
    : conv.messages;

  // Auto-mark-read on INITIAL load (no ?since= = user just opened the thread).
  if (!since) {
    let dirty = false;
    if (isBroker && conv.unreadBroker) { conv.unreadBroker = 0; dirty = true; }
    if (isClient && conv.unreadClient) { conv.unreadClient = 0; dirty = true; }
    if (dirty) store.saveConversation(conv);
  }

  res.json({ ...conv, messages });
});

// ── POST /api/conversations/:id/claim ────────────────────────────────────
// Agent explicitly claims an unclaimed org conversation
router.post('/:id/claim', requireLogin, (req, res) => {
  const user = getUser(req);
  if (!PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes pueden reclamar conversaciones.' });

  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  // Must be unclaimed and org-tagged
  if (conv.brokerId)
    return res.status(400).json({ error: 'Esta conversación ya fue reclamada por otro agente.' });

  // Verify agent belongs to the conversation's org
  const fullUser = store.getUserById(user.sub);
  const userInmId = ['inmobiliaria', 'constructora'].includes(fullUser?.role)
    ? fullUser.id : fullUser?.inmobiliaria_id;

  if (conv.inmobiliariaId && conv.inmobiliariaId !== userInmId)
    return res.status(403).json({ error: 'No perteneces a esta organización.' });

  // Double-check before claiming (re-read to prevent race condition)
  const fresh = store.getConversationById(req.params.id);
  if (fresh.brokerId)
    return res.status(400).json({ error: 'Esta conversación ya fue reclamada por otro agente.' });

  // Claim it
  fresh.brokerId   = user.sub;
  fresh.brokerName = user.name;
  fresh.updatedAt  = new Date().toISOString();

  // Add system message
  fresh.messages.push({
    id:         'msg_' + crypto.randomBytes(6).toString('hex'),
    senderId:   'system',
    senderRole: 'system',
    senderName: 'HogaresRD',
    text:       `${user.name} ha tomado esta conversación.`,
    timestamp:  fresh.updatedAt,
  });

  store.saveConversation(fresh);
  res.json({ ok: true, conversation: fresh });
});

// ── POST /api/conversations/:id/messages ─────────────────────────────────
router.post('/:id/messages', msgRateLimiter, requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

  const isBroker = PRO_ROLES.includes(user.role);
  const isClient = conv.clientId === user.sub;
  const isOwner  = conv.brokerId === user.sub;
  // Pros can only post in conversations they're assigned to, OR unassigned
  // ones (which they claim on first reply).
  const brokerHasAccess = isBroker && (isOwner || !conv.brokerId);

  if (!isClient && !brokerHasAccess) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  if (conv.closed) {
    return res.status(403).json({
      error: isClient
        ? 'Esta conversación fue cerrada por el agente. No puedes enviar más mensajes.'
        : 'Esta conversación está cerrada. Reábrela para enviar mensajes.',
      closed: true,
    });
  }

  const msg = {
    id:         msgId(),
    senderId:   user.sub,
    senderRole: isBroker ? 'broker' : 'client',
    senderName: user.name,
    text:       text.trim(),
    timestamp:  new Date().toISOString(),
  };

  conv.messages.push(msg);
  conv.lastMessage = text.trim();
  conv.updatedAt   = new Date().toISOString();

  // Auto-assign broker on first reply
  if (isBroker && !conv.brokerId) {
    conv.brokerId   = user.sub;
    conv.brokerName = user.name;
  }

  // Update unread counters
  if (isBroker) {
    conv.unreadClient = (conv.unreadClient || 0) + 1;
  } else {
    conv.unreadBroker = (conv.unreadBroker || 0) + 1;
  }

  store.saveConversation(conv);
  res.json({ message: msg, conversation: conv });

  // Push notification → recipient
  const preview = text.trim().slice(0, 80) + (text.trim().length > 80 ? '…' : '');
  if (isBroker && conv.clientId) {
    pushNotify(conv.clientId, {
      type: 'new_message',
      title: `💬 ${user.name}`,
      body: preview,
      url: `/mensajes?conv=${conv.id}`,
    });
  } else if (!isBroker && conv.brokerId) {
    pushNotify(conv.brokerId, {
      type: 'new_message',
      title: `💬 ${user.name}`,
      body: preview,
      url: `/broker.html`,
    });
  }

  // ── Fire-and-forget notifications ────────────────────────────────────────
  setImmediate(async () => {
    try {
      const preview = text.trim().slice(0, 120) + (text.trim().length > 120 ? '…' : '');
      if (isBroker) {
        // Broker replied → notify client via email
        const clientUser = store.getUserById(conv.clientId);
        if (clientUser?.email) {
          _sendMail(
            clientUser.email,
            `HogaresRD — ${user.name} te respondió sobre "${conv.propertyTitle}"`,
            `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
              <div style="background:#002D62;color:#fff;padding:1.2rem 1.5rem;border-radius:12px 12px 0 0;">
                <h2 style="margin:0;font-size:1.1rem;">💬 Nuevo mensaje de tu agente</h2>
              </div>
              <div style="padding:1.5rem;background:#fff;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 12px 12px;">
                <p style="margin:0 0 0.5rem;"><strong>${user.name}</strong> respondió sobre <strong>${conv.propertyTitle}</strong>:</p>
                <blockquote style="margin:0.75rem 0;padding:0.75rem 1rem;background:#f5f8ff;border-left:3px solid #0038A8;border-radius:4px;color:#1a2b40;">${preview}</blockquote>
                <a href="${BASE_URL}/mensajes?conv=${conv.id}" style="display:inline-block;margin-top:1rem;background:#0038A8;color:#fff;padding:0.65rem 1.4rem;border-radius:8px;text-decoration:none;font-weight:700;">Ver conversación →</a>
              </div>
            </div>`
          );
        }
      } else {
        // Client sent message → notify broker via WhatsApp
        const brokerUser = conv.brokerId ? store.getUserById(conv.brokerId) : null;
        if (brokerUser?.phone) {
          await notify.notifyBrokerNewMessage({
            brokerPhone:    brokerUser.phone,
            clientName:     user.name,
            propertyTitle:  conv.propertyTitle,
            messagePreview: text.trim(),
            convId:         conv.id,
          });
        }
      }
    } catch (e) { console.error('[notify]', e.message); }
  });
});

// ── PUT /api/conversations/:id/close ─────────────────────────────────────
// Agents/agencies/inmobiliarias/constructoras can close a conversation
// when the client is no longer viable. Clients cannot close — they can
// simply stop replying. Closed conversations block new messages from
// either side until reopened.
router.put('/:id/close', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  if (!PRO_ROLES.includes(user.role)) {
    return res.status(403).json({ error: 'Solo agentes e inmobiliarias pueden cerrar conversaciones.' });
  }
  // Must be the assigned broker, OR no broker assigned yet (can't steal someone else's)
  if (conv.brokerId && conv.brokerId !== user.sub) {
    return res.status(403).json({ error: 'Solo el agente asignado puede cerrar esta conversación.' });
  }

  const reason = (req.body?.reason || '').trim().slice(0, 200);
  conv.closed     = true;
  conv.closedAt   = new Date().toISOString();
  conv.closedBy   = user.sub;
  conv.closedByName = user.name;
  conv.closedByRole = user.role;
  conv.closedReason = reason || null;
  conv.updatedAt  = conv.closedAt;

  // Append system messages so both sides see why the thread ended
  // + an archive notice with the 24h auto-archive timeline.
  const closeMsg = {
    id:         msgId(),
    senderId:   user.sub,
    senderRole: 'system',
    senderName: user.name,
    text:       reason
      ? `🔒 Conversación cerrada por ${user.name}: ${reason}`
      : `🔒 Conversación cerrada por ${user.name}.`,
    timestamp:  conv.closedAt,
  };
  const archiveNotice = {
    id:         msgId(),
    senderId:   'system',
    senderRole: 'system',
    senderName: 'HogaresRD',
    text:       '📋 Esta conversación será archivada automáticamente en 24 horas. Si desea archivarla antes, puede hacerlo desde el menú de opciones. Las conversaciones archivadas permanecen accesibles en la sección "Archivadas" de sus mensajes.',
    timestamp:  conv.closedAt,
  };
  conv.messages.push(closeMsg);
  conv.messages.push(archiveNotice);
  conv.lastMessage = closeMsg.text;
  conv.unreadClient = (conv.unreadClient || 0) + 1;

  store.saveConversation(conv);
  res.json({ ok: true, conversation: conv });
});

// ── PUT /api/conversations/:id/reopen ────────────────────────────────────
router.put('/:id/reopen', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  if (!PRO_ROLES.includes(user.role)) {
    return res.status(403).json({ error: 'Solo agentes e inmobiliarias pueden reabrir conversaciones.' });
  }
  if (conv.brokerId && conv.brokerId !== user.sub) {
    return res.status(403).json({ error: 'Solo el agente asignado puede reabrir esta conversación.' });
  }

  conv.closed = false;
  conv.closedAt = null;
  conv.closedBy = null;
  conv.closedByName = null;
  conv.closedByRole = null;
  conv.closedReason = null;
  // Also clear archived state — reopening an archived conversation
  // should bring it back to the active list.
  conv.archived   = false;
  conv.archivedAt = null;
  conv.archivedBy = null;
  conv.updatedAt  = new Date().toISOString();

  const sysMsg = {
    id:         msgId(),
    senderId:   user.sub,
    senderRole: 'system',
    senderName: user.name,
    text:       `🔓 Conversación reabierta por ${user.name}.`,
    timestamp:  conv.updatedAt,
  };
  conv.messages.push(sysMsg);
  conv.lastMessage = sysMsg.text;
  conv.unreadClient = (conv.unreadClient || 0) + 1;

  store.saveConversation(conv);
  res.json({ ok: true, conversation: conv });
});

// ── PUT /api/conversations/:id/archive ───────────────────────────────────
// Archive a closed conversation — removes it from the active messages list.
// Both the client and the assigned broker can archive.
router.put('/:id/archive', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const isClient = conv.clientId === user.sub;
  const isBroker = PRO_ROLES.includes(user.role);
  if (!isClient && !isBroker) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }
  if (!conv.closed) {
    return res.status(400).json({ error: 'La conversación debe estar cerrada antes de archivarla.' });
  }

  conv.archived    = true;
  conv.archivedAt  = new Date().toISOString();
  conv.archivedBy  = user.sub;
  conv.updatedAt   = conv.archivedAt;
  store.saveConversation(conv);
  res.json({ ok: true });
});

// ── PUT /api/conversations/:id/unarchive ─────────────────────────────────
router.put('/:id/unarchive', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const isClient = conv.clientId === user.sub;
  const isBroker = PRO_ROLES.includes(user.role);
  if (!isClient && !isBroker) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  conv.archived   = false;
  conv.archivedAt = null;
  conv.archivedBy = null;
  conv.updatedAt  = new Date().toISOString();
  store.saveConversation(conv);
  res.json({ ok: true });
});

// ── PUT /api/conversations/:id/read ──────────────────────────────────────
router.put('/:id/read', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const isBroker = PRO_ROLES.includes(user.role);
  const isClient = conv.clientId === user.sub;
  const isOwner  = conv.brokerId === user.sub;
  const brokerHasAccess = isBroker && (isOwner || !conv.brokerId);
  if (!isClient && !brokerHasAccess) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  if (isBroker) {
    conv.unreadBroker = 0;
  } else {
    conv.unreadClient = 0;
  }

  store.saveConversation(conv);
  res.json({ ok: true });
});

module.exports = router;
