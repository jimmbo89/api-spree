const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { normalizeMarketplaceIdentifier } = require('../app/util/marketplaceUtil');

function loadServiceInternals() {
  const servicePath = path.resolve(__dirname, '../app/services/MarketplaceOrderSyncService.js');
  const source = `${fs.readFileSync(servicePath, 'utf8')}\nmodule.exports.__internals = { buildMercadoLibreCustomerSnapshot, resolveMercadoLibreMessagesSnapshot, summarizeMercadoLibreMessagesSync };\n`;
  const serviceModule = new Module(servicePath, module);

  serviceModule.filename = servicePath;
  serviceModule.paths = Module._nodeModulePaths(path.dirname(servicePath));
  serviceModule._compile(source, servicePath);

  return serviceModule.exports.__internals;
}

const {
  buildMercadoLibreCustomerSnapshot,
  resolveMercadoLibreMessagesSnapshot,
  summarizeMercadoLibreMessagesSync
} = loadServiceInternals();

test('normaliza ciudad, region y pais de objetos de direccion de Mercado Libre', () => {
  const snapshot = buildMercadoLibreCustomerSnapshot({
    order: { buyer: { id: 123 } },
    shipment: {
      receiver_address: {
        city: { id: 'TUxDQ1NBTjM', name: 'Santiago' },
        state: { id: 'CL-RM', name: 'Región Metropolitana' },
        country: { id: 'CL', name: 'Chile' }
      }
    },
    billingInfo: null
  });

  assert.equal(snapshot.shipping_city, 'Santiago');
  assert.equal(snapshot.shipping_state, 'Región Metropolitana');
  assert.equal(snapshot.shipping_country, 'Chile');
});

test('conserva compatibilidad con direcciones de Mercado Libre expresadas como texto', () => {
  const snapshot = buildMercadoLibreCustomerSnapshot({
    order: { buyer: { id: 123 } },
    shipment: {
      receiver_address: {
        city: 'Santiago',
        state: 'Región Metropolitana',
        country: 'Chile'
      }
    },
    billingInfo: null
  });

  assert.equal(snapshot.shipping_city, 'Santiago');
  assert.equal(snapshot.shipping_state, 'Región Metropolitana');
  assert.equal(snapshot.shipping_country, 'Chile');
});

test('expande pack_id en notacion cientifica sin convertirlo a Number', () => {
  assert.equal(
    normalizeMarketplaceIdentifier('2.000015794431845e15'),
    '2000015794431845'
  );
  assert.equal(normalizeMarketplaceIdentifier('PACK-123'), 'PACK-123');
});

test('conserva mensajes anteriores cuando la consulta remota no estuvo disponible', () => {
  const previous = [{ message_id: 'anterior', text: 'Mensaje guardado' }];

  assert.strictEqual(resolveMercadoLibreMessagesSnapshot(previous, null), previous);
  assert.deepEqual(summarizeMercadoLibreMessagesSync(null), {
    status: 'unavailable',
    preserved_previous_snapshot: true
  });
});

test('reemplaza el snapshot y reporta metadatos ante una respuesta valida de mensajes', () => {
  const response = {
    paging: { total: 1 },
    conversation_status: { status: 'active' },
    seller_max_message_length: 350,
    buyer_max_message_length: 3500,
    messages: [{ id: 'nuevo', text: 'Mensaje nuevo' }]
  };

  const snapshot = resolveMercadoLibreMessagesSnapshot([], response);
  const summary = summarizeMercadoLibreMessagesSync(response);

  assert.equal(snapshot.length, 1);
  assert.equal(snapshot[0].message_id, 'nuevo');
  assert.equal(summary.status, 'synchronized');
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.conversation_status, { status: 'active' });
  assert.equal(summary.seller_max_message_length, 350);
});

test('conserva mensajes no incluidos cuando Mercado Libre devuelve una pagina parcial', () => {
  const previous = [{ message_id: 'anterior', text: 'Mensaje de otra pagina' }];
  const response = {
    paging: { total: 2 },
    messages: [{ id: 'nuevo', text: 'Mensaje de esta pagina' }]
  };

  const snapshot = resolveMercadoLibreMessagesSnapshot(previous, response);
  const summary = summarizeMercadoLibreMessagesSync(response);

  assert.deepEqual(snapshot.map((message) => message.message_id).sort(), ['anterior', 'nuevo']);
  assert.equal(summary.status, 'partial');
  assert.equal(summary.preserved_previous_snapshot, true);
  assert.equal(summary.received_count, 1);
  assert.equal(summary.total, 2);
});
