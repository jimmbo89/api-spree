const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeVariantValueIds,
  buildOptionKey,
  getDuplicateOptionGroups
} = require('../app/services/ProductOptionService');

test('normaliza valores de opción sin depender del orden y elimina repetidos', () => {
  assert.deepEqual(normalizeVariantValueIds([8, 5, 8]), [5, 8]);
  assert.equal(buildOptionKey(10, [8, 5]), buildOptionKey(10, [5, 8]));
});

test('detecta combinaciones repetidas dentro de un payload', () => {
  const duplicates = getDuplicateOptionGroups([
    { client_key: 'one', variant_value_ids: [5, 8] },
    { client_key: 'two', variant_value_ids: [8, 5] }
  ], 10);

  assert.equal(duplicates.length, 1);
  assert.deepEqual(duplicates[0].variant_value_ids, [5, 8]);
});
