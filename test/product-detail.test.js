const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const {
  storeProductSchema,
  updateProductSchema,
  assignWarehouseSchema,
  productDetailSchema
} = require('../app/middlewares/validations/productValidations');

function loadController({ company, product }) {
  const repositories = {
    CompanyRepository: {
      findById: async () => company
    },
    ProductRepository: {
      findById: async () => product
    }
  };
  const context = {
    module: { exports: {} },
    require(name) {
      if (name === '../repositories') return repositories;
      if (name === '../models') return { sequelize: {} };
      if (name.includes('logger')) return { info() {}, error() {}, warn() {} };
      if (name.includes('requestUtil')) return { getRequestMetadata: () => ({}) };
      if (name.includes('ProductOptionService')) {
        return {
          normalizeVariantValueIds: (ids) => [...new Set(ids.map(Number))]
            .filter((id) => Number.isInteger(id) && id > 0)
            .sort((left, right) => left - right),
          buildOptionKey() {},
          getDuplicateOptionGroups() {},
          findProductOptions() {},
          buildDuplicateOptionError() {}
        };
      }
      return {};
    }
  };
  const source = fs.readFileSync(
    path.join(__dirname, '../app/controllers/ProductController.js'),
    'utf8'
  );
  vm.runInNewContext(source, context);
  return context.module.exports;
}

function invoke(controller, body) {
  const response = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(data) {
      this.body = data;
      return this;
    }
  };

  return controller.detail({ body, user: { id: 1 } }, response).then(() => response);
}

test('product-detail devuelve variantes globales normalizadas', async () => {
  const controller = loadController({
    company: { id: 24 },
    product: {
      id: 28,
      company_id: 24,
      name: 'Producto de prueba',
      sku: 'PROD-28',
      variants: [{
        id: '115',
        sku: 'VAR-115',
        attributes: { legacy_name: 'no debe usarse' },
        variantValues: [
          { id: '25', variant_definition_id: '4', name: '20' },
          { id: '10', variant_definition_id: '2', name: 'Azul' }
        ]
      }]
    }
  });

  const response = await invoke(controller, { company_id: 24, product_id: 28 });

  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)), {
    success: true,
    product: {
      id: 28,
      name: 'Producto de prueba',
      sku: 'PROD-28',
      variants: [{
        id: 115,
        sku: 'VAR-115',
        variant_value_ids: [10, 25],
        variant_values: [
          { id: 10, variant_definition_id: 2, name: 'Azul' },
          { id: 25, variant_definition_id: 4, name: '20' }
        ]
      }]
    }
  });
});

test('product-detail no expone un producto de otra compañía', async () => {
  const controller = loadController({
    company: { id: 24 },
    product: { id: 28, company_id: 17, name: 'Privado', sku: 'PRIV-28', variants: [] }
  });

  const response = await invoke(controller, { company_id: 24, product_id: 28 });

  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(JSON.stringify(response.body)), {
    success: false,
    code: 'PRODUCT_NOT_FOUND',
    message: 'El producto no existe para la compañía indicada'
  });
});

test('product-detail valida el esquema de entrada', () => {
  assert.equal(productDetailSchema.validate({ company_id: 24, product_id: 28 }).error, undefined);
  assert.ok(productDetailSchema.validate({ company_id: 24 }).error);
  assert.ok(productDetailSchema.validate({ company_id: 24, product_id: -1 }).error);
});

const flexibleProductData = {
  sku: 'PROD-TEST-01',
  name: 'Producto de prueba',
  brand: 'Marca de prueba',
  company_id: 19,
  product_measurements: JSON.stringify({
    frontend_payload: { any_key: true, nested: ['value'] }
  }),
  packaging_measurements: JSON.stringify({ packaging: { custom: 'format' } }),
  attributes: JSON.stringify([{
    custom_attribute: { arbitrary: true },
    value: ['managed', 'by', 'frontend']
  }]),
  product_variants: JSON.stringify([{
    frontend_variant_shape: { arbitrary: true },
    variant_value_ids: ['managed-by-frontend']
  }]),
  warehouse_config: JSON.stringify([{
    warehouse_id: 'frontend-format',
    variants: [{ stock: 'frontend-format', custom_price_data: { arbitrary: true } }]
  }]),
  images_order: JSON.stringify([{ file: 'temporary-upload', position: 'first' }]),
  sync_meta: JSON.stringify({ source: 'frontend', payload: { arbitrary: true } }),
  warehouses: [{ frontend_warehouse_shape: true, nested: { arbitrary: true } }]
};

test('la creación acepta JSON serializado sin validar estructuras internas', () => {
  const { error } = storeProductSchema.validate(flexibleProductData, { abortEarly: false });

  assert.equal(error, undefined);
});

test('la actualización acepta JSON serializado sin validar estructuras internas', () => {
  const { warehouses, ...updateData } = flexibleProductData;
  const { error } = updateProductSchema.validate({ id: 81, ...updateData }, { abortEarly: false });

  assert.equal(error, undefined);
});

test('la asociación de almacén conserva la validación del array raíz, no de sus elementos', () => {
  const valid = assignWarehouseSchema.validate({
    product_id: 28,
    company_id: 24,
    warehouse_config: JSON.stringify([{ arbitrary: true }])
  });
  const empty = assignWarehouseSchema.validate({
    product_id: 28,
    company_id: 24,
    warehouse_config: JSON.stringify([])
  });

  assert.equal(valid.error, undefined);
  assert.ok(empty.error);
});
