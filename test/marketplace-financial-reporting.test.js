const assert = require('node:assert/strict');
const test = require('node:test');

const MarketplaceFinancialService = require('../app/services/MarketplaceFinancialService');
const MarketplaceReportingService = require('../app/services/MarketplaceReportingService');

test('ganancia estimada usa ingreso neto, comisión, envío, otros cargos y costo producto', () => {
  const row = MarketplaceFinancialService.normalizeRow({
    order_id: 1,
    net_revenue: 17990,
    commission: 2339,
    shipping: 3250,
    other_charges: 0,
    product_cost: 0
  });

  assert.equal(row.revenue, 17990);
  assert.equal(row.commission, 2339);
  assert.equal(row.shipping, 3250);
  assert.equal(row.estimatedProfit, 12401);
  assert.equal(row.margin, 68.93);
});

test('el costo producto ausente queda en cero para ventas externas', () => {
  const row = MarketplaceFinancialService.normalizeRow({
    order_id: 2,
    net_revenue: 17990,
    commission: 2339,
    shipping: 3250,
    other_charges: 0,
    product_cost: null
  });

  assert.equal(row.productCost, 0);
  assert.equal(row.estimatedProfit, 12401);
});

test('otros cargos se restan con su signo financiero normalizado', () => {
  const row = MarketplaceFinancialService.normalizeRow({
    order_id: 3,
    net_revenue: 100,
    commission: 10,
    shipping: 5,
    other_charges: 3,
    product_cost: 20
  });

  assert.equal(row.estimatedProfit, 62);
  assert.equal(row.margin, 62);
});

test('el costo de envío con cero almacenado usa el seller_cost normalizado del payload', () => {
  const query = MarketplaceFinancialService.buildNormalizedFinancialCtes();

  assert.match(query, /NULLIF\(o\.shipping_total, 0\)/);
  assert.match(query, /shipping_financials\.seller_cost/);
});

test('los tipos de cargos visibles siempre se traducen al español', () => {
  const label = MarketplaceReportingService._getFinancialFeeLabel;

  assert.equal(label('commission'), 'Comisión');
  assert.equal(label('shipping_fee'), 'Envío vendedor');
  assert.equal(label('other_charge'), 'Otros cargos');
  assert.equal(label('tipo_desconocido'), 'Otros cargos');
});

test('la interpolación del filtro conserva los JSON paths de la consulta financiera', () => {
  const { whereClause } = MarketplaceFinancialService.buildOrderConditions({
    from: '2026-09-09',
    to: '2026-09-10',
    company_id: 1
  });
  const query = MarketplaceFinancialService
    .buildNormalizedFinancialCtes()
    .replace('{{WHERE_CLAUSE}}', () => whereClause);

  assert.equal((query.match(/JSON PATH '\$'/g) || []).length, 3);
  assert.doesNotMatch(query, /JSON PATH '\s/);
});
