const express = require('express');
const router  = express.Router();
const store   = require('./store');
const notify  = require('../utils/twilio');

const PRO_ROLES = ['agency', 'broker', 'inmobiliaria'];

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
  const { propertyId, propertyTitle, propertyImage, message } = req.body;

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
    id:            uid(),
    propertyId,
    propertyTitle:  propertyTitle || 'Propiedad',
    propertyImage:  propertyImage || null,
    clientId:       user.sub,
    clientName:     user.name,
    brokerId:       null,   // assigned when broker first replies
    brokerName:     null,
    createdAt:      new Date().toISOString(),
    updatedAt:      new Date().toISOString(),
    lastMessage:    message.trim(),
    unreadBroker:   1,
    unreadClient:   0,
    messages:       [msg],
  };

  store.saveConversation(conv);
  res.status(201).json({ conversation: conv });
});

// ── GET /api/conversations ────────────────────────────────────────────────
// Client: their own. Broker/agency/inmobiliaria: assigned to them or unassigned.
router.get('/', requireLogin, (req, res) => {
  const user = getUser(req);
  let convs;

  if (user.role === 'user') {
    convs = store.getConversationsByClient(user.sub);
  } else if (PRO_ROLES.includes(user.role)) {
    convs = store.getConversationsForBroker(user.sub);
  } else {
    convs = store.getConversations(); // admin sees all
  }

  // Return without full message array for list view (just metadata)
  const list = convs.map(({ messages, ...meta }) => ({
    ...meta,
    messageCount: messages.length,
  }));

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

  if (!isClient && !isBroker) {
    return res.status(403).json({ error: 'Sin acceso.' });
  }

  // Since the request comes with ?since= for polling, return only new messages
  const since = req.query.since ? new Date(req.query.since) : null;
  const messages = since
    ? conv.messages.filter(m => new Date(m.timestamp) > since)
    : conv.messages;

  res.json({ ...conv, messages });
});

// ── POST /api/conversations/:id/messages ─────────────────────────────────
router.post('/:id/messages', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const { text } = req.body;
  if (!text?.trim()) return res.status(400).json({ error: 'Mensaje vacío.' });

  const isBroker = PRO_ROLES.includes(user.role);
  const isClient = conv.clientId === user.sub;

  if (!isClient && !isBroker) {
    return res.status(403).json({ error: 'Sin acceso.' });
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

  // ── Fire-and-forget notifications ────────────────────────────────────────
  setImmediate(async () => {
    try {
      if (isBroker) {
        // Broker replied → notify client via SMS
        const clientUser = store.getUserById(conv.clientId);
        if (clientUser?.phone) {
          await notify.notifyClientBrokerReply({
            clientPhone:    clientUser.phone,
            brokerName:     user.name,
            propertyTitle:  conv.propertyTitle,
            messagePreview: text.trim(),
            convId:         conv.id,
          });
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

// ── PUT /api/conversations/:id/read ──────────────────────────────────────
router.put('/:id/read', requireLogin, (req, res) => {
  const user = getUser(req);
  const conv = store.getConversationById(req.params.id);
  if (!conv) return res.status(404).json({ error: 'Conversación no encontrada.' });

  const isBroker = PRO_ROLES.includes(user.role);

  if (isBroker) {
    conv.unreadBroker = 0;
  } else {
    conv.unreadClient = 0;
  }

  store.saveConversation(conv);
  res.json({ ok: true });
});

module.exports = router;
