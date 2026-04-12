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

  // Prevent self-messaging — users can't start a conversation on their own listing
  const listing = store.getListingById(propertyId);
  if (listing) {
    const ownerEmails = new Set();
    if (listing.email) ownerEmails.add(listing.email.toLowerCase());
    if (Array.isArray(listing.agencies)) {
      listing.agencies.forEach(a => { if (a.email) ownerEmails.add(a.email.toLowerCase()); });
    }
    const fullUser = store.getUserById(user.sub);
    const userEmail = (fullUser?.email || '').toLowerCase();
    const isOwner = listing.creator_user_id === user.sub || (userEmail && ownerEmails.has(userEmail));
    if (isOwner) {
      return res.status(400).json({ error: 'No puedes iniciar una conversacion sobre tu propia propiedad.' });
    }
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
  // Cascade: start if no direct broker assigned
  // - Broker ref → assignedBrokerId is set → no cascade (already assigned)
  // - Inmobiliaria ref → inmobiliariaId is set → cascade SCOPED to that org's team
  // - No ref → normal cascade among all listing agencies
  if (cascadeEngine.isEnabled() && !assignedBrokerId && propertyId) {
    const cascadeScope = inmobiliariaId || null;
    cascadeEngine.startCascade('conversation', conv.id, propertyId, { name: user.name || '' }, cascadeScope);
    return res.status(201).json({ id: conv.id, created: true });
  }

  // Push notification to assigned broker or org team
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
    // Pro users see: conversations where they're the broker + where they're the client
    convs = store.getConversationsForBroker(user.sub);
    // Also include conversations where this pro user is the CLIENT
    // (e.g. a broker who inquired about another agent's listing)
    const clientConvs = store.getConversationsByClient(user.sub);
    for (const cc of clientConvs) {
      if (!convs.some(x => x.id === cc.id)) convs.push(cc);
    }
    // Also include UNCLAIMED org conversations (inmobiliariaId matches, brokerId still null)
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
    // Include conversations where this pro user is the client
    const clientConvs = store.getConversationsByClient(user.sub);
    for (const cc of clientConvs) {
      if (!convs.some(x => x.id === cc.id)) convs.push(cc);
    }
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
    // Sum both broker and client unreads — pro users can be on either side
    const count = convs.reduce((n, c) => {
      const isClient = c.clientId === user.sub;
      return n + (isClient ? (c.unreadClient || 0) : (c.unreadBroker || 0));
    }, 0);
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
  // Use clientId match (not global role) to determine which side to clear —
  // a pro user who is the CLIENT should clear unreadClient, not unreadBroker.
  if (!since) {
    let dirty = false;
    const isClientSide = conv.clientId === user.sub;
    if (!isClientSide && conv.unreadBroker) { conv.unreadBroker = 0; dirty = true; }
    if (isClientSide && conv.unreadClient)  { conv.unreadClient = 0; dirty = true; }
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

  // Determine sender's "side" based on conversation membership, not global role.
  // A pro user can also BE the client in a conversation they started.
  const isClient = conv.clientId === user.sub;
  const isOwner  = conv.brokerId === user.sub;
  const isPro    = PRO_ROLES.includes(user.role);
  // Pros can post in unclaimed conversations (and claim them on first reply).
  const brokerHasAccess = isPro && !isClient && (isOwner || !conv.brokerId);
  // The message is sent AS the broker only when the user is the assigned
  // broker OR is claiming an unassigned conversation — not just because
  // they have a pro role. This fixes the case where a pro user replies
  // to their own inquiry (they're the client in that conv).
  const isBroker = brokerHasAccess;

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
  const isAssignedBroker = PRO_ROLES.includes(user.role) && conv.brokerId === user.sub;
  if (!isClient && !isAssignedBroker) {
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
  const isAssignedBroker = PRO_ROLES.includes(user.role) && conv.brokerId === user.sub;
  if (!isClient && !isAssignedBroker) {
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
//
// Clears the unread counter for the side the caller is on.
//
// IMPORTANT: "which side" is determined by the user's membership in THIS
// conversation, NOT by their global role. A pro user (inmobiliaria / agency /
// broker / constructora) can also be the CLIENT of a conversation when they
// inquire on another agent's listing. Before this fix the endpoint always
// cleared `unreadBroker` for any pro user, even when they were reading as
// a client — so `unreadClient` was never cleared and the badge came back on
// the next app launch.
router.put('/:id/read', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const isClientSide = conv.clientId === user.sub;
  const isAssignedBroker = conv.brokerId && conv.brokerId === user.sub;

  // A pro user with access to an UNCLAIMED org conversation (brokerId still
  // null, inmobiliariaId matches their org) is acting as the broker here.
  const isPro = PRO_ROLES.includes(user.role);
  let hasOrgAccess = false;
  if (isPro && !conv.brokerId && conv.inmobiliariaId) {
    const fullUser = store.getUserById(user.sub);
    const orgId = ['inmobiliaria', 'constructora'].includes(fullUser?.role)
      ? fullUser.id
      : fullUser?.inmobiliaria_id;
    hasOrgAccess = orgId === conv.inmobiliariaId;
  }

  const isBrokerSide = isAssignedBroker || hasOrgAccess;
  // Admins can act as either side; fall back to broker-side clearing.
  const isAdmin = user.role === 'admin';

  if (!isClientSide && !isBrokerSide && !isAdmin) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  // Clear BOTH counters when the user is ambiguously both (e.g. a pro user
  // who both owns the broker side AND is the client id — shouldn't happen
  // in practice but we don't want stuck badges).
  if (isClientSide) conv.unreadClient = 0;
  if (isBrokerSide || (isAdmin && !isClientSide)) conv.unreadBroker = 0;

  store.saveConversation(conv);
  res.json({ ok: true, unreadClient: conv.unreadClient || 0, unreadBroker: conv.unreadBroker || 0 });
});

// ── Transfer helpers ─────────────────────────────────────────────────────
//
// A pro user's "effective inmobiliaria id" is:
//   • their own user id if they ARE the inmobiliaria/constructora
//   • their inmobiliaria_id field if they're a broker/agency/secretary
//   • null otherwise
//
// Two users are "on the same team" when their effective ids match and
// neither is null. This is the rule we use to gate conversation
// transfers — you can never pass a client to an agent outside your
// inmobiliaria.
function effectiveInmId(user) {
  if (!user) return null;
  if (['inmobiliaria', 'constructora'].includes(user.role)) return user.id;
  return user.inmobiliaria_id || null;
}
function sameTeam(a, b) {
  const ai = effectiveInmId(a);
  const bi = effectiveInmId(b);
  return !!(ai && bi && ai === bi);
}

// ── GET /api/conversations/:id/transfer-targets ───────────────────────────
//
// Returns the list of agents the current user is allowed to transfer
// this conversation to. Pro users can only pick teammates inside their
// own inmobiliaria — never someone from another org.
router.get('/:id/transfer-targets', requireLogin, (req, res) => {
  const user = getUser(req);
  const fullUser = store.getUserById(user.sub);
  if (!fullUser || !PRO_ROLES.includes(fullUser.role)) {
    return res.status(403).json({ error: 'Solo agentes pueden transferir conversaciones.' });
  }

  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  // Caller must currently own the conversation's broker side.
  const isOwner = conv.brokerId === fullUser.id;
  const isOrgOwner = ['inmobiliaria', 'constructora'].includes(fullUser.role)
                    && conv.inmobiliariaId === fullUser.id;
  if (!isOwner && !isOrgOwner) {
    return res.status(403).json({ error: 'No eres el agente asignado a esta conversación.' });
  }

  const inmId = effectiveInmId(fullUser);
  if (!inmId) {
    return res.status(400).json({ error: 'No perteneces a ninguna inmobiliaria, no puedes transferir.' });
  }

  // Team = all brokers/agency under this inmobiliaria + the inmobiliaria owner
  const team = store.getUsersByInmobiliaria(inmId)
    .filter(u => ['broker', 'agency'].includes(u.role) && u.id !== fullUser.id);
  const inmOwner = store.getUserById(inmId);
  if (inmOwner && inmOwner.id !== fullUser.id) team.unshift(inmOwner);

  // Strip sensitive fields
  const targets = team.map(u => ({
    id:          u.id,
    name:        u.name || '',
    email:       u.email || '',
    role:        u.role,
    agencyName:  u.agencyName || u.companyName || '',
    avatarUrl:   u.avatarUrl || null,
  }));

  res.json({ targets });
});

// ── PUT /api/conversations/:id/transfer ─────────────────────────────────
//
// Transfer ownership of the conversation's broker side to another pro
// user in the SAME inmobiliaria.
//
// After transfer:
//   • conv.brokerId / conv.brokerName → new agent
//   • transferHistory array tracks from/to/at/by for audit
//   • A 'system' message is appended so both sides see the hand-off
//   • Old broker no longer appears in getConversationsForBroker()
//     results (which filters on brokerId match) — they see the thread
//     frozen at the pre-transfer state in their own UI because the
//     conversation simply disappears from their list on next fetch.
//   • The receiving agent gets a push + email notification.
router.put('/:id/transfer', requireLogin, (req, res) => {
  const user = getUser(req);
  const fullUser = store.getUserById(user.sub);
  if (!fullUser || !PRO_ROLES.includes(fullUser.role)) {
    return res.status(403).json({ error: 'Solo agentes pueden transferir conversaciones.' });
  }

  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const { targetUserId, reason } = req.body || {};
  if (!targetUserId) return res.status(400).json({ error: 'targetUserId requerido.' });

  // Only the current broker (or the org owner) can initiate a transfer.
  const isOwner = conv.brokerId === fullUser.id;
  const isOrgOwner = ['inmobiliaria', 'constructora'].includes(fullUser.role)
                    && conv.inmobiliariaId === fullUser.id;
  if (!isOwner && !isOrgOwner) {
    return res.status(403).json({ error: 'No eres el agente asignado a esta conversación.' });
  }

  const target = store.getUserById(targetUserId);
  if (!target) return res.status(404).json({ error: 'Usuario objetivo no encontrado.' });
  if (!PRO_ROLES.includes(target.role)) {
    return res.status(400).json({ error: 'El destinatario debe ser un agente o inmobiliaria.' });
  }
  if (target.id === fullUser.id) {
    return res.status(400).json({ error: 'No puedes transferir la conversación a ti mismo.' });
  }

  // Same-team rule — this is the core security check. An agent from
  // another inmobiliaria can NEVER receive the transfer, even if they
  // ask for it.
  if (!sameTeam(fullUser, target)) {
    return res.status(403).json({
      error: 'Solo puedes transferir a agentes de tu misma inmobiliaria.',
    });
  }

  const now = new Date().toISOString();
  const fromBroker = {
    user_id: conv.brokerId || fullUser.id,
    name:    conv.brokerName || fullUser.name || '',
  };
  const toBroker = {
    user_id: target.id,
    name:    target.name || '',
  };

  // Record the transfer
  conv.brokerId    = target.id;
  conv.brokerName  = target.name || '';
  conv.updatedAt   = now;
  // Reset unreadBroker for the NEW broker so they see it as a fresh thread
  conv.unreadBroker = Math.max(1, conv.unreadBroker || 0);

  if (!Array.isArray(conv.transferHistory)) conv.transferHistory = [];
  conv.transferHistory.push({
    from:       fromBroker,
    to:         toBroker,
    at:         now,
    by:         fullUser.id,
    byName:     fullUser.name || '',
    reason:     (reason || '').toString().slice(0, 300),
  });

  // Append a system message so both client and new agent see the hand-off.
  const systemMsg = {
    id:         msgId(),
    senderId:   'system',
    senderRole: 'system',
    senderName: 'HogaresRD',
    text:       `Conversación transferida de ${fromBroker.name || 'agente anterior'} a ${toBroker.name}. A partir de ahora, ${toBroker.name} será tu punto de contacto.`,
    timestamp:  now,
    system:     true,
    type:       'transfer',
  };
  if (!Array.isArray(conv.messages)) conv.messages = [];
  conv.messages.push(systemMsg);
  conv.lastMessage = systemMsg.text;

  store.saveConversation(conv);

  // Notify the receiving agent via push + email
  try {
    pushNotify(target.id, {
      type:  'conversation_transferred',
      title: `📋 Nueva conversación transferida`,
      body:  `${fullUser.name || 'Un agente'} te transfirió la conversación con ${conv.clientName || 'un cliente'}`,
      url:   `/mensajes?conv=${conv.id}`,
    });
  } catch (_) {}
  if (target.email) {
    _sendMail(
      target.email,
      `Conversación transferida — ${conv.propertyTitle || 'HogaresRD'}`,
      `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;">
         <div style="background:#002D62;color:#fff;padding:1.25rem;border-radius:10px 10px 0 0;text-align:center;">
           <h2 style="margin:0;font-size:1.1rem;">Nueva conversación transferida</h2>
         </div>
         <div style="background:#fff;padding:1.25rem 1.5rem;border:1px solid #e0e0e0;border-top:none;border-radius:0 0 10px 10px;">
           <p style="margin:0 0 10px;color:#1a2b40;">Hola <strong>${(target.name||'').split(' ')[0] || 'agente'}</strong>,</p>
           <p style="margin:0 0 14px;color:#4d6a8a;font-size:0.92rem;line-height:1.5;">
             <strong>${fullUser.name || 'Un compañero'}</strong> te transfirió una conversación con
             <strong>${conv.clientName || 'un cliente'}</strong> sobre
             <strong>${conv.propertyTitle || 'una propiedad'}</strong>.
             ${reason ? 'Motivo: <em>' + String(reason).replace(/</g,'&lt;').slice(0,200) + '</em>' : ''}
           </p>
           <a href="${BASE_URL}/broker#mensajes" style="display:inline-block;background:#0038A8;color:#fff;padding:0.7rem 1.4rem;border-radius:8px;text-decoration:none;font-weight:700;">Abrir conversación →</a>
         </div>
       </div>`
    );
  }

  // Notify the client that they have a new agent
  if (conv.clientId) {
    try {
      pushNotify(conv.clientId, {
        type:  'new_message',
        title: `💬 Nuevo agente asignado`,
        body:  `${toBroker.name} ahora es tu punto de contacto sobre ${conv.propertyTitle || 'tu propiedad'}`,
        url:   `/mensajes?conv=${conv.id}`,
      });
    } catch (_) {}
  }

  res.json({ ok: true, conversation: conv });
});

module.exports = router;
