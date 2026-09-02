const test = require('node:test');
const assert = require('node:assert/strict');

const MarketplaceReportingService = require('../app/services/MarketplaceReportingService');

test('venta externa: informa que no descuenta stock en Spree', () => {
  assert.deepEqual(
    MarketplaceReportingService._buildStockDisplay({
      items: [{ product_id: null, inventory_movement_id: null }]
    }),
    {
      descuentaStockEnSpree: false,
      mensajeStock: 'Esta venta no descuenta stock en Spree'
    }
  );
});

test('venta gestionada por Spree: no muestra advertencia de stock', () => {
  assert.deepEqual(
    MarketplaceReportingService._buildStockDisplay({
      items: [{ product_id: 12, inventory_movement_id: 34 }]
    }),
    {
      descuentaStockEnSpree: true,
      mensajeStock: null
    }
  );
});
