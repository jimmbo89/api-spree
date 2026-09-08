const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const sourceLot = {
    id: 132, variant_id: 103, warehouse_product_id: 80,
    price: 25000, purchase_price: 15000, promotional_price: null, stock: 5
  };
  const destinationLot = {
    id: 142, variant_id: 103, warehouse_product_id: 81,
    price: 45000, purchase_price: 40000, promotional_price: null, stock: 5
  };
  const warehouses = new Map([
    [26, { id: 26, company_id: 24, branch_id: 1, code: 'ORIGEN', name: 'Origen' }],
    [27, { id: 27, company_id: 24, branch_id: 1, code: 'DESTINO', name: 'Destino' }]
  ]);
  const warehouseProducts = new Map([
    [26, { id: 80, product_id: 15, warehouse_id: 26, company_id: 24 }],
    [27, { id: 81, product_id: 15, warehouse_id: 27, company_id: 24 }]
  ]);
  const calls = {
    writes: 0,
    creates: 0,
    rollback: 0,
    commit: 0,
    movements: [],
    auditEvents: []
  };
  const transaction = {
    rollback: async () => { calls.rollback++; },
    commit: async () => { calls.commit++; }
  };
  const product = { id: 15, sku: 'PRODUCT-15', name: 'Producto 15' };

  const findLot = (id) => [sourceLot, destinationLot].find((lot) => Number(lot.id) === Number(id));
  const warehouseProductFor = (warehouseId) => warehouseProducts.get(Number(warehouseId));
  const repositories = {
    WarehouseRepository: { findById: async (id) => warehouses.get(Number(id)) },
    ProductRepository: { findById: async () => product },
    WarehouseProductRepository: {
      findByWarehouseAndProduct: async (warehouseId) => warehouseProductFor(warehouseId),
      isProductAssociatedWithCompany: async () => true
    },
    WarehouseProductVariantRepository: {
      findByWarehouseProductId: async (warehouseProductId) =>
        Number(warehouseProductId) === 80 ? [sourceLot] : [destinationLot],
      findAllLotsByVariantAndWarehouse: async (variantId, warehouseProductId) => {
        if (Number(variantId) !== 103) return [];
        return Number(warehouseProductId) === 80 ? [sourceLot] : [destinationLot];
      },
      getTotalStockByVariantAndWarehouse: async (variantId, warehouseProductId) => ({
        total_stock: Number(variantId) === 103
          ? (Number(warehouseProductId) === 80 ? sourceLot.stock : destinationLot.stock)
          : 0
      }),
      findLotById: async (id) => findLot(id),
      update: async (record, data) => {
        calls.writes++;
        Object.assign(record, data);
      },
      create: async () => {
        calls.creates++;
        throw new Error('No debe crear una asociación para una variante existente');
      }
    },
    InventoryMovementRepository: {
      create: async (movement) => {
        calls.writes++;
        const persistedMovement = { ...movement, id: calls.movements.length + 1 };
        calls.movements.push(persistedMovement);
        return persistedMovement;
      },
      findByReferenceId: async () => calls.movements
    },
    LogRepository: { create: async () => {} },
    CompanyRepository: { findById: async () => ({ plan: { max_products: -1 } }) },
    UserRepository: {},
    BranchRepository: {},
    VariantDefinitionRepository: {},
    VariantValueRepository: {},
    ProductVariantValueRepository: {}
  };
  const models = {
    sequelize: { transaction: async () => transaction },
    WarehouseProductVariant: {
      findAll: async ({ where }) =>
        Number(where.warehouse_product_id) === 81 && Number(where.variant_id) === 103
          ? [destinationLot]
          : []
    }
  };
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === '../repositories') return repositories;
      if (name === '../models') return models;
      if (name === 'sequelize') return { Op: {} };
      if (name === 'uuid') return { v4: () => 'transfer-reference' };
      if (name.includes('logger')) return { info() {}, error() {} };
      if (name.includes('requestUtil')) return { getRequestMetadata: () => ({ user_id: 1 }) };
      if (name.includes('context')) return { getUserId: () => 1 };
      if (name.includes('AuditEventService')) {
        return { safeRecordFromRequest: async (_req, payload) => { calls.auditEvents.push(payload); } };
      }
      if (name.includes('auditUtils')) return { detectChanges: () => [] };
      return {};
    }
  };
  const source = fs.readFileSync(
    path.join(__dirname, '../app/controllers/WarehouseProductController.js'),
    'utf8'
  );
  vm.runInNewContext(source, context);
  return { controller: context.module.exports, sourceLot, destinationLot, calls };
}

async function invoke(endpoint, h) {
  const variant = {
    variant_id: 103,
    warehouse_product_variant_id: 132,
    lot_id: 132,
    quantity: 1,
    price: 30000,
    purchase_price: 20000,
    promotional_price: null,
    confirm_price_change: true
  };
  const body = {
    movement_type: 'transfer',
    origin_warehouse_id: 26,
    destination_warehouse_id: 27,
    reason: 'Transferencia de prueba',
    notes: 'Actualiza la opción existente',
    ...(endpoint === 'createMovement'
      ? { product_id: 15, variants: [variant] }
      : { products: [{ product_id: 15, variants: [variant] }] })
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };
  await h.controller[endpoint]({ body, user: { id: 1 } }, res);
  return res;
}

for (const endpoint of ['createMovement', 'createBulkMovement']) {
  test(`${endpoint}: confirmación actualiza la asociación destino y audita precios reales`, async () => {
    const h = harness();
    const res = await invoke(endpoint, h);

    assert.equal(res.statusCode, 200);
    assert.equal(h.calls.creates, 0);
    assert.equal(h.calls.commit, 1);
    assert.equal(h.calls.rollback, 0);
    assert.equal(h.destinationLot.stock, 6);
    assert.equal(h.destinationLot.price, 30000);
    assert.equal(h.destinationLot.purchase_price, 20000);
    assert.equal(h.destinationLot.promotional_price, null);

    const entry = h.calls.movements.find((movement) => movement.movement_type === 'transfer_entry');
    assert.deepEqual(JSON.parse(JSON.stringify(entry.meta.price_changes)), [
      { field: 'price', old_value: 45000, new_value: 30000 },
      { field: 'purchase_price', old_value: 40000, new_value: 20000 }
    ]);

    const audit = h.calls.auditEvents.find((event) => event.related_resource_id === entry.id);
    assert.ok(audit);
    assert.deepEqual(JSON.parse(JSON.stringify(audit.changes)), [
      { field: 'stock', old_value: 5, new_value: 6 },
      { field: 'price', old_value: 45000, new_value: 30000 },
      { field: 'purchase_price', old_value: 40000, new_value: 20000 }
    ]);
  });
}
