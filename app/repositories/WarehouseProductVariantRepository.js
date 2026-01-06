// repositories/WarehouseProductVariantRepository.js
const { WarehouseProductVariant } = require("../models");

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
}
};

module.exports = WarehouseProductVariantRepository;