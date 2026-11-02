const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeTopProducts } = require('../app/util/dashboardTopProducts');

test('mantiene separados los productos no vinculados por su identidad de marketplace', () => {
  const result = mergeTopProducts([], [
    {
      marketplace: 'mercadolibre',
      listing_id: 'MLC-100',
      marketplace_item_id: '100',
      sku: 'SKU-100',
      title: 'Producto Mercado Libre A',
      total_quantity: '700'
    },
    {
      marketplace: 'falabella',
      listing_id: 'FAL-200',
      marketplace_item_id: '200',
      sku: 'SKU-200',
      title: 'Producto Falabella B',
      total_quantity: '350'
    }
  ], 3);

  assert.deepEqual(result.map(item => [item.name, item.value]), [
    ['Producto Mercado Libre A', 700],
    ['Producto Falabella B', 350]
  ]);
  assert.equal(result[0].isLinked, false);
  assert.equal(result[0].externalId, 'mercadolibre:MLC-100');
  assert.equal(result[1].isLinked, false);
});

test('combina productos vinculados y externos, los ordena y respeta el limite', () => {
  const result = mergeTopProducts([
    {
      product_id: 12,
      'product.name': 'Producto local',
      'product.images': '["local.jpg"]',
      total_quantity: '4'
    }
  ], [
    {
      marketplace_item_id: 'EXT-1',
      title: 'Producto externo',
      total_quantity: '8'
    }
  ], 1);

  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'Producto externo');
  assert.equal(result[0].value, 8);
});
