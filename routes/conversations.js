const express      = require('express');
const crypto       = require('crypto');
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
const et           = require('../utils/email-templates');
const { logSec }   = require('./security-log');

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
    store.addMessage(existing.id, msg);
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

  // If no inmobiliariaId from ref token, try to resolve from the listing's agencies
  if (!inmobiliariaId && propertyId) {
    const listing = store.getListingById(propertyId);
    if (listing) {
      // Check listing creator
      const creator = listing.creator_user_id ? store.getUserById(listing.creator_user_id) : null;
      if (creator && ['inmobiliaria', 'constructora'].includes(creator.role)) {
        inmobiliariaId = creator.id;
      }
      // Check affiliated agencies
      if (!inmobiliariaId && Array.isArray(listing.agencies)) {
        for (const a of listing.agencies) {
          if (!a.user_id) continue;
          const agentUser = store.getUserById(a.user_id);
          if (agentUser && ['inmobiliaria', 'constructora'].includes(agentUser.role)) {
            inmobiliariaId = agentUser.id;
            break;
          }
          if (agentUser?.inmobiliaria_id) {
            inmobiliariaId = agentUser.inmobiliaria_id;
            break;
          }
        }
      }
    }
  }

  const conv = {
    id:             uid(),
    propertyId,
    propertyTitle:  propertyTitle || 'Propiedad',
    propertyImage:  propertyImage || null,
    clientId:       user.sub,
    clientName:     user.name,
    brokerId:       assignedBrokerId,   // pre-assigned from ref link, or null
    brokerName:     assignedBrokerName,
    inmobiliariaId: inmobiliariaId,      // set from ref link or listing agencies
    refToken:       refTk || null,
    createdAt:      new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
    lastMessage:    message.trim(),
    unreadBroker:   1,
    unreadClient:   0,
    message_count:  1,
  };

  store.saveConversation(conv);
  store.addMessage(conv.id, msg);

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

  // Return without full message array for list view (just metadata)
  // Enrich with participant avatars for display in conversation list
  const list = convs.map(meta => {
    const isMyConv = meta.brokerId === user.sub || meta.clientId === user.sub;
    const isUnclaimed = meta.inmobiliariaId && !meta.brokerId;

    // Attach current avatars for both parties
    meta.clientAvatar = store.getUserById(meta.clientId)?.avatarUrl || null;
    meta.brokerAvatar = meta.brokerId ? (store.getUserById(meta.brokerId)?.avatarUrl || null) : null;

    // Strict: only the assigned broker and the client see lastMessage.
    // Unclaimed org conversations: ALL org agents see redacted metadata only.
    // Even the inmobiliaria director does NOT see message content until claimed.
    if (!isMyConv && user.role !== 'admin') {
      const firstName = (meta.clientName || '').split(' ')[0];
      return {
        ...meta,
        clientName:   firstName,
        clientEmail:  null,
        clientPhone:  null,
        lastMessage:  isUnclaimed ? 'Nuevo mensaje pendiente' : 'Conversacion asignada',
        messageCount: meta.message_count || 0,
        claimRequired: isUnclaimed,
      };
    }

    return { ...meta, messageCount: meta.message_count || 0 };
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
    const count = convs.filter(c => !c.closed && !c.archived && (c.unreadClient || 0) > 0).length;
    return res.json({ count });
  }

  if (PRO_ROLES.includes(user.role)) {
    // Only count unread for conversations where this user is the ASSIGNED broker
    convs = store.getConversationsForBroker(user.sub);
    // Also conversations where this pro user is the client
    const clientConvs = store.getConversationsByClient(user.sub);
    for (const cc of clientConvs) {
      if (!convs.some(x => x.id === cc.id)) convs.push(cc);
    }
    // Include unclaimed org conversations in unread count.
    // Covers both org-scoped (inmobiliariaId matches) and orphaned
    // conversations on the org's listings (inmobiliariaId is null).
    const fullUser = store.getUserById(user.sub);
    const inmId = ['inmobiliaria', 'constructora'].includes(fullUser?.role)
      ? fullUser.id : fullUser?.inmobiliaria_id;
    if (inmId) {
      const allConvs = store.getConversations();
      for (const c of allConvs) {
        if (c.brokerId || convs.some(x => x.id === c.id)) continue;
        if (c.inmobiliariaId === inmId) { convs.push(c); continue; }
        // Orphaned: check if listing belongs to this org
        if (!c.inmobiliariaId && c.propertyId) {
          const listing = store.getListingById(c.propertyId);
          if (listing && (listing.creator_user_id === inmId ||
            (Array.isArray(listing.agencies) && listing.agencies.some(a => a.user_id === inmId)))) {
            convs.push(c);
          }
        }
      }
    }
    // Count active conversations with unread messages (exclude closed/archived)
    const count = convs.filter(c => {
      if (c.closed || c.archived) return false;
      const isClientHere = c.clientId === user.sub;
      if (isClientHere) return (c.unreadClient || 0) > 0;
      return (c.unreadBroker || 0) > 0;
    }).length;
    return res.json({ count });
  }

  res.json({ count: 0 });
});

// ── GET /api/conversations/:id ────────────────────────────────────────────
router.get('/:id', requireLogin, async (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  // ── Strict access: only the assigned broker, the client, or admin can read messages.
  // Inmobiliaria owners/directors do NOT get message access — they must request
  // it through admin if needed. This protects client privacy.
  const isClient         = conv.clientId === user.sub;
  const isAssignedBroker = conv.brokerId === user.sub;
  const isAdmin          = user.role === 'admin';

  // Org agents (same inmobiliaria) can SEE that an unclaimed convo exists
  // but cannot read messages — only claim metadata is returned.
  const isPro    = PRO_ROLES.includes(user.role);
  const fullUser = isPro ? store.getUserById(user.sub) : null;
  const userInmId = fullUser
    ? (['inmobiliaria', 'constructora'].includes(fullUser.role) ? fullUser.id : fullUser.inmobiliaria_id)
    : null;
  // Org-scoped unclaimed: conversation belongs to this org, or has no broker/org
  // and was started on a listing the inmobiliaria owns.
  const isOrgUnclaimed = isPro && userInmId && !conv.brokerId && (
    conv.inmobiliariaId === userInmId ||
    // Orphaned conversations (no inmobiliariaId) — check if the listing belongs to this org
    (!conv.inmobiliariaId && conv.propertyId && (() => {
      const listing = store.getListingById(conv.propertyId);
      return listing && (listing.creator_user_id === userInmId ||
        (Array.isArray(listing.agencies) && listing.agencies.some(a => a.user_id === userInmId)));
    })())
  );

  if (!isClient && !isAssignedBroker && !isOrgUnclaimed && !isAdmin) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  // Unclaimed org conversations: ALL org agents (including the director) see
  // only a claim prompt — no messages. They must claim first.
  if (isOrgUnclaimed && !isAssignedBroker) {
    const firstName = (conv.clientName || '').split(' ')[0];

    // Fetch client's recent property viewing activity (no PII, just listing titles)
    let clientActivity = [];
    try {
      const activities = await store.getActivityByUser(conv.clientId, { limit: 10, days: 30, action: 'view_listing' });
      clientActivity = activities.map(a => {
        const listing = store.getListingById(a.listing_id);
        return {
          listing_id: a.listing_id,
          listing_title: listing?.title || 'Propiedad',
          listing_city: listing?.city || '',
          listing_price: listing?.price || null,
          viewed_at: a.created_at,
        };
      });
    } catch {}

    return res.json({
      id:             conv.id,
      propertyId:     conv.propertyId,
      propertyTitle:  conv.propertyTitle,
      propertyImage:  conv.propertyImage,
      clientName:     firstName,
      inmobiliariaId: conv.inmobiliariaId,
      messageCount:   conv.message_count || 0,
      createdAt:      conv.createdAt,
      claimRequired:  true,
      messages:       [], // hidden until claimed
      clientActivity,
    });
  }

  // Audit: log admin access to conversation content
  if (isAdmin) {
    logSec('admin_conversation_access', req, {
      adminUserId: user.sub,
      adminName: user.name || '',
      conversationId: conv.id,
      clientId: conv.clientId,
      brokerId: conv.brokerId,
      reason: req.query.reason || null,
    });
  }

  // Since the request comes with ?since= for polling, return only new messages
  const since = req.query.since || null;
  const MAX_INITIAL = 50;
  const totalMessages = await store.getMessageCount(conv.id);
  const messages = await store.getMessages(conv.id, { since, limit: MAX_INITIAL });
  const hasMore = !since && totalMessages > MAX_INITIAL;

  // Enrich messages with sender avatars (looked up at read time so they stay fresh)
  const _avatarCache = {};
  for (const m of messages) {
    if (m.senderId && m.senderId !== 'system' && !_avatarCache.hasOwnProperty(m.senderId)) {
      const u = store.getUserById(m.senderId);
      _avatarCache[m.senderId] = u?.avatarUrl || null;
    }
    m.senderAvatar = _avatarCache[m.senderId] || null;
  }

  // Attach participant avatars
  const clientAvatar = store.getUserById(conv.clientId)?.avatarUrl || null;
  const brokerAvatar = conv.brokerId ? (store.getUserById(conv.brokerId)?.avatarUrl || null) : null;

  // Auto-mark-read on INITIAL load (no ?since= = user just opened the thread).
  // Use clientId match (not global role) to determine which side to clear —
  // a pro user who is the CLIENT should clear unreadClient, not unreadBroker.
  if (!since) {
    let dirty = false;
    const isClientSide = conv.clientId === user.sub;
    if (!isClientSide && conv.unreadBroker) { conv.unreadBroker = 0; dirty = true; }
    if (isClientSide && conv.unreadClient)  { conv.unreadClient = 0; dirty = true; }
    if (dirty) {
      store.saveConversation(conv);
      // Silent push so the icon badge reflects the new (lower) unread count
      // even while the app is closed on other devices.
      try { require('./push').refreshBadge(user.sub); } catch {}
    }
  }

  res.json({ ...conv, messages, hasMore, totalMessages, clientAvatar, brokerAvatar });
});

// ── POST /api/conversations/:id/claim ────────────────────────────────────
// Agent explicitly claims an unclaimed org conversation.
// Uses atomic DB UPDATE WHERE "brokerId" IS NULL to prevent race conditions.
router.post('/:id/claim', requireLogin, async (req, res) => {
  const user = getUser(req);
  if (!PRO_ROLES.includes(user.role))
    return res.status(403).json({ error: 'Solo agentes pueden reclamar conversaciones.' });

  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada.' });

  // Must be unclaimed
  if (conv.brokerId)
    return res.status(400).json({ error: 'Esta conversacion ya fue reclamada por otro agente.' });

  // Verify agent belongs to the conversation's org or is the org owner
  const fullUser = store.getUserById(user.sub);
  const userInmId = ['inmobiliaria', 'constructora'].includes(fullUser?.role)
    ? fullUser.id : fullUser?.inmobiliaria_id;

  if (conv.inmobiliariaId && conv.inmobiliariaId !== userInmId && conv.inmobiliariaId !== user.sub)
    return res.status(403).json({ error: 'No perteneces a esta organizacion.' });

  // Atomic DB claim: UPDATE only if brokerId is still NULL
  // This prevents the TOCTOU race where two agents claim simultaneously
  const now = new Date().toISOString();
  const sysMsg = {
    id:         'msg_' + crypto.randomBytes(6).toString('hex'),
    senderId:   'system',
    senderRole: 'system',
    senderName: 'HogaresRD',
    text:       `${user.name} ha tomado esta conversacion.`,
    timestamp:  now,
  };

  // claimConversationAtomic already wraps the conversation UPDATE + system
  // message INSERT in its own BEGIN/COMMIT. This route does NOT mutate the
  // application (no broker assignment writeback yet), so a single atomic
  // call is sufficient. If a future change starts touching app.assigned_broker
  // or saveConversation here, wrap both in store.withTransaction(...) so all
  // writes commit together.
  try {
    const result = await store.claimConversationAtomic(req.params.id, user.sub, user.name, now, sysMsg);
    if (!result) {
      return res.status(400).json({ error: 'Esta conversacion ya fue reclamada por otro agente.' });
    }
    res.json({ ok: true, conversation: result });
  } catch (err) {
    console.error('[claim] atomic claim failed:', err.message);
    return res.status(500).json({ error: 'Error al reclamar la conversacion.' });
  }
});

// ── POST /api/conversations/:id/messages ─────────────────────────────────
router.post('/:id/messages', msgRateLimiter, requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

  // ── Strict access: only the assigned broker and the client can send messages.
  // Agents must CLAIM an unclaimed conversation first (POST /:id/claim) before
  // they can post. Inmobiliaria directors cannot send messages on behalf of agents.
  const isClient         = conv.clientId === user.sub;
  const isAssignedBroker = conv.brokerId === user.sub;
  const isAdmin          = user.role === 'admin';
  const isBroker         = isAssignedBroker; // only the assigned broker sends as "broker"

  if (!isClient && !isAssignedBroker && !isAdmin) {
    if (!conv.brokerId && PRO_ROLES.includes(user.role)) {
      return res.status(403).json({ error: 'Debes reclamar esta conversacion antes de enviar mensajes.' });
    }
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  // Audit: log admin message posting
  if (isAdmin) {
    logSec('admin_conversation_message', req, {
      adminUserId: user.sub, conversationId: conv.id,
      clientId: conv.clientId, brokerId: conv.brokerId,
    });
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

  store.addMessage(conv.id, msg);
  conv.lastMessage = text.trim();
  conv.updatedAt   = new Date().toISOString();

  // Update unread counters
  if (isBroker) {
    conv.unreadClient = (conv.unreadClient || 0) + 1;
  } else {
    conv.unreadBroker = (conv.unreadBroker || 0) + 1;
  }

  store.saveConversation(conv);
  res.json({ message: msg });

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
            `${user.name} respondio sobre "${conv.propertyTitle}" - HogaresRD`,
            et.layout({
              title: 'Nuevo mensaje de tu agente',
              subtitle: conv.propertyTitle,
              preheader: 'Tu agente respondio a tu consulta',
              body: [
                et.p(`<strong>${et.esc(user.name)}</strong> respondio sobre <strong>${et.esc(conv.propertyTitle)}</strong>:`),
                et.quote(et.esc(preview)),
                et.button('Ver conversacion', `${BASE_URL}/mensajes?conv=${conv.id}`),
              ].join('\n'),
            })
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

  if (!PRO_ROLES.includes(user.role) && user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo agentes pueden cerrar conversaciones.' });
  }
  // Strict: only the assigned broker can close claimed conversations.
  // Inmobiliaria directors cannot close their agents' conversations.
  if (conv.brokerId && conv.brokerId !== user.sub && user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el agente asignado puede cerrar esta conversacion.' });
  }
  // Unclaimed conversations: only the org director or admin can close
  if (!conv.brokerId && user.role !== 'admin') {
    const fullUser = store.getUserById(user.sub);
    const isOrgOwner = conv.inmobiliariaId
      && ['inmobiliaria', 'constructora'].includes(fullUser?.role)
      && fullUser.id === conv.inmobiliariaId;
    if (!isOrgOwner) {
      return res.status(403).json({ error: 'Solo el director de la inmobiliaria o admin puede cerrar conversaciones sin asignar.' });
    }
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
  store.addMessage(conv.id, closeMsg);
  store.addMessage(conv.id, archiveNotice);
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

  if (!PRO_ROLES.includes(user.role) && user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo agentes pueden reabrir conversaciones.' });
  }
  // Strict: only the assigned broker can reopen claimed conversations.
  if (conv.brokerId && conv.brokerId !== user.sub && user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el agente asignado puede reabrir esta conversacion.' });
  }
  // Unclaimed conversations: only the org director or admin can reopen
  if (!conv.brokerId && user.role !== 'admin') {
    const fullUser = store.getUserById(user.sub);
    const isOrgOwner = conv.inmobiliariaId
      && ['inmobiliaria', 'constructora'].includes(fullUser?.role)
      && fullUser.id === conv.inmobiliariaId;
    if (!isOrgOwner) {
      return res.status(403).json({ error: 'Solo el director de la inmobiliaria o admin puede reabrir conversaciones sin asignar.' });
    }
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
  store.addMessage(conv.id, sysMsg);
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

  const isClientSide     = conv.clientId === user.sub;
  const isAssignedBroker = conv.brokerId && conv.brokerId === user.sub;
  const isAdmin          = user.role === 'admin';

  // Pro users can mark-read conversations where they are the inmobiliariaId
  // (org owner) or belong to the same org — including unclaimed ones.
  const fullUser = store.getUserById(user.sub);
  const userInmId = effectiveInmId(fullUser);
  const isOrgOwner = (
    // Direct match: user's ID is the conversation's inmobiliariaId
    (conv.inmobiliariaId && conv.inmobiliariaId === user.sub) ||
    // Org match: user belongs to the same org
    (userInmId && conv.inmobiliariaId === userInmId)
  );

  if (!isClientSide && !isAssignedBroker && !isOrgOwner && !isAdmin) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  if (isClientSide) conv.unreadClient = 0;
  if (isAssignedBroker || isOrgOwner || (isAdmin && !isClientSide)) conv.unreadBroker = 0;

  store.saveConversation(conv);
  try { require('./push').refreshBadge(user.sub); } catch {}
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

  // Strict: only the assigned broker can see transfer targets (not the org owner).
  // The org owner cannot read messages and therefore should not manage conversation routing.
  const isOwner = conv.brokerId === fullUser.id;
  if (!isOwner && user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el agente asignado puede transferir esta conversacion.' });
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

  // Strict: only the assigned broker can initiate a transfer.
  // Inmobiliaria directors cannot transfer conversations they don't own.
  const isOwner = conv.brokerId === fullUser.id;
  if (!isOwner && user.role !== 'admin') {
    return res.status(403).json({ error: 'Solo el agente asignado puede transferir esta conversacion.' });
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
  store.addMessage(conv.id, systemMsg);
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
      `Conversacion transferida - ${conv.propertyTitle || 'HogaresRD'}`,
      et.layout({
        title: 'Conversacion transferida',
        subtitle: conv.propertyTitle || 'Nueva asignacion',
        preheader: `Nuevo mensaje de ${conv.clientName || 'un cliente'} sobre ${conv.propertyTitle || 'una propiedad'}`,
        body: [
          et.p(`Hola <strong>${et.esc((target.name||'').split(' ')[0] || 'agente')}</strong>,`),
          et.p(
            `<strong>${et.esc(fullUser.name || 'Un companero')}</strong> te transfirio una conversacion con ` +
            `<strong>${et.esc(conv.clientName || 'un cliente')}</strong> sobre ` +
            `<strong>${et.esc(conv.propertyTitle || 'una propiedad')}</strong>.` +
            (reason ? ' Motivo: <em>' + et.esc(String(reason).slice(0, 200)) + '</em>' : '')
          ),
          et.button('Abrir conversacion', `${BASE_URL}/broker#mensajes`),
        ].join('\n'),
      })
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

// ── POST /api/conversations/:id/request-transfer ────────────────────────
// Inmobiliaria director REQUESTS a transfer without reading messages.
// The assigned broker receives a notification and can accept or decline.
router.post('/:id/request-transfer', requireLogin, async (req, res) => {
  const user = getUser(req);
  const fullUser = store.getUserById(user.sub);

  // Only inmobiliaria/constructora directors can request transfers
  if (!fullUser || !['inmobiliaria', 'constructora'].includes(fullUser.role)) {
    return res.status(403).json({ error: 'Solo directores de inmobiliaria pueden solicitar transferencias.' });
  }

  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada.' });

  // Conversation must be claimed and belong to this org
  if (!conv.brokerId) {
    return res.status(400).json({ error: 'La conversacion no tiene agente asignado. Usa la funcion de reclamar.' });
  }
  if (conv.inmobiliariaId !== fullUser.id) {
    return res.status(403).json({ error: 'Esta conversacion no pertenece a tu organizacion.' });
  }

  const { targetUserId, reason } = req.body || {};
  if (!targetUserId) {
    return res.status(400).json({ error: 'Debes indicar el agente destino (targetUserId).' });
  }

  const target = store.getUserById(targetUserId);
  if (!target || !PRO_ROLES.includes(target.role)) {
    return res.status(404).json({ error: 'Agente destino no encontrado.' });
  }
  if (!sameTeam(fullUser, target)) {
    return res.status(403).json({ error: 'El agente destino no pertenece a tu equipo.' });
  }
  if (target.id === conv.brokerId) {
    return res.status(400).json({ error: 'El agente destino ya es el agente asignado.' });
  }

  // Check for existing pending request
  if (!Array.isArray(conv.transfer_requests)) conv.transfer_requests = [];
  const hasPending = conv.transfer_requests.some(r => r.status === 'pending');
  if (hasPending) {
    return res.status(400).json({ error: 'Ya existe una solicitud de transferencia pendiente para esta conversacion.' });
  }

  const now = new Date();
  const expiresAt = new Date(now.getTime() + 4 * 60 * 60 * 1000); // 4 hours

  const transferReq = {
    id: 'tr_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    requestedBy: fullUser.id,
    requestedByName: fullUser.name || fullUser.companyName || '',
    targetUserId: target.id,
    targetUserName: target.name || '',
    reason: (reason || '').toString().trim().slice(0, 300),
    status: 'pending',
    createdAt: now.toISOString(),
    respondedAt: null,
    expiresAt: expiresAt.toISOString(),
  };

  // Atomic DB insert: prevents duplicate pending requests via FOR UPDATE lock
  try {
    const result = await store.addTransferRequestAtomic(req.params.id, transferReq);
    if (!result) return res.status(404).json({ error: 'Conversacion no encontrada.' });
    if (result.duplicate) {
      return res.status(400).json({ error: 'Ya existe una solicitud de transferencia pendiente para esta conversacion.' });
    }
  } catch (err) {
    console.error('[request-transfer] atomic insert failed:', err.message);
    return res.status(500).json({ error: 'Error al crear solicitud de transferencia.' });
  }

  // Notify the assigned broker via push
  try {
    pushNotify(conv.brokerId, {
      type: 'transfer_request',
      title: 'Solicitud de transferencia',
      body: `${fullUser.companyName || fullUser.name} solicita transferir la conversacion con ${conv.clientName || 'un cliente'} a ${target.name}`,
      url: '/mensajes?conv=' + conv.id,
    });
  } catch (e) { console.warn('[request-transfer] push to broker failed:', e.message); }

  // Notify via email
  const broker = store.getUserById(conv.brokerId);
  if (broker?.email) {
    _sendMail(
      broker.email,
      'Solicitud de transferencia — HogaresRD',
      et.layout({
        title: 'Solicitud de transferencia',
        subtitle: conv.propertyTitle || '',
        preheader: `${fullUser.companyName || fullUser.name} solicita transferir una conversacion`,
        body: [
          et.p(`<strong>${et.esc(fullUser.companyName || fullUser.name)}</strong> solicita que transfieras tu conversacion sobre <strong>${et.esc(conv.propertyTitle || 'una propiedad')}</strong> al agente <strong>${et.esc(target.name)}</strong>.`),
          transferReq.reason ? et.alertBox('<strong>Motivo:</strong> ' + et.esc(transferReq.reason), 'info') : '',
          et.p('Tienes 4 horas para aceptar o rechazar esta solicitud. Si no respondes, la solicitud expirara automaticamente.'),
          et.button('Ver conversacion', (process.env.BASE_URL || 'https://hogaresrd.com') + '/mensajes?conv=' + conv.id),
        ].join('\n'),
      })
    );
  }

  res.json({ success: true, request: transferReq });
});

// ── PUT /api/conversations/:id/respond-transfer ─────────────────────────
// Assigned broker accepts or declines a transfer request from their director.
router.put('/:id/respond-transfer', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversacion no encontrada.' });

  // Only the assigned broker can respond
  if (conv.brokerId !== user.sub) {
    return res.status(403).json({ error: 'Solo el agente asignado puede responder a la solicitud.' });
  }

  const { requestId, action } = req.body || {};
  if (!requestId || !['accept', 'decline'].includes(action)) {
    return res.status(400).json({ error: 'requestId y action (accept/decline) son requeridos.' });
  }

  if (!Array.isArray(conv.transfer_requests)) conv.transfer_requests = [];
  const tr = conv.transfer_requests.find(r => r.id === requestId);
  if (!tr) return res.status(404).json({ error: 'Solicitud de transferencia no encontrada.' });
  if (tr.status !== 'pending') {
    return res.status(400).json({ error: `La solicitud ya fue ${tr.status === 'accepted' ? 'aceptada' : tr.status === 'declined' ? 'rechazada' : 'procesada'}.` });
  }
  if (new Date(tr.expiresAt) < new Date()) {
    tr.status = 'expired';
    store.saveConversation(conv);
    return res.status(400).json({ error: 'La solicitud ha expirado.' });
  }

  const now = new Date().toISOString();
  tr.respondedAt = now;

  if (action === 'decline') {
    tr.status = 'declined';
    conv.updatedAt = now;
    store.saveConversation(conv);

    // Notify director that request was declined
    try {
      pushNotify(tr.requestedBy, {
        type: 'transfer_declined',
        title: 'Transferencia rechazada',
        body: `${user.name} rechazo la solicitud de transferencia`,
        url: '/broker',
      });
    } catch (e) { console.warn('[respond-transfer] push to director failed:', e.message); }

    return res.json({ success: true, status: 'declined' });
  }

  // action === 'accept' — execute the transfer

  // Re-check expiration right before accepting (guard against network delay / race)
  if (new Date(tr.expiresAt) < new Date()) {
    tr.status = 'expired';
    store.saveConversation(conv);
    return res.status(400).json({ error: 'La solicitud expiro mientras se procesaba.' });
  }

  // Re-validate broker ownership (guard against concurrent transfer/reassignment)
  const freshConv = store.getConversationById(req.params.id);
  if (!freshConv || freshConv.brokerId !== user.sub) {
    return res.status(409).json({ error: 'La conversacion fue reasignada mientras respondias. Recarga la pagina.' });
  }

  const target = store.getUserById(tr.targetUserId);
  if (!target || !PRO_ROLES.includes(target.role)) {
    return res.status(400).json({ error: 'El agente destino ya no existe o cambio de rol.' });
  }
  // Re-validate same team (target may have left the org since the request was created)
  const currentBroker = store.getUserById(conv.brokerId);
  if (!sameTeam(currentBroker, target)) {
    return res.status(400).json({ error: 'El agente destino ya no pertenece al mismo equipo.' });
  }

  tr.status = 'accepted';

  const fromBroker = { user_id: conv.brokerId, name: conv.brokerName || user.name || '' };
  const toBroker = { user_id: target.id, name: target.name || '' };

  // Execute transfer
  conv.brokerId = target.id;
  conv.brokerName = target.name || '';
  conv.updatedAt = now;
  conv.unreadBroker = Math.max(1, conv.unreadBroker || 0);

  if (!Array.isArray(conv.transferHistory)) conv.transferHistory = [];
  conv.transferHistory.push({
    from: fromBroker,
    to: toBroker,
    at: now,
    by: user.sub,
    byName: user.name || '',
    reason: tr.reason || 'Solicitud del director',
    viaRequest: tr.id,
  });

  // System message
  const sysMsg = {
    id: 'msg_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    senderId: 'system',
    senderRole: 'system',
    senderName: 'HogaresRD',
    text: `Conversacion transferida de ${fromBroker.name} a ${toBroker.name}. A partir de ahora, ${toBroker.name} sera tu punto de contacto.`,
    timestamp: now,
    system: true,
    type: 'transfer',
  };
  store.addMessage(conv.id, sysMsg);
  conv.lastMessage = sysMsg.text;

  store.saveConversation(conv);

  // Email + push to target agent
  try {
    pushNotify(target.id, {
      type: 'conversation_transferred',
      title: 'Conversacion transferida',
      body: `${user.name} te transfirio una conversacion con ${conv.clientName || 'un cliente'}`,
      url: '/mensajes?conv=' + conv.id,
    });
  } catch (e) { console.warn('[respond-transfer] push to target failed:', e.message); }
  if (target.email) {
    _sendMail(target.email, `Conversacion transferida — ${conv.propertyTitle || 'HogaresRD'}`,
      et.layout({
        title: 'Conversacion transferida',
        subtitle: conv.propertyTitle || '',
        preheader: `${user.name} te transfirio una conversacion`,
        body: et.p(`<strong>${et.esc(user.name)}</strong> te transfirio una conversacion sobre <strong>${et.esc(conv.propertyTitle || 'una propiedad')}</strong>.`)
          + et.button('Abrir conversacion', (process.env.BASE_URL || 'https://hogaresrd.com') + '/mensajes?conv=' + conv.id),
      })
    );
  }

  // Email + push to director
  try {
    pushNotify(tr.requestedBy, {
      type: 'transfer_accepted',
      title: 'Transferencia aceptada',
      body: `${user.name} acepto la transferencia a ${target.name}`,
      url: '/broker',
    });
  } catch (e) { console.warn('[respond-transfer] push to director failed:', e.message); }
  const director = store.getUserById(tr.requestedBy);
  if (director?.email) {
    _sendMail(director.email, 'Transferencia aceptada — HogaresRD',
      et.layout({
        title: 'Transferencia aceptada',
        preheader: `${user.name} acepto la transferencia a ${target.name}`,
        body: et.p(`<strong>${et.esc(user.name)}</strong> acepto transferir la conversacion sobre <strong>${et.esc(conv.propertyTitle || 'una propiedad')}</strong> a <strong>${et.esc(target.name)}</strong>.`),
      })
    );
  }

  // Notify client
  if (conv.clientId) {
    try {
      pushNotify(conv.clientId, {
        type: 'new_message',
        title: 'Nuevo agente asignado',
        body: `${toBroker.name} ahora es tu punto de contacto`,
        url: '/mensajes?conv=' + conv.id,
      });
    } catch {}
  }

  res.json({ success: true, status: 'accepted', conversation: conv });
});

module.exports = router;
