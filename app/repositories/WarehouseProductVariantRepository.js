// repositories/WarehouseProductVariantRepository.js
const { Op, literal } = require("sequelize");
const { WarehouseProductVariant, WarehouseProduct, Product } = require("../models");

const WarehouseProductVariantRepository = {
  async findByWarehouseProductId(warehouseProductId) {
    return await WarehouseProductVariant.findAll({
      where: { warehouse_product_id: warehouseProductId },
      attributes: [
        'id', 'warehouse_product_id', 'variant_id',
        'active', 'published', 'local_sku',
        'price', 'promotional_price', 'stock'
      ]
    });
  },

  async findByVariantAndWarehouseProduct(variantId, warehouseProductId) {
    return await WarehouseProductVariant.findOne({
      where: { variant_id: variantId, warehouse_product_id: warehouseProductId }
    });
  },

  async create(data, options = {}) {
    return await WarehouseProductVariant.create(data, options);
  },

  async update(record, data, options = {}) {
    return await record.update(data, options);
  },

  async delete(record, options = {}) {
    return await record.destroy(options);
  },

  async findByWarehouseProductIdAndVariantId(wpId, variantId) {
  return await WarehouseProductVariant.findOne({
    where: {
      warehouse_product_id: wpId,
      variant_id: variantId
    }
  });
},

async findAllWithProductAndWarehouse(warehouseIds) {
   if (warehouseIds.length === 0) return [];

  const records = await WarehouseProductVariant.findAll({
    where: {
      warehouse_product_id: {
        [Op.in]: literal(`(SELECT id FROM warehouse_products WHERE warehouse_id IN (${warehouseIds.join(',')}))`)
      }
    },
    include: [{
      model: WarehouseProduct,
      as: 'warehouseProduct',
      attributes: ['warehouse_id', 'product_id'],
      required: true
    }],
    attributes: ['id', 'variant_id', 'stock'],
    raw: true,
    nest: true
  });

  return records.map(r => ({
    id: r.id,
    variant_id: r.variant_id,
    warehouse_id: r.warehouseProduct.warehouse_id,
    product_id: r.warehouseProduct.product_id,
    stock: parseInt(r.stock) || 0
  }));
}
};

module.exports = WarehouseProductVariantRepository;