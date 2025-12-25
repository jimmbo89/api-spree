// repositories/InventoryMovementRepository.js
const { InventoryMovement, Warehouse, Product, ProductVariant, User, Company, Branch } = require("../models");
const logger = require("../../config/logger");
const { Op } = require("sequelize");

/**
 * Mapea un registro de InventoryMovement a un objeto plano con relaciones.
 */
function mapInventoryMovement(record) {
  if (!record) return null;

  let productFirstImage = null;
  if (record.product?.images) {
    try {
      const images = typeof record.product.images === 'string'
        ? JSON.parse(record.product.images)
        : record.product.images;
      if (Array.isArray(images) && images.length > 0) {
        productFirstImage = images[0];
      }
    } catch (e) {
      // Ignorar
    }
  }

  return {
    id: record.id,
    warehouse_id: record.warehouse_id,
    product_id: record.product_id,
    variant_id: record.variant_id,
    company_id: record.company_id,
    branch_id: record.branch_id,
    movement_type: record.movement_type,
    quantity: record.quantity,
    stock_before: record.stock_before,
    stock_after: record.stock_after,
    unit_price: record.unit_price,
    total_value: record.total_value,
    reference_type: record.reference_type,
    reference_id: record.reference_id,
    origin_warehouse_id: record.origin_warehouse_id,
    destination_warehouse_id: record.destination_warehouse_id,
    user_id: record.user_id,
    reason: record.reason,
    notes: record.notes,
    createdAt: record.createdAt ? record.createdAt.toISOString().slice(0, 16).replace('T', ' ') : null,

    warehouse: record.warehouse ? { id: record.warehouse.id, name: record.warehouse.name, image: record.warehouse.image } : null,
    originWarehouse: record.originWarehouse ? { 
      id: record.originWarehouse.id, 
      name: record.originWarehouse.name, 
      image: record.originWarehouse.image 
    } : null,
    
    destinationWarehouse: record.destinationWarehouse ? { 
      id: record.destinationWarehouse.id, 
      name: record.destinationWarehouse.name, 
      image: record.destinationWarehouse.image 
    } : null,
    product: record.product ? { id: record.product.id, name: record.product.name, first_image: productFirstImage } : null,
    variant: record.variant ? { id: record.variant.id, sku: record.variant.sku, attributes: record.variant.attributes } : null,
    user: record.user ? { id: record.user.id, name: record.user.name } : null,
    company: record.company ? { id: record.company.id, name: record.company.name, image: record.company.image } : null,
    branch: record.branch ? { id: record.branch.id, name: record.branch.name, image: record.branch.image } : null
  };
}

const InventoryMovementRepository = {
  async create(data, options = {}) {
    try {
      return await InventoryMovement.create(data, options);
    } catch (error) {
      logger.error("InventoryMovementRepository.create error:", error.message);
      throw error;
    }
  },

  async findByWarehouseId(warehouseId, options = {}) {
    try {
      return await InventoryMovement.findAll({
        where: { warehouse_id: warehouseId },
        order: [['createdAt', 'DESC']],
        ...options
      });
    } catch (error) {
      logger.error("InventoryMovementRepository.findByWarehouseId error:", error.message);
      throw error;
    }
  },

  async findByProductId(productId, options = {}) {
    try {
      return await InventoryMovement.findAll({
        where: { product_id: productId },
        order: [['createdAt', 'DESC']],
        ...options
      });
    } catch (error) {
      logger.error("InventoryMovementRepository.findByProductId error:", error.message);
      throw error;
    }
  },

  async findByVariantId(variantId, options = {}) {
    try {
      return await InventoryMovement.findAll({
        where: { variant_id: variantId },
        order: [['createdAt', 'DESC']],
        ...options
      });
    } catch (error) {
      logger.error("InventoryMovementRepository.findByVariantId error:", error.message);
      throw error;
    }
  },

  async findByCompanyId(companyId, options = {}) {
    try {
      return await InventoryMovement.findAll({
        where: { company_id: companyId },
        order: [['createdAt', 'DESC']],
        ...options
      });
    } catch (error) {
      logger.error("InventoryMovementRepository.findByCompanyId error:", error.message);
      throw error;
    }
  },

  async findByBranchId(branchId, options = {}) {
    try {
      return await InventoryMovement.findAll({
        where: { branch_id: branchId },
        order: [['createdAt', 'DESC']],
        ...options
      });
    } catch (error) {
      logger.error("InventoryMovementRepository.findByBranchId error:", error.message);
      throw error;
    }
  },

  async findByReferenceId(referenceId, options = {}) {
    try {
      return await InventoryMovement.findAll({
        where: { reference_id: referenceId },
        order: [['createdAt', 'ASC']],
        ...options
      });
    } catch (error) {
      logger.error("InventoryMovementRepository.findByReferenceId error:", error.message);
      throw error;
    }
  },

  async findWithFilters(filters = {}, options = {}) {
  try {
    const where = {};

    if (filters.warehouse_id != null) {
      where[Op.or] = [
        { warehouse_id: filters.warehouse_id },
        { origin_warehouse_id: filters.warehouse_id },
        { destination_warehouse_id: filters.warehouse_id }
      ];
    };
    if (filters.product_id != null) where.product_id = filters.product_id;
    if (filters.variant_id != null) where.variant_id = filters.variant_id;
    if (filters.company_id != null) where.company_id = filters.company_id;
    if (filters.branch_id != null) where.branch_id = filters.branch_id;
    if (filters.reference_id != null) where.reference_id = filters.reference_id;

    // Fechas: si no se envían, usar hoy
    const today = new Date();
    const start = filters.startDate 
      ? new Date(new Date(filters.startDate).setHours(0,0,0,0))
      : new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const end = filters.endDate
      ? new Date(new Date(filters.endDate).setHours(23,59,59,999))
      : new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);

    where.createdAt = { [Op.gte]: start, [Op.lte]: end };

    const movements = await InventoryMovement.findAll({
      where,
      include: [
            { model: Warehouse, as: 'warehouse', attributes: ['id','name','image'] },
            { model: Warehouse, as: 'originWarehouse', foreignKey: 'origin_warehouse_id', attributes: ['id','name','image'] },
            { model: Warehouse, as: 'destinationWarehouse', foreignKey: 'destination_warehouse_id', attributes: ['id','name','image'] },
            { model: Product, as: 'product', attributes: ['id','name','images'] },
            { model: ProductVariant, as: 'variant', attributes: ['id','sku','attributes'] },
            { model: User, as: 'user', attributes: ['id','name'] },
            { model: Company, as: 'company', attributes: ['id','name','image'] },
            { model: Branch, as: 'branch', attributes: ['id','name','image'] }
        ],
      order: [['createdAt', 'DESC']]
    });

    return movements.map(m => mapInventoryMovement(m));

  } catch (error) {
    logger.error("InventoryMovementRepository.findWithFilters error:", error.message);
    throw error;
  }
}
};

module.exports = InventoryMovementRepository;