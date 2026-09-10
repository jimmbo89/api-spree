const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function model(data) {
  return {
    ...data,
    get() {
      return { ...data };
    },
    async update(changes) {
      Object.assign(data, changes);
      Object.assign(this, changes);
      return this;
    }
  };
}

function response() {
  return {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    }
  };
}

function loadController({ warehouse, updatedWarehouse = warehouse, createdWarehouse = warehouse, branch }) {
  const auditEvents = [];
  const repositories = {
    WarehouseRepository: {
      findById: async () => warehouse,
      update: async () => updatedWarehouse,
      create: async () => createdWarehouse,
      delete: async () => {},
      checkUniqueName: async () => ({ exists: false }),
      findFiltered: async () => []
    },
    CompanyRepository: { findById: async () => null },
    UserRepository: { findById: async () => ({ id: 1 }) },
    BranchRepository: { findById: async () => branch },
    LogRepository: { create: async () => {} },
    UserAclScopeRepository: {}
  };

  const context = {
    module: { exports: {} },
    require(name) {
      if (name === '../repositories') return repositories;
      if (name.includes('auditUtils')) {
        return {
          detectChanges: () => [{
            field: 'capacity_max_units',
            old_value: 500,
            new_value: 1000
          }]
        };
      }
      if (name.includes('requestUtil')) return { getRequestMetadata: () => ({ user_id: 1 }) };
      if (name.includes('AuditEventService')) {
        return {
          safeRecordFromRequest: async (_req, payload) => {
            auditEvents.push(payload);
          }
        };
      }
      if (name.includes('logger')) return { info() {}, error() {} };
      return {};
    }
  };

  const source = fs.readFileSync(
    path.join(__dirname, '../app/controllers/WarehouseController.js'),
    'utf8'
  );
  vm.runInNewContext(source, context);
  return { controller: context.module.exports, auditEvents };
}

test('warehouse-update: resuelve company_id desde branch_id al registrar auditoría', async () => {
  const warehouse = model({
    id: 25,
    company_id: null,
    branch_id: 15,
    code: 'WH-25',
    name: 'Almacén de prueba',
    capacity_max_units: 500
  });
  const updatedWarehouse = model({
    id: 25,
    company_id: null,
    branch_id: 15,
    code: 'WH-25',
    name: 'Almacén de prueba',
    capacity_max_units: 1000
  });
  const h = loadController({
    warehouse,
    updatedWarehouse,
    branch: { id: 15, company_id: 19 }
  });
  const res = response();

  await h.controller.update({
    body: { id: '25', capacity_max_units: '1000' },
    user: { id: 1, name: 'Ivan Martín' }
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(h.auditEvents.length, 1);
  assert.equal(h.auditEvents[0].company_id, 19);
  assert.equal(h.auditEvents[0].branch_id, 15);
  assert.equal(h.auditEvents[0].new_value.capacity_max_units, 1000);
});

test('warehouse-store: resuelve company_id desde branch_id al registrar auditoría', async () => {
  const warehouse = model({
    id: 26,
    company_id: null,
    branch_id: 15,
    code: 'WH-26',
    name: 'Almacén nuevo'
  });
  const h = loadController({
    warehouse,
    createdWarehouse: warehouse,
    branch: { id: 15, company_id: 19 }
  });
  const res = response();

  await h.controller.store({
    body: {
      branch_id: 15,
      code: 'WH-26',
      name: 'Almacén nuevo'
    },
    user: { id: 1, name: 'Ivan Martín' }
  }, res);

  assert.equal(res.statusCode, 201);
  assert.equal(h.auditEvents.length, 1);
  assert.equal(h.auditEvents[0].company_id, 19);
  assert.equal(h.auditEvents[0].branch_id, 15);
});

test('warehouse-delete: resuelve company_id desde branch_id al registrar auditoría', async () => {
  const warehouse = model({
    id: 25,
    company_id: null,
    branch_id: 15,
    code: 'WH-25',
    name: 'Almacén eliminado'
  });
  const h = loadController({ warehouse, branch: { id: 15, company_id: 19 } });
  const res = response();

  await h.controller.destroy({ body: { id: 25 }, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(h.auditEvents.length, 1);
  assert.equal(h.auditEvents[0].company_id, 19);
  assert.equal(h.auditEvents[0].branch_id, 15);
});

test('warehouse-status: resuelve company_id desde branch_id al registrar auditoría', async () => {
  const warehouse = model({
    id: 25,
    company_id: null,
    branch_id: 15,
    code: 'WH-25',
    name: 'Almacén',
    status: 'activo'
  });
  const h = loadController({ warehouse, branch: { id: 15, company_id: 19 } });
  const res = response();

  await h.controller.toggleStatus({ body: { id: 25 }, user: { id: 1 } }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(h.auditEvents.length, 1);
  assert.equal(h.auditEvents[0].company_id, 19);
  assert.equal(h.auditEvents[0].branch_id, 15);
});
