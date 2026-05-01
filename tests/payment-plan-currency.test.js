/**
 * POST /api/applications/:id/payment-plan currency whitelist regression.
 *
 * Wave 5-C added VALID_CURRENCIES = ['DOP','USD'] and applied it at
 * /:id/payment/upload + /:id/payment-plan/:iid/upload but NOT at the
 * plan-creation endpoint. This test pins the gap fix.
 */

process.env.JWT_SECRET   = 'test-secret';
process.env.ADMIN_KEY    = 'test-admin-key';
process.env.NODE_ENV     = 'test';
process.env.DATABASE_URL = '';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const {
  request, post, auth, makeBroker, makeListing, makeApplication,
  startServer, stopServer,
} = require('./_app-helpers');
const store = require('../routes/store');

let broker;

function freshApp() {
  const listing = makeListing(broker);
  const app = makeApplication(listing, broker, {
    status: 'aprobado',
    broker: { user_id: broker.id, name: 'B', email: broker.email, agency_name: '', phone: '' },
  });
  store.saveApplication(app);
  return app;
}

describe('POST /:id/payment-plan currency whitelist', () => {
  before(async () => {
    await startServer();
    broker = await makeBroker('plan-currency-broker');
  });

  after(async () => { await stopServer(); });

  it('rejects non-DOP/USD currency with 400', async () => {
    const app = freshApp();
    const r = await post(`/api/applications/${app.id}/payment-plan`, {
      payment_method: 'transfer',
      currency: 'BTC',
      installments: [{ amount: 1000, label: 'Cuota 1' }],
    }, auth(broker.token));
    assert.equal(r.status, 400);
    assert.match(r.body.error, /Moneda inválida/i);
  });

  it('accepts DOP and persists uppercase', async () => {
    const app = freshApp();
    const r = await post(`/api/applications/${app.id}/payment-plan`, {
      payment_method: 'transfer',
      currency: 'dop',
      installments: [{ amount: 1000, label: 'Cuota 1' }],
    }, auth(broker.token));
    assert.equal(r.status, 200, `expected 200 got ${r.status} ${JSON.stringify(r.body)}`);
    const persisted = store.getApplicationById(app.id);
    assert.equal(persisted.payment_plan.currency, 'DOP');
  });

  it('accepts USD (case-insensitive)', async () => {
    const app = freshApp();
    const r = await post(`/api/applications/${app.id}/payment-plan`, {
      payment_method: 'transfer',
      currency: 'usd',
      installments: [{ amount: 100, label: 'Cuota 1' }],
    }, auth(broker.token));
    assert.equal(r.status, 200, `expected 200 got ${r.status} ${JSON.stringify(r.body)}`);
    const persisted = store.getApplicationById(app.id);
    assert.equal(persisted.payment_plan.currency, 'USD');
  });

  it('defaults to DOP when currency omitted', async () => {
    const app = freshApp();
    const r = await post(`/api/applications/${app.id}/payment-plan`, {
      payment_method: 'transfer',
      installments: [{ amount: 100, label: 'Cuota 1' }],
    }, auth(broker.token));
    assert.equal(r.status, 200, `expected 200 got ${r.status} ${JSON.stringify(r.body)}`);
    const persisted = store.getApplicationById(app.id);
    assert.equal(persisted.payment_plan.currency, 'DOP');
  });
});
