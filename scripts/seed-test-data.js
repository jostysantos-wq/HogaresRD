/**
 * Seed script — test accounts + applications for HogaresRD
 * Run: node scripts/seed-test-data.js
 */

require('dotenv').config();
const bcrypt = require('bcryptjs');
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const USERS_FILE = path.join(__dirname, '../data/users.json');
const APPS_FILE  = path.join(__dirname, '../data/applications.json');

// ── Load existing data ────────────────────────────────────────────
let users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
let apps  = JSON.parse(fs.readFileSync(APPS_FILE,  'utf8'));

const INM_ID   = 'usr_inm_demo_001';
const INM_NAME = 'HogaresRD Inmobiliaria Demo';

// ── Password hash (same for all test accounts: Test1234!) ────────
const PASS_HASH = bcrypt.hashSync('Test1234!', 10);

// ── Helpers ───────────────────────────────────────────────────────
function uid(tag) { return `usr_${tag}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`; }
function aid(tag) { return `app_seed_${tag}_${Date.now()}_${Math.random().toString(36).slice(2,6)}`; }
function days(n)  { const d = new Date(); d.setDate(d.getDate() - n); return d.toISOString(); }

function makeEvent(appId, status, daysAgo, label) {
  return {
    id: crypto.randomUUID(), app_id: appId,
    type: 'status_change', description: label,
    actor: 'system', actor_name: 'Sistema',
    data: { from: null, to: status },
    created_at: days(daysAgo),
  };
}

function makeApp({ id, brokerId, brokerName, brokerAgency, brokerEmail, brokerPhone,
                   clientName, clientEmail, clientPhone, clientUserId,
                   listingTitle, listingPrice, status, financing, budget, notes,
                   daysAgo, events }) {
  return {
    id,
    listing_id:    `listing_seed_${id}`,
    listing_title: listingTitle,
    listing_price: String(listingPrice),
    listing_type:  'venta',
    client: { name: clientName, phone: clientPhone, email: clientEmail, user_id: clientUserId },
    broker: { user_id: brokerId, name: brokerName, agency_name: brokerAgency, email: brokerEmail, phone: brokerPhone },
    status,
    status_reason: '',
    financing,
    pre_approved: financing === 'hipoteca' ? true : false,
    budget: String(budget),
    timeline: '3-6 meses',
    intent: 'comprar',
    contact_method: 'whatsapp',
    notes,
    documents_requested: status === 'documentos_requeridos' ? ['cédula','comprobante_ingresos','estado_cuenta'] : [],
    documents_uploaded:  status === 'documentos_enviados'   ? ['cédula','comprobante_ingresos'] : [],
    tours: [],
    payment: { amount: null, currency: 'USD', receipt_path: null, receipt_uploaded_at: null, verification_status: 'none', verified_at: null, verified_by: null, notes: '' },
    timeline_events: events,
    created_at: days(daysAgo + 1),
    updated_at: days(daysAgo),
  };
}

// ── Remove old seed accounts (keep originals) ─────────────────────
const KEEP_IDS = ['usr_broker_demo_001', 'usr_client_demo_001', 'usr_inm_demo_001'];
users = users.filter(u => KEEP_IDS.includes(u.id));
apps  = apps.filter(a => !a.id.startsWith('app_seed_'));

// ── 1. Brokers affiliated with inmobiliaria ────────────────────────
const broker1 = {
  id: 'usr_broker_maria_001', email: 'maria.reyes@hogaresrd.com',
  passwordHash: PASS_HASH, name: 'María Reyes',
  phone: '809-555-0101', createdAt: days(45),
  lastLoginAt: days(1), role: 'broker',
  emailVerified: true, marketingOptIn: false,
  licenseNumber: 'MR-2024-001',
  inmobiliaria_id: INM_ID, inmobiliaria_name: INM_NAME,
  inmobiliaria_join_status: 'approved', inmobiliaria_joined_at: days(40),
  inmobiliaria_pending_id: null, inmobiliaria_pending_name: null,
  join_requests: [], loginAttempts: 0, loginLockedUntil: null,
};

const broker2 = {
  id: 'usr_broker_juan_001', email: 'juan.perez@hogaresrd.com',
  passwordHash: PASS_HASH, name: 'Juan Pérez',
  phone: '809-555-0102', createdAt: days(30),
  lastLoginAt: days(3), role: 'broker',
  emailVerified: true, marketingOptIn: true,
  licenseNumber: 'JP-2024-002',
  inmobiliaria_id: INM_ID, inmobiliaria_name: INM_NAME,
  inmobiliaria_join_status: 'approved', inmobiliaria_joined_at: days(25),
  inmobiliaria_pending_id: null, inmobiliaria_pending_name: null,
  join_requests: [], loginAttempts: 0, loginLockedUntil: null,
};

const broker3 = {
  id: 'usr_broker_sofia_001', email: 'sofia.ramirez@hogaresrd.com',
  passwordHash: PASS_HASH, name: 'Sofía Ramírez',
  phone: '809-555-0103', createdAt: days(20),
  lastLoginAt: days(0), role: 'agency',
  emailVerified: true, marketingOptIn: false,
  licenseNumber: 'SR-2024-003',
  agency: { name: 'Ramírez Realty', license: 'SR-2024-003', phone: '809-555-0103' },
  inmobiliaria_id: INM_ID, inmobiliaria_name: INM_NAME,
  inmobiliaria_join_status: 'approved', inmobiliaria_joined_at: days(15),
  inmobiliaria_pending_id: null, inmobiliaria_pending_name: null,
  join_requests: [], loginAttempts: 0, loginLockedUntil: null,
};

// ── 2. Brokers with PENDING join requests ─────────────────────────
const broker4 = {
  id: 'usr_broker_pedro_001', email: 'pedro.martinez@hogaresrd.com',
  passwordHash: PASS_HASH, name: 'Pedro Martínez',
  phone: '809-555-0104', createdAt: days(10),
  lastLoginAt: null, role: 'broker',
  emailVerified: false, marketingOptIn: false,  // <-- unverified email
  licenseNumber: 'PM-2024-004',
  inmobiliaria_id: null, inmobiliaria_name: null,
  inmobiliaria_join_status: 'pending',
  inmobiliaria_pending_id: INM_ID, inmobiliaria_pending_name: INM_NAME,
  join_requests: [], loginAttempts: 0, loginLockedUntil: null,
};

const broker5 = {
  id: 'usr_broker_ana_001', email: 'ana.garcia@hogaresrd.com',
  passwordHash: PASS_HASH, name: 'Ana García',
  phone: '809-555-0105', createdAt: days(5),
  lastLoginAt: null, role: 'agency',
  emailVerified: true, marketingOptIn: true,
  licenseNumber: 'AG-2024-005',
  agency: { name: 'García Propiedades', license: 'AG-2024-005', phone: '809-555-0105' },
  inmobiliaria_id: null, inmobiliaria_name: null,
  inmobiliaria_join_status: 'pending',
  inmobiliaria_pending_id: INM_ID, inmobiliaria_pending_name: INM_NAME,
  join_requests: [], loginAttempts: 0, loginLockedUntil: null,
};

// ── 3. Update inmobiliaria with join_requests ─────────────────────
const inm = users.find(u => u.id === INM_ID);
if (inm) {
  inm.join_requests = [
    {
      broker_id:    broker4.id, broker_name: broker4.name, broker_email: broker4.email,
      broker_phone: broker4.phone, license: broker4.licenseNumber,
      status: 'pending', requested_at: days(8),
    },
    {
      broker_id:    broker5.id, broker_name: broker5.name, broker_email: broker5.email,
      broker_phone: broker5.phone, license: broker5.licenseNumber,
      status: 'pending', requested_at: days(4),
    },
  ];
}

// ── 4. Applications for affiliated brokers ────────────────────────
const CLIENT = { name: 'Carlos Méndez', email: 'cliente@hogaresrd.com', phone: '809-555-0042', id: 'usr_client_demo_001' };

const newApps = [
  // ─ María Reyes — 4 apps ─
  makeApp({
    id: aid('m1'), brokerId: broker1.id, brokerName: broker1.name,
    brokerAgency: INM_NAME, brokerEmail: broker1.email, brokerPhone: broker1.phone,
    clientName: CLIENT.name, clientEmail: CLIENT.email, clientPhone: CLIENT.phone, clientUserId: CLIENT.id,
    listingTitle: 'Apartamento en Piantini — 3 Hab, Vista Panorámica', listingPrice: 250000,
    status: 'en_aprobacion', financing: 'hipoteca', budget: 270000,
    notes: 'Pre-aprobación bancaria lista. Busco cerrar en 60 días.',
    daysAgo: 5,
    events: [
      makeEvent(aid('m1'), 'aplicado', 18, 'Aplicación recibida'),
      makeEvent(aid('m1'), 'en_revision', 15, 'En revisión'),
      makeEvent(aid('m1'), 'documentos_requeridos', 12, 'Documentos solicitados'),
      makeEvent(aid('m1'), 'documentos_enviados', 8, 'Documentos recibidos'),
      makeEvent(aid('m1'), 'en_aprobacion', 5, 'En proceso de aprobación'),
    ],
  }),
  makeApp({
    id: aid('m2'), brokerId: broker1.id, brokerName: broker1.name,
    brokerAgency: INM_NAME, brokerEmail: broker1.email, brokerPhone: broker1.phone,
    clientName: 'Laura Sánchez', clientEmail: 'laura.s@gmail.com', clientPhone: '809-555-0201', clientUserId: 'guest',
    listingTitle: 'Villa en Casa de Campo — 4 Hab con Piscina', listingPrice: 780000,
    status: 'reservado', financing: 'contado', budget: 800000,
    notes: 'Pago de contado. Ya realizó visita, muy interesada.',
    daysAgo: 2,
    events: [
      makeEvent(aid('m2'), 'aplicado', 22, 'Aplicación recibida'),
      makeEvent(aid('m2'), 'en_revision', 19, 'En revisión'),
      makeEvent(aid('m2'), 'reservado', 2, 'Propiedad reservada'),
    ],
  }),
  makeApp({
    id: aid('m3'), brokerId: broker1.id, brokerName: broker1.name,
    brokerAgency: INM_NAME, brokerEmail: broker1.email, brokerPhone: broker1.phone,
    clientName: 'Roberto Díaz', clientEmail: 'r.diaz@outlook.com', clientPhone: '809-555-0202', clientUserId: 'guest',
    listingTitle: 'Penthouse en Naco — 2 Hab, Terraza Privada', listingPrice: 320000,
    status: 'documentos_requeridos', financing: 'hipoteca', budget: 350000,
    notes: 'Primer apartamento. Necesita orientación sobre el proceso.',
    daysAgo: 10,
    events: [
      makeEvent(aid('m3'), 'aplicado', 14, 'Aplicación recibida'),
      makeEvent(aid('m3'), 'en_revision', 12, 'En revisión'),
      makeEvent(aid('m3'), 'documentos_requeridos', 10, 'Documentos solicitados'),
    ],
  }),
  makeApp({
    id: aid('m4'), brokerId: broker1.id, brokerName: broker1.name,
    brokerAgency: INM_NAME, brokerEmail: broker1.email, brokerPhone: broker1.phone,
    clientName: 'Carmen Vega', clientEmail: 'carmen.v@gmail.com', clientPhone: '809-555-0203', clientUserId: 'guest',
    listingTitle: 'Apartamento en Bella Vista — Remodelado', listingPrice: 145000,
    status: 'completado', financing: 'hipoteca', budget: 160000,
    notes: 'Proceso cerrado exitosamente. Cliente muy satisfecha.',
    daysAgo: 0,
    events: [
      makeEvent(aid('m4'), 'aplicado', 60, 'Aplicación recibida'),
      makeEvent(aid('m4'), 'completado', 0, 'Transacción completada'),
    ],
  }),

  // ─ Juan Pérez — 3 apps ─
  makeApp({
    id: aid('j1'), brokerId: broker2.id, brokerName: broker2.name,
    brokerAgency: INM_NAME, brokerEmail: broker2.email, brokerPhone: broker2.phone,
    clientName: CLIENT.name, clientEmail: CLIENT.email, clientPhone: CLIENT.phone, clientUserId: CLIENT.id,
    listingTitle: 'Proyecto Bávaro Sunrise — 2 Hab Frente al Mar', listingPrice: 195000,
    status: 'aplicado', financing: 'hipoteca', budget: 210000,
    notes: 'Interesado en unidad de planta baja con acceso directo a la piscina.',
    daysAgo: 1,
    events: [ makeEvent(aid('j1'), 'aplicado', 1, 'Aplicación recibida') ],
  }),
  makeApp({
    id: aid('j2'), brokerId: broker2.id, brokerName: broker2.name,
    brokerAgency: INM_NAME, brokerEmail: broker2.email, brokerPhone: broker2.phone,
    clientName: 'Miguel Torres', clientEmail: 'm.torres@yahoo.com', clientPhone: '809-555-0301', clientUserId: 'guest',
    listingTitle: 'Local Comercial en Zona Colonial — Santiago', listingPrice: 85000,
    status: 'pendiente_pago', financing: 'contado', budget: 90000,
    notes: 'Para uso de negocio de gastronomía. Todo aprobado.',
    daysAgo: 3,
    events: [
      makeEvent(aid('j2'), 'aplicado', 25, 'Aplicación recibida'),
      makeEvent(aid('j2'), 'aprobado', 8, 'Aprobado'),
      makeEvent(aid('j2'), 'pendiente_pago', 3, 'Pendiente de pago'),
    ],
  }),
  makeApp({
    id: aid('j3'), brokerId: broker2.id, brokerName: broker2.name,
    brokerAgency: INM_NAME, brokerEmail: broker2.email, brokerPhone: broker2.phone,
    clientName: 'Isabel Mora', clientEmail: 'isabel.m@gmail.com', clientPhone: '809-555-0302', clientUserId: 'guest',
    listingTitle: 'Casa en Los Cacicazgos — 5 Hab, Jardín', listingPrice: 620000,
    status: 'rechazado', financing: 'hipoteca', budget: 600000,
    notes: 'Rechazado por documentación insuficiente de ingresos.',
    daysAgo: 7,
    events: [
      makeEvent(aid('j3'), 'aplicado', 20, 'Aplicación recibida'),
      makeEvent(aid('j3'), 'rechazado', 7, 'Solicitud rechazada — documentación insuficiente'),
    ],
  }),

  // ─ Sofía Ramírez — 3 apps ─
  makeApp({
    id: aid('s1'), brokerId: broker3.id, brokerName: broker3.name,
    brokerAgency: 'Ramírez Realty', brokerEmail: broker3.email, brokerPhone: broker3.phone,
    clientName: 'Andrés Luna', clientEmail: 'andres.luna@gmail.com', clientPhone: '809-555-0401', clientUserId: 'guest',
    listingTitle: 'Torre Serralles — Piso 12, 3 Hab', listingPrice: 410000,
    status: 'pago_enviado', financing: 'hipoteca', budget: 430000,
    notes: 'Pago inicial enviado. En espera de confirmación.',
    daysAgo: 1,
    events: [
      makeEvent(aid('s1'), 'aplicado', 35, 'Aplicación recibida'),
      makeEvent(aid('s1'), 'aprobado', 10, 'Aprobado'),
      makeEvent(aid('s1'), 'pendiente_pago', 5, 'Pendiente de pago'),
      makeEvent(aid('s1'), 'pago_enviado', 1, 'Pago enviado por cliente'),
    ],
  }),
  makeApp({
    id: aid('s2'), brokerId: broker3.id, brokerName: broker3.name,
    brokerAgency: 'Ramírez Realty', brokerEmail: broker3.email, brokerPhone: broker3.phone,
    clientName: 'Patricia Ruiz', clientEmail: 'p.ruiz@hotmail.com', clientPhone: '809-555-0402', clientUserId: 'guest',
    listingTitle: 'Apartamento en Evaristo Morales — Reformado', listingPrice: 175000,
    status: 'documentos_enviados', financing: 'hipoteca', budget: 185000,
    notes: 'Documentos subidos. Pendiente revisión del banco.',
    daysAgo: 4,
    events: [
      makeEvent(aid('s2'), 'aplicado', 16, 'Aplicación recibida'),
      makeEvent(aid('s2'), 'en_revision', 14, 'En revisión'),
      makeEvent(aid('s2'), 'documentos_requeridos', 10, 'Documentos solicitados'),
      makeEvent(aid('s2'), 'documentos_enviados', 4, 'Documentos recibidos'),
    ],
  }),
  makeApp({
    id: aid('s3'), brokerId: broker3.id, brokerName: broker3.name,
    brokerAgency: 'Ramírez Realty', brokerEmail: broker3.email, brokerPhone: broker3.phone,
    clientName: 'Héctor Vargas', clientEmail: 'h.vargas@gmail.com', clientPhone: '809-555-0403', clientUserId: 'guest',
    listingTitle: 'Villa en Punta Cana — Proyecto Nuevo, 3 Hab', listingPrice: 290000,
    status: 'en_revision', financing: 'contado', budget: 310000,
    notes: 'Cliente extranjero, pago en USD. Todo en orden.',
    daysAgo: 6,
    events: [
      makeEvent(aid('s3'), 'aplicado', 9, 'Aplicación recibida'),
      makeEvent(aid('s3'), 'en_revision', 6, 'En revisión'),
    ],
  }),
];

// ── 5. Merge & save ───────────────────────────────────────────────
users.push(broker1, broker2, broker3, broker4, broker5);
apps.push(...newApps);

fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
fs.writeFileSync(APPS_FILE,  JSON.stringify(apps,  null, 2));

console.log('✅ Seed complete!');
console.log(`   Users: ${users.length} total (added 5 brokers)`);
console.log(`   Apps:  ${apps.length} total (added ${newApps.length} applications)`);
console.log('');
console.log('📋 Test accounts (password: Test1234! for all)');
console.log('   inmobiliaria@hogaresrd.com  → Inmobiliaria (sees all team + apps)');
console.log('   maria.reyes@hogaresrd.com   → Broker afiliada, 4 apps');
console.log('   juan.perez@hogaresrd.com    → Broker afiliado, 3 apps');
console.log('   sofia.ramirez@hogaresrd.com → Agency afiliada, 3 apps');
console.log('   pedro.martinez@hogaresrd.com→ Broker con solicitud pendiente, email SIN verificar');
console.log('   ana.garcia@hogaresrd.com    → Agency con solicitud pendiente');
console.log('   broker@hogaresrd.com        → Demo broker original, 9 apps (pass: Demo1234 — existing)');
