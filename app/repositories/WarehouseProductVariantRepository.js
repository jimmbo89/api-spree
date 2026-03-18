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
        'price', 'promotional_price', 'purchase_price', 'stock'
      ]
    });
  },

  async findByVariantAndWarehouseProduct(variantId, warehouseProductId) {
    // NOTA: Con el nuevo sistema de lotes, esto puede retornar múltiples registros
    // Este método se mantiene para compatibilidad, retorna el primer lote activo
    return await WarehouseProductVariant.findOne({
      where: { 
        variant_id: variantId, 
        warehouse_product_id: warehouseProductId,
        active: true
      },
      order: [['createdAt', 'ASC']] // Retorna el lote más antiguo (FIFO)
    });
  },

  /**
   * NUEVO: Obtiene TODOS los lotes activos de una variante en un almacén
   * Ordenados por fecha de creación (más antiguo primero) para FIFO
   */
  async findAllLotsByVariantAndWarehouse(variantId, warehouseProductId) {
    return await WarehouseProductVariant.findAll({
      where: {
        variant_id: variantId,
        warehouse_product_id: warehouseProductId,
        active: true,
        stock: { [Op.gt]: 0 }
      },
      order: [['createdAt', 'ASC']], // FIFO: más antiguo primero
      attributes: [
        'id', 'warehouse_product_id', 'variant_id',
        'active', 'published', 'local_sku',
        'price', 'promotional_price', 'purchase_price', 'stock',
        'createdAt'
      ]
    });
  },

  /**
   * NUEVO: Obtiene el stock total de una variante en un almacén (suma de todos los lotes)
   */
  async getTotalStockByVariantAndWarehouse(variantId, warehouseProductId) {
    const result = await WarehouseProductVariant.findOne({
      where: {
        variant_id: variantId,
        warehouse_product_id: warehouseProductId,
        active: true,
        stock: { [Op.gt]: 0 }
      },
      attributes: [
        [literal('SUM(stock)'), 'total_stock'],
        [literal('AVG(purchase_price)'), 'avg_purchase_price']
      ],
      raw: true
    });
    
    return {
      total_stock: parseInt(result?.total_stock || 0),
      avg_purchase_price: parseFloat(result?.avg_purchase_price || 0)
    };
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
      attributes: ['id', 'variant_id', 'stock', 'purchase_price'],
      raw: true,
      nest: true
    });

    return records.map(r => ({
      id: r.id,
      variant_id: r.variant_id,
      warehouse_id: r.warehouseProduct.warehouse_id,
      product_id: r.warehouseProduct.product_id,
      stock: parseInt(r.stock) || 0,
      purchase_price: parseFloat(r.purchase_price) || 0
    }));
  },

  /**
   * NUEVO: Obtiene un lote específico por ID para venta selectiva
   */
  async findLotById(lotId) {
    return await WarehouseProductVariant.findByPk(lotId, {
      attributes: [
        'id', 'warehouse_product_id', 'variant_id',
        'active', 'published', 'local_sku',
        'price', 'promotional_price', 'purchase_price', 'stock',
        'createdAt'
      ]
    });
  },

  /**
   * NUEVO: Obtiene todos los lotes de un warehouse_product para mostrar en UI
   */
  async findAllLotsWithDetails(warehouseProductId) {
    return await WarehouseProductVariant.findAll({
      where: { warehouse_product_id: warehouseProductId },
      include: [{
        model: Product,
        as: 'variant',
        attributes: ['id', 'sku', 'name', 'attributes']
      }],
      attributes: [
        'id', 'warehouse_product_id', 'variant_id',
        'active', 'published', 'local_sku',
        'price', 'promotional_price', 'purchase_price', 'stock',
        'createdAt', 'updatedAt'
      ],
      order: [['createdAt', 'DESC']] // Más reciente primero para UI
    });
  }
};

module.exports = WarehouseProductVariantRepository;