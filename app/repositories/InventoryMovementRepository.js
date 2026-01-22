// repositories/InventoryMovementRepository.js
const { InventoryMovement, Warehouse, Product, ProductVariant, User, Company, Branch } = require("../models");
const logger = require("../../config/logger");
const { Op, col, fn } = require("sequelize");
const WarehouseRepository = require("./WarehouseRepository");
const WarehouseProductRepository = require("./WarehouseProductRepository");
const WarehouseProductVariantRepository = require("./WarehouseProductVariantRepository");
const ProductRepository = require("./ProductRepository");

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
},

  /**
   * Obtiene inventario consolidado por variante + almacén.
   * Si no hay stock, devuelve todos los productos activos con stock=0.
   *
   * @param {Object} params
   * @param {number} params.companyId - ID de la empresa (obligatorio)
   * @param {number} [params.branchId] - ID de la sucursal (opcional)
   * @returns {Promise<Array>} Lista de registros de inventario
   */
  async getConsolidatedInventory({ companyId, branchId }) {
    try {
      // 1. Obtener almacenes válidos
      const warehouses = await WarehouseRepository.findFiltered({
        companyId,
        branchId,
        includeProducts: false,
      });
      const warehouseIds = warehouses.map((w) => w.id);
      
      if (warehouseIds.length === 0) {
        // Si no hay almacenes, devolver productos activos sin stock
        return await this._getProductsWithoutStock(companyId);
      }

      // 2. Obtener productos con sus variantes y stock desde los almacenes
      const warehouseProducts = await WarehouseProductRepository.findFiltered({
        warehouseId: warehouseIds,
      });

      if (warehouseProducts.length === 0) {
        // Si no hay productos asignados, devolver productos activos sin stock
        return await this._getProductsWithoutStock(companyId);
      }

      // 3. Extraer IDs únicos
      const productIds = [...new Set(warehouseProducts.map((wp) => wp.product_id))];
      const variantIds = [
        ...new Set(
          warehouseProducts
            .flatMap((wp) =>
              (wp.variants || []).map((v) => v.variant_id).filter((id) => id != null)
            )
        ),
      ];

      // 4. Cargar productos completos (con atributos, imágenes, etc.)
      const products = await ProductRepository.findFiltered({
        companyId,
        productId: productIds,
        state: 1, // solo activos
      });
      const productMap = new Map(products.map((p) => [p.id, p]));

      // 5. Obtener último movimiento por variante (solo si hay variantes)
      let lastMovements = {};
      if (variantIds.length > 0) {
        try {
          const movements = await InventoryMovement.findAll({
            where: {
              variant_id: { [Op.in]: variantIds },
              company_id: companyId,
            },
            attributes: [
              "variant_id",
              [fn("MAX", col("createdAt")), "last_movement_at"],
            ],
            group: ["variant_id"],
            raw: true,
          });
          lastMovements = movements.reduce((acc, m) => {
            acc[m.variant_id] = m.last_movement_at;
            return acc;
          }, {});
        } catch (error) {
          logger.warn("No se pudo cargar último movimiento:", error.message);
        }
      }

      // 6. Construir resultado final
      const result = [];
      for (const wp of warehouseProducts) {
        const product = productMap.get(wp.product_id);
        if (!product) continue;

        const baseData = {
          product_id: wp.product_id,
          product_name: wp.name,
          product_image: wp.product_image,
          sku: wp.sku,
        };

        if (wp.variants && wp.variants.length > 0) {
          // Producto con variantes
          for (const v of wp.variants) {
            if ((v.stock || 0) <= 0) continue; // Opcional: omitir stock 0

            const warehouse = warehouses.find((w) => w.id === wp.warehouse_id);
            if (!warehouse) continue;

            result.push({
              ...baseData,
              variant_id: v.variant_id,
              variant_attributes: v.attributes || {},
              physical_stock: v.stock || 0,
              reserved_stock: 0,
              available_stock: v.stock || 0,
              last_movement_at: lastMovements[v.variant_id] || null,
              warehouse_id: warehouse.id,
              warehouse_name: warehouse.name,
            });
          }
        } else {
          // Producto sin variantes → usar stock global
          if ((wp.stock || 0) > 0) {
            const warehouse = warehouses.find((w) => w.id === wp.warehouse_id);
            if (warehouse) {
              result.push({
                ...baseData,
                variant_id: null,
                variant_attributes: {},
                physical_stock: wp.stock || 0,
                reserved_stock: 0,
                available_stock: wp.stock || 0,
                last_movement_at: null, // No hay variante → no hay movimiento específico
                warehouse_id: warehouse.id,
                warehouse_name: warehouse.name,
              });
            }
          }
        }
      }

      // 7. Si no hay stock en ningún almacén, devolver todos los productos activos con stock=0
      if (result.length === 0) {
        return await this._getProductsWithoutStock(companyId);
      }

      return result;
    } catch (error) {
      logger.error("InventoryRepository.getConsolidatedInventory error:", error.message);
      throw error;
    }
  },

  /**
   * Devuelve todos los productos activos de una empresa con stock=0.
   * @private
   */
  async _getProductsWithoutStock(companyId) {
    const products = await ProductRepository.findFiltered({
      companyId,
      state: 1,
    });
    const result = [];
    for (const p of products) {
      const variants = p.variants && p.variants.length > 0 
        ? p.variants 
        : [{ id: null, sku: p.sku, attributes: {} }];

      for (const v of variants) {
        result.push({
          product_id: p.id,
          product_name: p.name,
          product_image: Array.isArray(p.images) ? p.images[0] : null,
          sku: v.sku || p.sku,
          variant_id: v.id,
          variant_attributes: typeof v.attributes === "string"
            ? JSON.parse(v.attributes || "{}")
            : v.attributes || {},
          physical_stock: 0,
          reserved_stock: 0,
          available_stock: 0,
          last_movement_at: null,
          warehouse_id: null,
          warehouse_name: "—",
        });
      }
    }
    return result;
  },
};

module.exports = InventoryMovementRepository;