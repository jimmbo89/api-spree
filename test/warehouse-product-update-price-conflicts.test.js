const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function harness() {
  const option = {
    id: 180,
    variant_id: 139,
    price: 25000,
    purchase_price: 20000,
    promotional_price: null,
    stock: 4,
    active: true,
    published: false
  };
  const record = {
    id: 84,
    product_id: 37,
    warehouse_id: 31,
    company_id: 17,
    branch_id: 1,
    active: true
  };
  const warehouse = { id: 31, company_id: 17, branch_id: 1, code: 'WH-31', name: 'Almacén' };
  const product = { id: 37, company_id: 17, sku: 'BAND-CUBA', name: 'Banda Cuba' };
  const calls = { rollback: 0, commit: 0, variantUpdates: 0 };
  const transaction = {
    rollback: async () => { calls.rollback++; },
    commit: async () => { calls.commit++; }
  };
  const repositories = {
    WarehouseRepository: { findById: async () => warehouse },
    ProductRepository: { findById: async () => product },
    ProductVariantRepository: { findByProductId: async () => [{ id: 139, sku: 'BAND-CUBA-001' }] },
    WarehouseProductRepository: {
      findById: async () => record,
      update: async () => record,
      findFiltered: async () => []
    },
    WarehouseProductVariantRepository: {
      findByWarehouseProductId: async () => [option],
      update: async () => { calls.variantUpdates++; },
      create: async () => { throw new Error('No debe crear una asociación ante conflictos'); }
    },
    InventoryMovementRepository: { create: async () => {} },
    LogRepository: { create: async () => {} }
  };
  const models = {
    sequelize: { transaction: async () => transaction }
  };
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === '../repositories') return repositories;
      if (name === '../models') return models;
      if (name === 'sequelize') return { Op: {} };
      if (name === 'uuid') return { v4: () => 'update-reference' };
      if (name.includes('logger')) return { info() {}, error() {} };
      if (name.includes('requestUtil')) return { getRequestMetadata: () => ({ user_id: 1 }) };
      if (name.includes('context')) return { getUserId: () => 1 };
      if (name.includes('AuditEventService')) return { safeRecordFromRequest: async () => {} };
      if (name.includes('auditUtils')) return { detectChanges: () => [] };
      return {};
    }
  };
  const source = fs.readFileSync(
    path.join(__dirname, '../app/controllers/WarehouseProductController.js'),
    'utf8'
  );
  vm.runInNewContext(source, context);
  return { controller: context.module.exports, option, calls };
}

test('warehouse-product-update: devuelve todos los conflictos de precios del payload', async () => {
  const h = harness();
  const body = {
    warehouse_id: 31,
    company_id: 17,
    id: 84,
    variants: JSON.stringify([
      {
        variant_id: 139,
        warehouse_product_variant_id: null,
        quantity: 2,
        stock: 2,
        price: 55000,
        purchase_price: 50000,
        promotional_price: null,
        create_new_lot: true
      },
      {
        variant_id: 139,
        warehouse_product_variant_id: null,
        quantity: 2,
        stock: 2,
        price: 60000,
        purchase_price: 65000,
        promotional_price: null,
        create_new_lot: true
      }
    ])
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await h.controller.update({ body, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 409);
  assert.equal(res.body.code, 'PRODUCT_OPTION_PRICE_CONFLICT');
  assert.equal(res.body.conflicts.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(res.body.conflicts.map((conflict) => conflict.requested))),
    [
      { price: 55000, purchase_price: 50000, promotional_price: null },
      { price: 60000, purchase_price: 65000, promotional_price: null }
    ]
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(res.body.conflicts.map((conflict) => conflict.changed_fields))),
    [['price', 'purchase_price'], ['price', 'purchase_price']]
  );
  assert.equal(res.body.options.length, 2);
  assert.deepEqual(
    JSON.parse(JSON.stringify(res.body.options.map((item) => item.warehouse_product_variant_id))),
    [180, 180]
  );
  assert.equal(h.option.price, 25000);
  assert.equal(h.option.purchase_price, 20000);
  assert.equal(h.calls.variantUpdates, 0);
  assert.equal(h.calls.rollback, 1);
  assert.equal(h.calls.commit, 0);
});

function creationHarness({
  withExistingAssociation = false,
  additionalAssociations = [],
  recordCompanyId = 17,
  warehouseCompanyId = 17,
  branchCompanyId = 17
} = {}) {
  const record = { id: 84, product_id: 37, warehouse_id: 31, company_id: recordCompanyId, branch_id: 1, active: true };
  const warehouse = { id: 31, company_id: warehouseCompanyId, branch_id: 1, code: 'WH-31', name: 'Almacén' };
  const product = { id: 37, company_id: 17, sku: 'BAND-CUBA', name: 'Banda Cuba' };
  const sourceVariant = { id: 139, product_id: 37, sku: 'BAND-CUBA-001' };
  const productVariants = [sourceVariant];
  const variantValues = [];
  const variantLinks = [{ product_variant_id: 139, variant_value_id: 10, variant_definition_id: 1 }];
  const associations = [];
  const calls = { creates: 0, updates: 0, movements: 0, audits: 0, rollback: 0, commit: 0 };
  const auditEvents = [];
  const transaction = {
    rollback: async () => { calls.rollback++; },
    commit: async () => { calls.commit++; }
  };
  let nextVariantId = 200;
  let nextAssociationId = 300;
  const existingAssociation = withExistingAssociation
    ? {
        id: 180,
        variant_id: 139,
        price: 40000,
        purchase_price: 35000,
        promotional_price: null,
        stock: 5,
        local_sku: 'BAND-CUBA-001',
        active: true,
        published: false,
        toJSON() {
          return {
            id: this.id,
            variant_id: this.variant_id,
            price: this.price,
            purchase_price: this.purchase_price,
            promotional_price: this.promotional_price,
            stock: this.stock,
            local_sku: this.local_sku,
            active: this.active,
            published: this.published
          };
        },
        get() {
          return this;
        },
        async update(changes) {
          Object.assign(this, changes);
          calls.updates++;
        }
      }
    : null;
  const existingAssociations = existingAssociation
    ? [existingAssociation, ...additionalAssociations]
    : [...additionalAssociations];
  const definitions = [
    { id: 1, company_id: 17, name: 'Color' },
    { id: 2, company_id: 17, name: 'Modelo' }
  ];
  const values = [{ id: 10, variant_definition_id: 1, name: 'Azul' }];

  const repositories = {
    WarehouseRepository: { findById: async () => warehouse },
    BranchRepository: { findById: async () => ({ id: 1, company_id: branchCompanyId }) },
    ProductRepository: { findById: async () => product },
    ProductVariantRepository: {
      findByProductId: async () => productVariants,
      create: async (data) => {
        const created = { ...data, id: nextVariantId++ };
        productVariants.push(created);
        return created;
      }
    },
    WarehouseProductRepository: {
      findById: async () => record,
      update: async () => record,
      findFiltered: async () => []
    },
    WarehouseProductVariantRepository: {
      findByWarehouseProductId: async () => [...existingAssociations, ...associations],
      create: async (data) => {
        calls.creates++;
        const created = { ...data, id: nextAssociationId++ };
        associations.push(created);
        return created;
      }
    },
    InventoryMovementRepository: {
      create: async () => { calls.movements++; }
    },
    VariantDefinitionRepository: {
      create: async (data) => {
        const created = { ...data, id: definitions.length + 1 };
        definitions.push(created);
        return created;
      }
    },
    VariantValueRepository: {
      create: async (data) => {
        const created = { ...data, id: 20 + values.length };
        values.push(created);
        return created;
      }
    },
    ProductVariantValueRepository: {
      replaceValuesForVariant: async (variantId, valueIds) => {
        for (const valueId of valueIds) {
          const value = values.find((item) => Number(item.id) === Number(valueId));
          variantLinks.push({
            product_variant_id: variantId,
            variant_value_id: valueId,
            variant_definition_id: value.variant_definition_id
          });
        }
      }
    },
    LogRepository: { create: async () => {} }
  };
  const models = {
    sequelize: { transaction: async () => transaction },
    Branch: { findByPk: async () => ({ id: 1, company_id: 17 }) },
    ProductVariant: {
      findOne: async ({ where }) => productVariants.find((item) => Number(item.id) === Number(where.id)) || null,
      findAll: async ({ where } = {}) => {
        if (where && where.id && Array.isArray(where.id)) {
          return productVariants.filter((item) => where.id.includes(item.id));
        }
        return productVariants;
      }
    },
    ProductVariantValue: {
      findAll: async ({ where } = {}) => {
        if (Array.isArray(where.product_variant_id)) {
          return variantLinks.filter((link) => where.product_variant_id.includes(link.product_variant_id));
        }
        return variantLinks.filter((link) => Number(link.product_variant_id) === Number(where.product_variant_id));
      }
    },
    VariantDefinition: {
      findAll: async () => definitions,
      findByPk: async (id) => definitions.find((item) => Number(item.id) === Number(id)) || null
    },
    VariantValue: {
      findAll: async ({ where } = {}) => {
        if (Array.isArray(where.id)) return values.filter((item) => where.id.includes(item.id));
        return values.filter((item) => Number(item.variant_definition_id) === Number(where.variant_definition_id));
      },
      findByPk: async (id) => values.find((item) => Number(item.id) === Number(id)) || null
    }
  };
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === '../repositories') return repositories;
      if (name === '../models') return models;
      if (name === 'sequelize') return { Op: {} };
      if (name === 'uuid') return { v4: () => 'creation-reference' };
      if (name.includes('logger')) return { info() {}, error() {} };
      if (name.includes('requestUtil')) return { getRequestMetadata: () => ({ user_id: 1 }) };
      if (name.includes('context')) return { getUserId: () => 1 };
      if (name.includes('AuditEventService')) {
        return {
          safeRecordFromRequest: async (_request, payload) => {
            calls.audits++;
            auditEvents.push(payload);
          }
        };
      }
      if (name.includes('auditUtils')) return { detectChanges: () => [] };
      if (name.includes('ProductOptionService')) {
        return {
          normalizeVariantValueIds: (ids) => [...new Set(ids.map(Number))].sort((a, b) => a - b),
          buildOptionKey: (_productId, ids) => ids.map(Number).sort((a, b) => a - b).join('-')
        };
      }
      return {};
    }
  };
  const source = fs.readFileSync(
    path.join(__dirname, '../app/controllers/WarehouseProductController.js'),
    'utf8'
  );
  vm.runInNewContext(source, context);
  return {
    controller: context.module.exports,
    calls,
    auditEvents,
    associations,
    existingAssociation,
    productVariants,
    variantLinks
  };
}

test('warehouse-product-update: rechaza la creación de variantes globales', async () => {
  const h = creationHarness();
  const body = {
    id: 84,
    warehouse_id: 31,
    company_id: 17,
    create_new_variant: true,
    variants: JSON.stringify([
      {
        variant_id: 139,
        source_variant_id: 139,
        sku: 'BAND-CUBA-MODELO-A',
        quantity: 2,
        price: 55000,
        purchase_price: 50000,
        promotional_price: null,
        create_new_variant: true,
        new_characteristic: {
          definition_id: 2,
          definition_name: 'Modelo',
          value_id: null,
          value_name: 'A'
        }
      },
      {
        variant_id: 139,
        source_variant_id: 139,
        sku: 'BAND-CUBA-MODELO-B',
        quantity: 3,
        price: 60000,
        purchase_price: 52000,
        promotional_price: null,
        create_new_variant: true,
        new_characteristic: {
          definition_id: 2,
          definition_name: 'Modelo',
          value_id: null,
          value_name: 'B'
        }
      }
    ])
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await h.controller.update({ body, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VARIANT_CREATION_NOT_ALLOWED_IN_INVENTORY');
  assert.equal(h.calls.creates, 0);
  assert.equal(h.calls.movements, 0);
  assert.equal(h.calls.commit, 0);
  assert.equal(h.calls.rollback, 0);
});

test('warehouse-product-update: rechaza una solicitud mixta que intente crear una variante global', async () => {
  const h = creationHarness({ withExistingAssociation: true });
  const body = {
    id: 84,
    warehouse_id: 31,
    company_id: 17,
    create_new_variant: true,
    source_variant_id: 139,
    warehouse_product_variant_id: 180,
    new_variant_name: 'Azul / S / Pro',
    new_characteristic: {
      definition_id: 2,
      definition_name: 'Modelo',
      value_id: null,
      value_name: 'Pro'
    },
    variants: JSON.stringify([
      {
        variant_id: 139,
        warehouse_product_variant_id: 180,
        quantity: 2,
        local_sku: 'BAND-CUBA-001',
        price: 45000,
        purchase_price: 40000,
        promotional_price: null,
        create_new_lot: false
      },
      {
        source_variant_id: 139,
        sku: 'BAND-CUBA-MODELO-PRO',
        quantity: 2,
        price: 60000,
        purchase_price: 55000,
        promotional_price: null,
        create_new_variant: true,
        new_characteristic: {
          definition_id: 2,
          definition_name: 'Modelo',
          value_id: null,
          value_name: 'Pro'
        }
      }
    ])
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await h.controller.update({ body, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'VARIANT_CREATION_NOT_ALLOWED_IN_INVENTORY');
  assert.equal(h.calls.updates, 0);
  assert.equal(h.calls.creates, 0);
  assert.equal(h.calls.movements, 0);
  assert.equal(h.calls.commit, 0);
  assert.equal(h.calls.rollback, 0);
});

test('warehouse-product-update: asocia una variante global existente sin crearla', async () => {
  const h = creationHarness();
  const body = {
    id: 84,
    warehouse_id: 31,
    company_id: 17,
    variants: JSON.stringify([{
      variant_id: 139,
      warehouse_product_variant_id: null,
      stock: 2,
      local_sku: 'BAND-CUBA-001',
      price: 55000,
      purchase_price: 50000,
      promotional_price: null,
      active: true,
      published: false
    }])
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await h.controller.update({ body, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(h.calls.creates, 1);
  assert.equal(h.calls.movements, 1);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.rollback, 0);
  assert.deepEqual(h.productVariants.map((variant) => variant.id), [139]);
  assert.deepEqual(h.associations.map((association) => ({
    variant_id: association.variant_id,
    stock: association.stock,
    price: association.price,
    purchase_price: association.purchase_price
  })), [{ variant_id: 139, stock: 2, price: 55000, purchase_price: 50000 }]);
  assert.equal(res.body.warehouse_product_variant.id, 300);
  assert.equal(res.body.warehouse_product_variant.product_variant_id, 139);
  assert.equal(h.auditEvents.length, 1);
  const detail = h.auditEvents[0].metadata.detalle_de_variantes[0];
  assert.equal(detail.is_new_variant, false);
  assert.equal(detail.is_new_association, true);
  assert.equal(detail.operacion, 'Variante global asociada al almacén');
  assert.ok(detail.cambios.every((change) => change.is_new_association === true));
});

test('warehouse-product-update: resuelve company_id desde la sucursal para auditar', async () => {
  const h = creationHarness({
    recordCompanyId: null,
    warehouseCompanyId: null,
    branchCompanyId: 17
  });
  const body = {
    id: 84,
    warehouse_id: 31,
    variants: JSON.stringify([{
      variant_id: 139,
      warehouse_product_variant_id: null,
      stock: 2,
      local_sku: 'BAND-CUBA-001',
      price: 55000,
      purchase_price: 50000,
      promotional_price: null,
      active: true,
      published: false
    }])
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await h.controller.update({ body, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(h.calls.commit, 1);
  assert.equal(h.calls.rollback, 0);
  assert.equal(h.auditEvents.length, 1);
  assert.equal(h.auditEvents[0].company_id, 17);
});

test('warehouse-product-update: usa lot_id como respaldo para actualizar la asociación exacta', async () => {
  const secondAssociation = {
    id: 181,
    variant_id: 139,
    price: 41000,
    purchase_price: 36000,
    promotional_price: null,
    stock: 2,
    local_sku: 'BAND-CUBA-002',
    active: true,
    published: false,
    async update(changes) {
      Object.assign(this, changes);
    }
  };
  const h = creationHarness({
    withExistingAssociation: true,
    additionalAssociations: [secondAssociation]
  });
  const body = {
    id: 84,
    product_id: 37,
    warehouse_id: 31,
    company_id: 17,
    variants: JSON.stringify([{
      variant_id: 139,
      warehouse_product_variant_id: null,
      lot_id: 180,
      stock: 2,
      price: 40000,
      purchase_price: 35000,
      promotional_price: null
    }])
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await h.controller.update({ body, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(h.existingAssociation.stock, 7);
  assert.equal(h.existingAssociation.price, 40000);
  assert.equal(secondAssociation.stock, 2);
  assert.equal(secondAssociation.price, 41000);
  assert.equal(res.body.warehouse_product_variant.id, 180);
});

test('warehouse-product-update: rechaza una cabecera que no coincide con el warehouse_product', async () => {
  const h = creationHarness();
  const body = {
    id: 84,
    product_id: 999,
    warehouse_id: 31,
    company_id: 17,
    variants: JSON.stringify([])
  };
  const res = {
    status(code) { this.statusCode = code; return this; },
    json(data) { this.body = data; return this; }
  };

  await h.controller.update({ body, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.body.code, 'WAREHOUSE_PRODUCT_CONTEXT_MISMATCH');
  assert.match(res.body.message, /product_id/);
});
