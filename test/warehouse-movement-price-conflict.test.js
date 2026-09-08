const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const lot = { id: 142, variant_id: 111, warehouse_product_id: 81,
    price: 42000, purchase_price: 38000, promotional_price: null, stock: 5 };
  const calls = { writes: 0, rollback: 0, commit: 0 };
  const transaction = {
    rollback: async () => { calls.rollback++; },
    commit: async () => { calls.commit++; }
  };
  const warehouse = { id: 27, company_id: 24 };
  const product = { id: 15, sku: '89250329' };
  const wp = { id: 81, product_id: 15, warehouse_id: 27 };
  const repositories = {
    WarehouseRepository: { findById: async () => warehouse },
    ProductRepository: { findById: async (id) => ({ ...product, id: Number(id) || product.id }) },
    WarehouseProductRepository: {
      findByWarehouseAndProduct: async () => wp,
      isProductAssociatedWithCompany: async () => true
    },
    WarehouseProductVariantRepository: {
      findByWarehouseProductId: async () => [lot],
      getTotalStockByVariantAndWarehouse: async () => ({ total_stock: lot.stock }),
      update: async (record, data) => { calls.writes++; Object.assign(record, data); },
      create: async () => { throw new Error('Unexpected new association'); },
      findMatchingLotByVariantAndWarehouse: async () => lot
    },
    InventoryMovementRepository: {
      create: async () => { calls.writes++; },
      findByReferenceId: async () => []
    },
    LogRepository: { create: async () => {} }
  };
  const models = {
    sequelize: { transaction: async () => transaction },
    WarehouseProductVariant: { findAll: async () => [lot] }
  };
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === '../repositories') return repositories;
      if (name === '../models') return models;
      if (name === 'sequelize') return { Op: {} };
      if (name === 'uuid') return { v4: () => 'test-reference' };
      if (name.includes('logger')) return { info() {}, error() {} };
      if (name.includes('requestUtil')) return { getRequestMetadata: () => ({ user_id: 1 }) };
      return {};
    }
  };
  const source = fs.readFileSync(path.join(__dirname, '../app/controllers/WarehouseProductController.js'), 'utf8');
  vm.runInNewContext(source, context);
  return { controller: context.module.exports, lot, calls };
}

for (const endpoint of ['createMovement', 'createBulkMovement']) {
  async function invoke(h, variant) {
    const body = { movement_type: 'entry', origin_warehouse_id: 27, reason: 'Test' };
    if (endpoint === 'createMovement') Object.assign(body, { product_id: 15, variants: [variant] });
    else body.products = [{ product_id: 15, variants: [variant] }];
    const res = { status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await h.controller[endpoint]({ body, user: { id: 1 } }, res);
    return res;
  }
  const base = { variant_id: 111, warehouse_product_variant_id: 142, lot_id: 142,
    quantity: 1, local_sku: '89250329', price: 42000, purchase_price: 38000, promotional_price: null };

  for (const changes of [ { price: 45000 }, { purchase_price: 40000 },
    { promotional_price: 0 }, { price: 45000, purchase_price: 40000 }, { purchase_price: null } ]) {
    test(`${endpoint}: 409 with existing ID for ${JSON.stringify(changes)}`, async () => {
      const h = harness();
      const res = await invoke(h, { ...base, ...changes });
      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'PRODUCT_OPTION_PRICE_CONFLICT');
      assert.deepEqual(Array.from(res.body.changed_fields), Object.keys(changes));
      assert.equal(res.body.option.warehouse_product_variant_id, 142);
      assert.equal(res.body.option.current_price, 42000);
      assert.equal(res.body.option.current_purchase_price, 38000);
      assert.equal(res.body.option.current_promotional_price, null);
      for (const field of ['price', 'purchase_price', 'promotional_price']) {
        assert.equal(res.body.requested[field], ({ ...base, ...changes })[field]);
      }
      assert.equal(h.calls.writes, 0);
      assert.equal(h.calls.rollback, 1);
    });
  }
  test(`${endpoint}: explicit confirmation updates same lot and adds stock once`, async () => {
    const h = harness();
    const res = await invoke(h, { ...base, price: 45000, purchase_price: 0, confirm_price_change: true });
    assert.equal(res.statusCode, 200);
    assert.equal(h.lot.price, 45000);
    assert.equal(h.lot.purchase_price, 0);
    assert.equal(h.lot.stock, 6);
    assert.equal(h.calls.writes, 2);
    assert.equal(h.calls.commit, 1);
  });
  test(`${endpoint}: confirmation requires boolean true and existing association ID`, async () => {
    for (const extra of [
      { confirm_price_change: false },
      { confirm_price_change: 'true' },
      { confirm_price_change: true, warehouse_product_variant_id: null }
    ]) {
      const h = harness();
      const res = await invoke(h, { ...base, price: 45000, ...extra });
      assert.equal(res.statusCode, 409);
      assert.equal(h.calls.writes, 0);
    }
  });
  test(`${endpoint}: unchanged and omitted prices allow stock entry`, async () => {
    const h = harness();
    const res = await invoke(h, { variant_id: 111, warehouse_product_variant_id: 142, quantity: 1 });
    assert.equal(res.statusCode, 200);
    assert.equal(h.lot.price, 42000);
    assert.equal(h.lot.purchase_price, 38000);
    assert.equal(h.lot.stock, 6);
  });

  if (endpoint === 'createBulkMovement') {
    test('createBulkMovement: returns every price conflict across products', async () => {
      const h = harness();
      const body = {
        movement_type: 'entry',
        origin_warehouse_id: 27,
        reason: 'Test',
        products: [
          { product_id: 15, variants: [{ ...base, price: 45000 }] },
          { product_id: 16, variants: [{ ...base, price: 46000 }] }
        ]
      };
      const res = {
        status(code) { this.statusCode = code; return this; },
        json(data) { this.body = data; return this; }
      };
      await h.controller.createBulkMovement({ body, user: { id: 1 } }, res);

      assert.equal(res.statusCode, 409);
      assert.equal(res.body.code, 'PRODUCT_OPTION_PRICE_CONFLICT');
      assert.equal(res.body.conflicts.length, 2);
      assert.equal(Array.from(res.body.conflicts, (item) => item.option.product_id).join(','), '15,16');
      assert.equal(Array.from(res.body.conflicts, (item) => item.requested.price).join(','), '45000,46000');
      assert.equal(h.calls.writes, 0);
      assert.equal(h.calls.rollback, 1);
    });
  }
}
