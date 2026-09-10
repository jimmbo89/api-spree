const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

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
  const { productDetailSchema } = require('../app/middlewares/validations/productValidations');

  assert.equal(productDetailSchema.validate({ company_id: 24, product_id: 28 }).error, undefined);
  assert.ok(productDetailSchema.validate({ company_id: 24 }).error);
  assert.ok(productDetailSchema.validate({ company_id: 24, product_id: -1 }).error);
});
