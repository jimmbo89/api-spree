const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const MarketplaceWebhookController = require('../app/controllers/MarketplaceWebhookController');

const helpers = MarketplaceWebhookController;

function buildOrderResponse(overrides = {}) {
  return {
    SuccessResponse: {
      Body: {
        Orders: {
          Order: {
            OrderId: 190,
            PaymentMethod: 'ecommPay',
            CreatedAt: '2026-09-08 12:00:00',
            ItemsCount: 1,
            ShippingType: 'Dropshipping',
            GrandTotal: '19421',
            Statuses: { Status: 'ready_to_ship' },
            AddressShipping: {
              Address1: 'Avenida Siempre Viva',
              City: 'Santiago',
              Region: 'Metropolitana'
            },
            ...overrides
          }
        }
      }
    }
  };
}

function buildOrderItemsResponse(overrides = {}) {
  return {
    SuccessResponse: {
      Body: {
        OrderItems: {
          OrderItem: {
            OrderItemId: '2',
            OrderId: '190',
            Name: 'Producto de prueba',
            Sku: 'SKU-190',
            ShippingType: 'Dropshipping',
            Status: 'ready_to_ship',
            ItemPrice: '4000',
            PaidPrice: '3521',
            TaxAmount: '0',
            ShippingAmount: '15900',
            VoucherAmount: '479',
            ...overrides
          }
        }
      }
    }
  };
}

test('Falabella webhook oficial conserva OrderId y estado de items', () => {
  const payload = helpers._buildFalabellaAsyncPayload({
    event: 'onOrderItemsStatusChanged',
    payload: {
      OrderId: 190,
      OrderItemIds: [3, 2],
      NewStatus: 'ready_to_ship'
    }
  });

  assert.equal(payload.OrderId, 190);
  assert.deepEqual(payload.payload.OrderItemIds, [3, 2]);
  assert.equal(payload.payload.NewStatus, 'ready_to_ship');
});

test('Falabella usa GetOrderItems y calcula el total oficial PaidPrice + ShippingAmount', () => {
  const order = buildOrderResponse();
  const items = buildOrderItemsResponse();

  const parsedItems = helpers._parseFalabellaOrderItems(order, items);
  const parsedOrder = helpers._parseFalabellaOrderInfo(order, items);

  assert.equal(parsedItems.length, 1);
  assert.equal(parsedItems[0].marketplaceItemId, '2');
  assert.equal(parsedItems[0].sku, 'SKU-190');
  assert.equal(parsedItems[0].quantity, 1);
  assert.equal(parsedItems[0].unitPrice, 3521);
  assert.equal(parsedItems[0].totalPrice, 3521);
  assert.equal(parsedItems[0].shippingFee, 15900);
  assert.equal(parsedOrder.subtotal, 3521);
  assert.equal(parsedOrder.shippingTotal, 15900);
  assert.equal(parsedOrder.totalAmount, 19421);
  assert.equal(parsedOrder.status, 'ready_to_ship');
  assert.equal(parsedOrder.shippingType, 'Dropshipping');
});

test('Falabella normaliza estados oficiales canceled y ready_to_ship', () => {
  assert.equal(helpers._mapFalabellaOrderStatus('ready_to_ship'), 'confirmed');
  assert.equal(helpers._mapFalabellaOrderStatus('canceled'), 'cancelled');
});

test('Falabella conserva la orden externa y solo marca gestionables los ítems vinculados', () => {
  assert.deepEqual(
    helpers._getFalabellaOrderManagement([null, { product_id: 10 }]),
    { managedBySpree: false, managedItemCount: 1 }
  );
  assert.deepEqual(
    helpers._getFalabellaOrderManagement([{ product_id: 10 }, { product_id: 11 }]),
    { managedBySpree: true, managedItemCount: 2 }
  );
});

test('Falabella genera una identidad estable para reintentos del mismo webhook oficial', () => {
  const first = {
    event: 'onOrderItemsStatusChanged',
    payload: { OrderId: 190, OrderItemIds: [2, 3], NewStatus: 'ready_to_ship' }
  };
  const retry = {
    event: 'onOrderItemsStatusChanged',
    payload: { OrderId: 190, OrderItemIds: [3, 2], NewStatus: 'ready_to_ship' }
  };
  const changed = {
    event: 'onOrderItemsStatusChanged',
    payload: { OrderId: 190, OrderItemIds: [2, 3], NewStatus: 'shipped' }
  };

  assert.equal(
    helpers._buildFalabellaEventId(first, 'orders/190', first.event),
    helpers._buildFalabellaEventId(retry, 'orders/190', retry.event)
  );
  assert.notEqual(
    helpers._buildFalabellaEventId(first, 'orders/190', first.event),
    helpers._buildFalabellaEventId(changed, 'orders/190', changed.event)
  );
});

test('Falabella consulta GetOrderItems con la versión oficial 1.0', async () => {
  const originalGet = axios.get;
  let capturedUrl = null;

  axios.get = async (url) => {
    capturedUrl = url;
    return { data: buildOrderItemsResponse() };
  };

  try {
    const response = await helpers._fetchFalabellaOrderItems(
      190,
      { seller_email: 'seller@example.com', api_key: 'secret-key' }
    );
    const params = new URL(capturedUrl).searchParams;

    assert.ok(response.SuccessResponse);
    assert.equal(params.get('Action'), 'GetOrderItems');
    assert.equal(params.get('Version'), '1.0');
    assert.equal(params.get('OrderId'), '190');
    assert.ok(params.get('Signature'));
  } finally {
    axios.get = originalGet;
  }
});
