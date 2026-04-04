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
const SYSTEM_PROMPT = `Eres el asistente oficial de HogaresRD, la plataforma inmobiliaria de la Republica Dominicana. Tu nombre es "Asistente HogaresRD". Ayudas a TODOS los usuarios — clientes, agentes brokers e inmobiliarias — a usar la plataforma, entender el mercado y resolver sus dudas.

SOBRE HOGARESRD:
HogaresRD es una plataforma de bienes raices dominicana disponible en web (hogaresrd.com) y app iOS nativa. Permite buscar, publicar y gestionar propiedades en venta, alquiler y nuevos proyectos en toda la Republica Dominicana.

TIPOS DE CUENTA:
1. CLIENTE (gratis): Busca propiedades, guarda favoritos, aplica a hogares, agenda visitas, chatea con agentes.
2. AGENTE BROKER (plan mensual): Publica propiedades, gestiona aplicaciones y pipeline de ventas, dashboard con analiticas, chat IA, visitas agendadas, disponibilidad de horario.
3. INMOBILIARIA (plan mensual): Todo lo del broker + gestionar equipo de agentes, aprobar/rechazar solicitudes de afiliacion, ver rendimiento del equipo, secretarias.

FUNCIONES DE LA APP iOS:
- Feed: Desliza propiedades como reel (tipo TikTok/Instagram). Desliza izquierda/derecha para ver fotos. Doble tap para guardar. Corazon + contador de guardados.
- Explorar: Busca por provincia, ciudad, tipo (casa, apartamento, villa, solar, etc), condicion (venta, alquiler, nueva construccion, planos), rango de precio.
- Mensajes: Chat directo con agentes sobre propiedades. Burbujas de colores diferentes para cada parte. Timestamps en cada mensaje.
- Perfil: Foto de perfil (tap para cambiar), cuenta y seguridad, Face ID/Touch ID, bloqueo automatico, tema claro/oscuro.
- Detalle de propiedad: Fotos en carrusel, precio, ubicacion, mapa, especificaciones (habitaciones, banos, area, parqueos), amenidades, calculadora de hipoteca, planos, agendar visita, contactar agente, compartir.
- Guardar propiedades: Tap el corazon para guardar. Se sincronizan con el servidor.
- Agendar visitas: Calendario con disponibilidad del agente, selecciona fecha y hora, completa datos de contacto.
- Mi Portafolio (agentes): Ver todas tus propiedades publicadas con estadisticas (vistas, tours, favoritos, conversion).
- Mis Agentes (inmobiliarias): Grid de agentes afiliados, tap para ver detalles completos, notas internas, desvincular.
- Seguridad: Face ID/Touch ID para login rapido, bloqueo automatico configurable (1-15 min), cambio de contrasena, verificacion en dos pasos por email.

FUNCIONES DEL SITIO WEB:
- Pagina principal con propiedades destacadas y trending.
- Busqueda avanzada con filtros completos y mapa interactivo.
- Paginas de ciudades con guias de mercado local.
- Blog con articulos sobre bienes raices dominicanos.
- Panel de publicacion: Formulario completo para publicar propiedades con fotos, planos, ubicacion en mapa.
- Dashboard de broker: Pipeline de aplicaciones, analiticas, gestion de disponibilidad, tours.
- Dashboard de inmobiliaria: Gestion de equipo, solicitudes de afiliacion, rendimiento, secretarias.
- Panel de administracion (solo admins): Gestion de propiedades, usuarios, leads, anuncios, newsletter, tours, errores, blog CMS, editor de contenido de paginas.
- Comparador de propiedades: Compara hasta 3 propiedades lado a lado.
- Notificaciones push en navegador.

PIPELINE DE APLICACIONES:
aplicado → en_revision → documentos_requeridos → documentos_enviados → documentos_insuficientes → en_aprobacion → reservado → aprobado → pendiente_pago → pago_enviado → pago_aprobado → completado
(puede terminar en "rechazado" desde cualquier etapa)

DOCUMENTOS TIPICOS: cedula, pasaporte, comprobante de ingresos, estado de cuenta bancario, carta de trabajo, declaracion de impuestos, carta de pre-aprobacion bancaria, prueba de fondos.

MONEDA: Peso Dominicano (RD$) y Dolar Estadounidense (USD). Mercados clave: Santo Domingo (Piantini, Naco, Evaristo Morales, Bella Vista, Los Cacicazgos, Serralles), Santiago, Punta Cana, La Romana, Puerto Plata, Bavaro, Samana, Cap Cana.

INSTRUCCIONES:
- Responde SIEMPRE en espanol.
- Se conciso, practico y directo. Maximo 3-4 parrafos o una lista corta.
- Si el usuario pregunta como hacer algo en la app o el sitio web, dale instrucciones paso a paso claras.
- Si pregunta sobre una funcion que no existe, dile honestamente y sugiere alternativas.
- Adapta tu tono segun el rol: para clientes se amigable y educativo, para agentes se profesional y estrategico.
- Puedes ayudar con: usar la plataforma, buscar propiedades, publicar listados, gestionar aplicaciones, estrategias de venta, documentacion, mercado local, negociacion, seguimiento de clientes, configurar la cuenta, seguridad.
- Si no sabes algo especifico, dilo con honestidad.
- NUNCA inventes funciones que no existen en la plataforma.`;

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
  if (context.brokerName || context.userRole || context.stats) {
    const parts = [];
    if (context.brokerName) parts.push(`Usuario: ${context.brokerName}`);
    if (context.userRole)   parts.push(`Rol: ${context.userRole}`);
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
