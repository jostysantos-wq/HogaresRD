const express   = require('express');
const Anthropic  = require('@anthropic-ai/sdk');
const rateLimit  = require('express-rate-limit');
const { userAuth } = require('./auth');

const router = express.Router();
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Rate limit: 40 messages per hour per user ─────────────────────────────
// userAuth runs first so req.user.sub is always available — no IP fallback needed.
const chatLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 40,
  keyGenerator: req => req.user.sub,   // always set — userAuth is a prerequisite
  handler: (req, res) => res.status(429).json({
    error: 'Límite de mensajes alcanzado. Intenta de nuevo en una hora.'
  }),
  standardHeaders: true,
  legacyHeaders: false,
  validate: { xForwardedForHeader: false }, // suppress IPv6 warning; not using IP
});

// ── System prompt ──────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `Eres un asistente de IA especializado en bienes raíces para HogaresRD, una plataforma inmobiliaria de la República Dominicana. Asistes a agentes y brokers a gestionar clientes, entender el mercado y cerrar más ventas.

CONOCIMIENTO DE LA PLATAFORMA:
Pipeline de aplicaciones (en orden):
  aplicado → en_revision → documentos_requeridos → documentos_enviados → documentos_insuficientes → en_aprobacion → reservado → aprobado → pendiente_pago → pago_enviado → pago_aprobado → completado
  (puede terminar en "rechazado" desde cualquier etapa)

Documentos típicos: cédula, pasaporte, comprobante de ingresos, estado de cuenta bancario, carta de trabajo, declaración de impuestos, carta de pre-aprobación bancaria, prueba de fondos.

Moneda: Peso Dominicano (RD$). Mercados clave: Santo Domingo (Piantini, Naco, Evaristo Morales, Bella Vista, Los Cacicazgos, Serrallés), Santiago, Punta Cana, La Romana, Puerto Plata, Bávaro.

INSTRUCCIONES:
- Responde SIEMPRE en español.
- Sé conciso, práctico y directo. Respuestas de máximo 3-4 párrafos o una lista corta.
- Si el agente comparte datos de sus aplicaciones, úsalos para dar consejos personalizados.
- Cuando des consejos de negociación o cierre, adapta al contexto dominicano.
- Si no tienes información específica, dilo con honestidad.
- Puedes ayudar con: gestión de pipeline, estrategias de cierre, revisión de documentos, análisis de mercado local, manejo de objeciones, seguimiento de clientes.`;

// ── POST /api/chat ─────────────────────────────────────────────────────────
router.post('/', userAuth, chatLimiter, async (req, res) => {
  const { message, history = [], context = {} } = req.body;

  // Validate
  if (!message || typeof message !== 'string' || !message.trim()) {
    return res.status(400).json({ error: 'Mensaje requerido' });
  }
  if (message.length > 2000) {
    return res.status(400).json({ error: 'Mensaje demasiado largo (máx. 2000 caracteres)' });
  }
  if (!Array.isArray(history)) {
    return res.status(400).json({ error: 'Historial inválido' });
  }

  // Build messages — keep last 10 turns for context (cost control)
  const messages = [];

  const recentHistory = history.slice(-10);
  for (const turn of recentHistory) {
    if ((turn.role === 'user' || turn.role === 'assistant') && typeof turn.content === 'string' && turn.content.trim()) {
      messages.push({ role: turn.role, content: turn.content.trim() });
    }
  }

  // Inject broker context (pipeline summary) as a system note prepended to user message
  let userContent = message.trim();
  if (context.brokerName || context.stats) {
    const parts = [];
    if (context.brokerName) parts.push(`Agente: ${context.brokerName}`);
    if (context.stats) {
      const s = context.stats;
      if (s.total)        parts.push(`Total aplicaciones: ${s.total}`);
      if (s.pipeline)     parts.push(`Pipeline activo: ${JSON.stringify(s.pipeline)}`);
      if (s.new_this_week !== undefined) parts.push(`Nuevas esta semana: ${s.new_this_week}`);
    }
    if (parts.length) {
      userContent = `[Contexto del agente: ${parts.join(' | ')}]\n\n${userContent}`;
    }
  }

  messages.push({ role: 'user', content: userContent });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages,
    });

    const reply = response.content?.[0]?.text || 'No pude generar una respuesta. Intenta de nuevo.';
    res.json({ reply });
  } catch (err) {
    console.error('[chat] Anthropic error:', err?.status, err?.message);
    if (err?.status === 429) {
      return res.status(429).json({ error: 'Servicio ocupado. Intenta en unos segundos.' });
    }
    if (err?.status === 401) {
      return res.status(500).json({ error: 'Error de configuración del servicio IA.' });
    }
    res.status(500).json({ error: 'Error al procesar tu pregunta. Intenta de nuevo.' });
  }
});

module.exports = router;
