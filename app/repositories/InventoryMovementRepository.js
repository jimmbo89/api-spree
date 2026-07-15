// repositories/InventoryMovementRepository.js
const { InventoryMovement, Warehouse, Product, ProductVariant, User, Company, Branch, VariantValue, ProductVariantValue, VariantDefinition, WarehouseProductVariant } = require("../models");
const logger = require("../../config/logger");
const { Op, col, fn, literal } = require("sequelize");
const WarehouseRepository = require("./WarehouseRepository");
const WarehouseProductRepository = require("./WarehouseProductRepository");
const WarehouseProductVariantRepository = require("./WarehouseProductVariantRepository");
const ProductRepository = require("./ProductRepository");
const { getDateRange } = require("../util/dateUtils");

/**
 * Obtiene los variant_values para un variant_id dado
 * @param {number} variantId - ID del ProductVariant
 * @returns {Promise<Array>} Lista de variant_values con información completa
 */
async function getVariantValues(variantId) {
  try {
    if (!variantId) return [];

    const productVariant = await ProductVariant.findByPk(variantId, {
      include: [{
        model: VariantValue,
        as: 'variantValues',
        attributes: ['id', 'name', 'code', 'variant_definition_id'],
        through: { attributes: [] },
        include: [{
          model: VariantDefinition,
          as: 'definition',
          attributes: ['id', 'name']
        }]
      }]
    });

    if (!productVariant || !productVariant.variantValues) return [];

    return productVariant.variantValues.map(vv => ({
      id: vv.id,
      name: vv.name,
      code: vv.code,
      variant_definition_id: vv.variant_definition_id,
      definition: vv.definition ? {
        id: vv.definition.id,
        name: vv.definition.name
      } : null
    })).sort((a, b) => {
      if (a.variant_definition_id !== b.variant_definition_id) {
        return a.variant_definition_id - b.variant_definition_id;
      }
      return a.id - b.id;
    });
  } catch (error) {
    logger.error("getVariantValues error:", error.message);
    return [];
  }
}

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

  // ⭐ Extraer variant_values del meta si existen
  let variantValues = null;
  let variantLabel = null;
  if (record.meta) {
    try {
      const meta = typeof record.meta === 'string' ? JSON.parse(record.meta) : record.meta;
      variantValues = meta.variant_values || null;
      variantLabel = meta.variant_label || null;
    } catch (e) {
      // Ignorar si no se puede parsear
    }
  }

  // ⭐ Si no hay variant_values en meta, obtenerlos desde la relación variant.variantValues
  if (!variantValues && record.variant?.variantValues) {
    const variantValuesRaw = Array.isArray(record.variant.variantValues) ? record.variant.variantValues : [];
    variantValues = variantValuesRaw.map(vv => ({
      id: vv.id,
      name: vv.name,
      code: vv.code,
      variant_definition_id: vv.variant_definition_id,
      definition: vv.definition ? { id: vv.definition.id, name: vv.definition.name } : null
    })).sort((a, b) => {
      if (a.variant_definition_id !== b.variant_definition_id) {
        return a.variant_definition_id - b.variant_definition_id;
      }
      return a.id - b.id;
    });

    variantLabel = variantValues.map(vv => vv.name).filter(Boolean).join(" / ");
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
    unit_price: record.unit_price,        // Precio de venta unitario (histórico del movimiento)
    purchase_price: record.purchase_price, // Precio de compra unitario (histórico del movimiento)
    total_value: record.total_value,
    reference_type: record.reference_type,
    reference_id: record.reference_id,
    origin_warehouse_id: record.origin_warehouse_id,
    destination_warehouse_id: record.destination_warehouse_id,
    user_id: record.user_id,
    reason: record.reason,
    notes: record.notes,
    createdAt: record.createdAt ? record.createdAt.toISOString().slice(0, 16).replace('T', ' ') : null,

    // ⭐ PRECIOS ACTUALES de la variante (enriquecidos)
    current_price: record.current_price || null,
    current_purchase_price: record.current_purchase_price || null,
    current_promotional_price: record.current_promotional_price || null,

    // ⭐ VARIANT_VALUES: Información de las variantes (similar a /warehouse-products-not-in-warehouse)
    variant_values: variantValues,
    variant_label: variantLabel,

    // ⭐ PRIMERA IMAGEN DEL PRODUCTO (para fácil acceso en el frontend)
    product_first_image: productFirstImage,

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
    variant: record.variant ? {
      id: record.variant.id,
      sku: record.variant.sku,
      attributes: record.variant.attributes
    } : null,
    user: record.user ? { id: record.user.id, name: record.user.name, image: record.user.image } : null,
    company: record.company ? { id: record.company.id, name: record.company.name, image: record.company.image } : null,
    branch: record.branch ? { id: record.branch.id, name: record.branch.name, image: record.branch.image } : null
  };
}

const InventoryMovementRepository = {
  /**
   * ⭐ Enriquece los movimientos con los precios actuales de las variantes
   * desde warehouse_product_variants
   */
  async _enrichMovementsWithCurrentPrices(movements) {
    try {
      // Obtener todos los variant_id únicos de los movimientos
      const variantIds = [...new Set(
        movements
          .map(m => m.variant_id)
          .filter(id => id != null)
      )];

      if (variantIds.length === 0) return movements;

      // Obtener precios actuales desde warehouse_product_variants
      const currentPrices = await WarehouseProductVariant.findAll({
        where: {
          variant_id: { [Op.in]: variantIds },
          active: true
        },
        attributes: ['variant_id', 'price', 'purchase_price', 'promotional_price'],
        raw: true
      });

      // Crear mapa de precios por variant_id
      const priceMap = {};
      for (const cp of currentPrices) {
        if (!priceMap[cp.variant_id]) {
          priceMap[cp.variant_id] = {
            price: parseFloat(cp.price) || 0,
            purchase_price: parseFloat(cp.purchase_price) || 0,
            promotional_price: cp.promotional_price ? parseFloat(cp.promotional_price) : null
          };
        }
      }

      // Agregar precios actuales a cada movimiento
      for (const movement of movements) {
        if (movement.variant_id && priceMap[movement.variant_id]) {
          movement.current_price = priceMap[movement.variant_id].price;
          movement.current_purchase_price = priceMap[movement.variant_id].purchase_price;
          movement.current_promotional_price = priceMap[movement.variant_id].promotional_price;
        }
      }

      return movements;
    } catch (error) {
      logger.error("_enrichMovementsWithCurrentPrices error:", {
        message: error.message,
        stack: error.stack
      });
      return movements; // Retornar movimientos sin enriquecer si hay error
    }
  },

  async create(data, options = {}) {
    try {
      // ⭐ Agregar variant_values al movimiento si hay variant_id
      if (data.variant_id && !data.meta?.variant_values) {
        const variantValues = await getVariantValues(data.variant_id);
        
        if (variantValues.length > 0) {
          // Crear etiqueta legible similar a /warehouse-products-not-in-warehouse
          const variantLabel = variantValues.map(vv => vv.name).filter(Boolean).join(" / ");
          
          // Agregar al meta
          data.meta = {
            ...(data.meta || {}),
            variant_values: variantValues,
            variant_label: variantLabel
          };
        }
      }

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

  async findByReferencePrefix(referencePrefix, options = {}) {
    try {
      if (!referencePrefix) return [];

      return await InventoryMovement.findAll({
        where: {
          reference_id: {
            [Op.like]: `${referencePrefix}%`
          }
        },
        order: [['createdAt', 'ASC']],
        ...options
      });
    } catch (error) {
      logger.error("InventoryMovementRepository.findByReferencePrefix error:", error.message);
      throw error;
    }
  },

 async findWithFilters(filters = {}, options = {}) {
  try {
    // ✅ EXTRAER fechas desde filters (o options, según tu convención)
    const { start_date, end_date, company_id, branch_id } = filters;

    // ✅ Obtener rango seguro usando tu helper existente
    const dates = getDateRange(start_date, end_date);

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
    
    // ⭐ IMPORTANTE: Si hay company_id Y branch_id, incluir ambos
    // Si hay solo company_id, incluir movimientos de la company Y de sus branches
    if (company_id != null) {
      if (branch_id != null) {
        // Si hay ambos, usar branch_id específico (prioridad)
        where.branch_id = branch_id;
        // También incluir movimientos directos de la company si existen
        where[Op.or] = [
          { company_id: company_id },
          { branch_id: branch_id }
        ];
      } else {
        // Si solo hay company_id, incluir movimientos de la company Y de sus branches
        where[Op.or] = [
          { company_id: company_id },
          { branch_id: { [Op.in]: literal(`(SELECT id FROM branches WHERE company_id = ${company_id})`) } }
        ];
      }
    } else if (branch_id != null) {
      // Si solo hay branch_id (sin company_id), filtrar por branch_id
      where.branch_id = branch_id;
    }
    
    if (filters.reference_id != null) where.reference_id = filters.reference_id;

    // ✅ Aplicar filtro de fecha usando las fechas procesadas
    where.createdAt = {
      [Op.gte]: `${dates.start_date} 00:00:00`,
      [Op.lte]: `${dates.end_date} 23:59:59.999`
    };

    const movements = await InventoryMovement.findAll({
      where,
      include: [
            { model: Warehouse, as: 'warehouse', attributes: ['id','name','image'] },
            { model: Warehouse, as: 'originWarehouse', foreignKey: 'origin_warehouse_id', attributes: ['id','name','image'] },
            { model: Warehouse, as: 'destinationWarehouse', foreignKey: 'destination_warehouse_id', attributes: ['id','name','image'] },
            { model: Product, as: 'product', attributes: ['id','name','images'] },
            { 
              model: ProductVariant, 
              as: 'variant', 
              attributes: ['id','sku','attributes'],
              include: [{
                model: VariantValue,
                as: 'variantValues',
                attributes: ['id', 'name', 'code', 'variant_definition_id'],
                through: { attributes: [] },
                include: [{
                  model: VariantDefinition,
                  as: 'definition',
                  attributes: ['id', 'name']
                }]
              }]
            },
            { model: User, as: 'user', attributes: ['id','name','image'] },
            { model: Company, as: 'company', attributes: ['id','name','image'] },
            { model: Branch, as: 'branch', attributes: ['id','name','image'] }
        ],
      order: [['createdAt', 'DESC']]
    });

    // ⭐ ENRIQUECER movimientos con precios actuales de las variantes desde warehouse_product_variants
    const enrichedMovements = await this._enrichMovementsWithCurrentPrices(movements);

    return enrichedMovements.map(m => mapInventoryMovement(m));

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
