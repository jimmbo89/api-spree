const { Op } = require('sequelize');
const { WarehouseProduct, Product, ProductVariant, WarehouseProductVariant, ProductCategory, Sequelize } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');
const ProductRepository = require('./ProductRepository');

const WarehouseProductRepository = {
async findFiltered({ companyId, userId, branchId, warehouseId }) {
  const where = {};

  if (companyId !== undefined) where.company_id = companyId;
  if (userId !== undefined) where.user_id = userId;
  if (branchId !== undefined) where.branch_id = branchId;
  
  // Manejar warehouseId como array o número
  if (warehouseId !== undefined) {
    if (Array.isArray(warehouseId)) {
      where.warehouse_id = { [Op.in]: warehouseId };
    } else {
      where.warehouse_id = warehouseId;
    }
  }

  const records = await WarehouseProduct.findAll({
    where,
    include: [
      {
        model: Product,
        as: 'product',
        attributes: [
          'id', 'sku', 'name', 'description', 'brand', 'model', 
          'condition', 'gtin', 'mpn', 'attributes', 'warranty_months', 
          'warranty_text', 'weight_grams', 'length_cm', 'width_cm', 
          'height_cm', 'images', 'category_id', 'user_id', 'company_id'
        ],
        include: [{ 
          model: ProductVariant, 
          as: 'variants',
          attributes: ['id', 'sku', 'attributes']
        }]
      },
      {
        model: WarehouseProductVariant,
        as: 'warehouseVariants', // Según tus logs, el alias es 'variants'
        include: [{
          model: ProductVariant,
          as: 'variant',
          attributes: ['id', 'sku', 'attributes']
        }]
      }
    ]
  });

  return records.map(wp => {
    const wpJson = wp.toJSON ? wp.toJSON() : wp;
    const product = wpJson.product;

    // Procesar imágenes y atributos del producto
    let productImages = [];
    let productAttributes = [];
    
    if (product) {
      try {
        // Imágenes
        if (product.images) {
          if (typeof product.images === 'string') {
            productImages = JSON.parse(product.images);
          } else if (Array.isArray(product.images)) {
            productImages = product.images;
          }
        }
        
        // Atributos
        if (product.attributes) {
          if (typeof product.attributes === 'string') {
            productAttributes = JSON.parse(product.attributes);
          } else if (Array.isArray(product.attributes)) {
            productAttributes = product.attributes;
          }
        }
      } catch (e) {
        logger.error('Error parsing product data:', JSON.stringify(e));
      }
    }

    // Procesar variantes del almacén
    // IMPORTANTE: Según tus logs, el alias es 'variants' (no 'warehouseVariants')
    const warehouseVariants = wpJson.warehouseVariants || [];
    
    const variantsWithStock = warehouseVariants.map(wpv => {      
      return {
        id: wpv.id,
        variant_id: wpv.variant_id,
        sku: wpv.variant?.sku || '',
        attributes: wpv.variant?.attributes || {},
        active: wpv.active !== false, // Asegurar booleano
        published: wpv.published || false,
        local_sku: wpv.local_sku || '',
        price: parseFloat(wpv.price) || 0,
        stock: parseInt(wpv.stock) || 0
      };
    });

    // Calcular stock total
    const totalStock = variantsWithStock.reduce((sum, v) => sum + (v.stock || 0), 0);

    const result = {
      id: wpJson.id,
      product_id: wpJson.product_id,
      warehouse_id: wpJson.warehouse_id,
      active: wpJson.active !== false,
      code: wpJson.code || wpJson.code || null, // Ambos nombres
      company_id: wpJson.company_id,
      branch_id: wpJson.branch_id,
      user_id: wpJson.user_id,

      // Datos del producto global
      sku: product?.sku || '',
      name: product?.name || '',
      brand: product?.brand || '',
      model: product?.model || '',
      condition: product?.condition || '',
      gtin: product?.gtin || '',
      mpn: product?.mpn || '',
      description: product?.description || '',
      warranty_months: product?.warranty_months || null,
      warranty_text: product?.warranty_text || '',
      weight_grams: product?.weight_grams || null,
      length_cm: product?.length_cm || null,
      width_cm: product?.width_cm || null,
      height_cm: product?.height_cm || null,
      product_images: productImages,
      product_image: productImages[0] || null,
      product_attributes: productAttributes,

      // Variantes con stock/precio
      variants: variantsWithStock,
      
      // Stock total para facilitar acceso
      stock: totalStock
    };
   
    return result;
  });
},  
async findProductsNotInWarehouse({ warehouseId, companyId, specificProductId = null }) {
  try {
    // 1. Obtener IDs de productos que YA están en el almacén
    const warehouseProducts = await WarehouseProduct.findAll({
      where: {
        warehouse_id: warehouseId
      },
      attributes: ['product_id'],
      raw: true
    });

    const productIdsInWarehouse = warehouseProducts.map(wp => wp.product_id);

    // 2. Crear whereClause inicial
    const whereClause = {};
    
    // Solo agregar condición de compañía si se proporciona
    if (companyId) {
      whereClause.company_id = companyId;
    }

    // 3. Si se solicita un producto específico, incluirlo SIEMPRE (modo edición)
    if (specificProductId) {
      whereClause[Op.or] = [
        { id: specificProductId }, // Incluir el producto específico
        {
          // Para otros productos, excluir los que ya están en el almacén
          id: {
            [Op.notIn]: productIdsInWarehouse.filter(id => id !== specificProductId)
          }
        }
      ];
    } else {
      // Modo normal: excluir productos ya en el almacén
      if (productIdsInWarehouse.length > 0) {
        whereClause.id = {
          [Op.notIn]: productIdsInWarehouse
        };
      }
    }

    const products = await Product.findAll({
      where: whereClause,
      include: [{
        model: ProductVariant,
        as: 'variants',
        attributes: ['id', 'sku', 'attributes']
      }],
      order: [['name', 'ASC']],
      limit: 100
    });

    // 4. Procesar resultados
    return products.map(product => {
      // Procesar imágenes
      let firstImage = null;
      if (product.images) {
        try {
          const images = typeof product.images === 'string' 
            ? JSON.parse(product.images) 
            : product.images;
          if (Array.isArray(images) && images.length > 0) {
            firstImage = images[0];
          }
        } catch (error) {
          console.warn(`Error parsing images for product ${product.id}:`, error);
        }
      }

      // Procesar atributos
      let attributes = [];
      if (product.attributes) {
        try {
          attributes = typeof product.attributes === 'string'
            ? JSON.parse(product.attributes)
            : product.attributes;
        } catch (error) {
          console.warn(`Error parsing attributes for product ${product.id}:`, error);
        }
      }

      return {
        id: product.id,
        sku: product.sku || '',
        name: product.name || 'Sin nombre',
        description: product.description || '',
        brand: product.brand || '',
        model: product.model || '',
        condition: product.condition || 'new',
        gtin: product.gtin || '',
        mpn: product.mpn || '',
        warranty_months: product.warranty_months || null,
        warranty_text: product.warranty_text || '',
        weight_grams: product.weight_grams || null,
        length_cm: product.length_cm || null,
        width_cm: product.width_cm || null,
        height_cm: product.height_cm || null,
        category_id: product.category_id || null,
        base_price: product.base_price || 0,
        status: product.status || 1,
        image: firstImage,
        attributes: attributes,
        variants: product.variants || [],
        // Información adicional para el autocomplete
        display_name: `${product.name}${product.brand ? ` - ${product.brand}` : ''}${product.sku ? ` (${product.sku})` : ''}`
      };
    });

  } catch (error) {
    logger.error('WarehouseProductRepository->findProductsNotInWarehouse:', JSON.stringify(error));
    throw error;
  }
},

async findProductsByWarehouseIds({ companyId, warehouseIds }) {
  // Paso 1: Obtener todos los warehouse_products + relaciones
  const records = await WarehouseProduct.findAll({
    where: {
      warehouse_id: { [Op.in]: warehouseIds }
    },
    include: [
      {
        model: Product,
        as: 'product',
        attributes: [
          'id', 'sku', 'name', 'description', 'brand', 'model', 'condition', 'gtin', 'mpn',
          'attributes', 'warranty_months', 'warranty_text', 'weight_grams', 'length_cm',
          'width_cm', 'height_cm', 'images', 'category_id', 'user_id', 'company_id'
        ],
        include: [{
          model: ProductVariant,
          as: 'variants',
          attributes: ['id', 'sku', 'attributes']
        },{
          model: ProductCategory,
          as: 'category',
          attributes: ['id', 'name', 'description']
        }]
      },
      {
        model: WarehouseProductVariant,
        as: 'warehouseVariants',
        include: [{
          model: ProductVariant,
          as: 'variant',
          attributes: ['id', 'sku', 'attributes']
        }]
      }
    ]
  });

  // Paso 2: Consolidar por product_id
  const productMap = new Map();

  for (const wp of records) {
    const productId = wp.product_id;
    const productData = wp.product;

    if (!productMap.has(productId)) {
      // Parsear imágenes y atributos una sola vez
      let images = [];
      if (productData.images) {
        try {
          images = typeof productData.images === 'string'
            ? JSON.parse(productData.images)
            : productData.images;
        } catch (e) {
          logger.warn(`Error parsing images for product ${productId}:`, e.message);
        }
      }

      let attributes = [];
      if (productData.attributes) {
        try {
          attributes = typeof productData.attributes === 'string'
            ? JSON.parse(productData.attributes)
            : productData.attributes;
        } catch (e) {
          logger.warn(`Error parsing attributes for product ${productId}:`, e.message);
        }
      }

      productMap.set(productId, {
        id: productId,
        sku: productData.sku || '',
        name: productData.name || '',
        description: productData.description || '',
        brand: productData.brand || '',
        model: productData.model || '',
        condition: productData.condition || '',
        gtin: productData.gtin || '',
        mpn: productData.mpn || '',
        category_id: productData.category_id || null,
        categoryName: productData.category?.name || null,
        warranty_months: productData.warranty_months,
        warranty_text: productData.warranty_text,
        weight_grams: productData.weight_grams,
        length_cm: productData.length_cm,
        width_cm: productData.width_cm,
        height_cm: productData.height_cm,
        images: images,
        attributes: attributes,
        variants: new Map(), // usaremos variant_id como clave
        totalStock: 0
      });
    }

    const consolidated = productMap.get(productId);

    // Agregar variantes del warehouse actual
    for (const wv of (wp.warehouseVariants || [])) {
      const variantId = wv.variant_id;
      const stock = parseInt(wv.stock) || 0;

      if (!consolidated.variants.has(variantId)) {
        consolidated.variants.set(variantId, {
          id: variantId,
          sku: wv.variant?.sku || '',
          attributes: wv.variant?.attributes || {},
          price: parseInt(wv.price) || 0,
          totalStock: 0
        });
      }

      consolidated.variants.get(variantId).totalStock += stock;
      consolidated.totalStock += stock;
    }
  }

  // Paso 3: Convertir a array plano
  return Array.from(productMap.values()).map(p => ({
    ...p,
    variants: Array.from(p.variants.values())
  }));
},

async getCountsByWarehouse(warehouseIds) {
  if (!warehouseIds || warehouseIds.length === 0) return {};

  const { sequelize } = require('../models');

  // CORRECCIÓN: Usar los nuevos nombres de campos
  const result = await sequelize.query(`
    SELECT
      wp.warehouse_id,
      COUNT(DISTINCT wp.id) AS product_count,
      COALESCE(SUM(wpv.stock), 0) AS total_stock,
      COALESCE(SUM(CASE WHEN wpv.active = 1 THEN 1 ELSE 0 END), 0) AS published_count
    FROM warehouse_products wp
    INNER JOIN warehouse_product_variants wpv ON wpv.warehouse_product_id = wp.id
    WHERE wp.warehouse_id IN (:warehouseIds)
    GROUP BY wp.warehouse_id
  `, {
    replacements: { warehouseIds },
    type: sequelize.QueryTypes.SELECT
  });

  const counts = {};
  result.forEach(item => {
    counts[item.warehouse_id] = {
      productCount: parseInt(item.product_count) || 0,
      totalStock: parseInt(item.total_stock) || 0,
      publishedProducts: parseInt(item.published_count) || 0
    };
  });

  return counts;
},
  async findById(id) {
    return await WarehouseProduct.findByPk(id, {
      include: [
        { model: Product, as: 'product' },
        { model: WarehouseProductVariant, as: 'warehouseVariants' }
      ]
    });
  },

  async findByProductAndWarehouse(productId, warehouseId) {
    return await WarehouseProduct.findOne({
      where: { product_id: productId, warehouse_id: warehouseId },
      include: [{ model: WarehouseProductVariant, as: 'warehouseVariants' }]
    });
  },

  async create(body, options = {}) {
        logger.info('Datos recibidos arehouseproductrepository.create:');
    logger.info(JSON.stringify(body));
    const { product_id, warehouse_id, active, code, company_id, branch_id, user_id } = body;
     try {
    return await WarehouseProduct.create({
      product_id,
      warehouse_id,
      active: active !== undefined ? active : true,
      code,
      company_id,
      branch_id,
      user_id
    }, options);
     } catch (err) {
        logger.error(err);
        throw err;
    }
  },

  async update(record, body, options = {}) {
    const updatable = ['active', 'code',];
    const data = {};
    for (const key of updatable) {
      if (body[key] !== undefined) data[key] = body[key];
    }
    return await record.update(data, options);
  },

  async delete(record) {
    return await record.destroy();
  },

  async getOrCreateForWarehouse(productId, warehouseId, options = {}) {
    let record = await WarehouseProduct.findOne({
      where: { product_id: productId, warehouse_id: warehouseId }
    });

    if (!record) {
      record = await WarehouseProduct.create({
        product_id: productId,
        warehouse_id: warehouseId,
        active: true,
        company_id: options.company_id,
        branch_id: options.branch_id,
        user_id: options.user_id
      }, options);
    }
    return record;
  },

  async getProductAndWarehouseData(productId, warehouseId) {
    const [product, warehouseProduct] = await Promise.all([
      ProductRepository.findById(productId),
      WarehouseProductRepository.findByProductAndWarehouse(productId, warehouseId)
    ]);

    if (!product) {
      throw new Error('productNotFound');
    }
    if (!warehouseProduct) {
      throw new Error('warehouseProductNotFound');
    }

    return { product, warehouseProduct };
  },

  async findByWarehouseAndProduct(warehouseId, productId) {
  return await WarehouseProduct.findOne({
    where: { warehouse_id: warehouseId, product_id: productId }
    // Si usas soft delete y quieres incluir "eliminados", añade:
    // paranoid: false
  });
}
};

module.exports = WarehouseProductRepository;