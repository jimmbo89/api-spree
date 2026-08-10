const { Op, fn, col, where, and, or, literal } = require('sequelize');
const { WarehouseProduct, Product, ProductVariant, WarehouseProductVariant, ProductCategory, ProductAttribute, Attribute, VariantValue, VariantDefinition, Branch, Company, Warehouse, sequelize } = require('../models');
const ImageService = require('../services/ImageService');
const logger = require('../../config/logger');
const path = require('path');
const fs = require('fs');
const { generateImageVersion } = require('../util/imageCacheUtils');
const { UPLOAD_BASE_PATH } = require('../../config/upload');

function toNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizePromotionalPrice(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildWarehouseVariantResponse(wpv) {
  const variantValuesRaw = Array.isArray(wpv.variant?.variantValues) ? wpv.variant.variantValues : [];
  const variantValues = variantValuesRaw.map(v => ({
    id: v.id,
    name: v.name,
    code: v.code,
    variant_definition_id: v.variant_definition_id,
    definition: v.definition ? { id: v.definition.id, name: v.definition.name } : null
  })).sort((a, b) => {
    if (a.variant_definition_id !== b.variant_definition_id) {
      return a.variant_definition_id - b.variant_definition_id;
    }
    return a.id - b.id;
  });
  const variantLabel = variantValues.map(v => v.name).filter(Boolean).join(" / ");

  return {
    id: wpv.id,
    variant_id: wpv.variant_id,
    sku: wpv.variant?.sku || '',
    attributes: wpv.variant?.attributes || {},
    variant_values: variantValues,
    variant_label: variantLabel,
    active: wpv.active !== false,
    published: wpv.published || false,
    local_sku: wpv.local_sku || '',
    price: toNumber(wpv.price),
    purchase_price: toNumber(wpv.purchase_price),
    promotional_price: normalizePromotionalPrice(wpv.promotional_price),
    stock: parseInt(wpv.stock, 10) || 0,
    createdAt: wpv.createdAt || null
  };
}

function consolidateWarehouseVariants(warehouseVariants = []) {
  const grouped = new Map();

  for (const wpv of warehouseVariants) {
    const item = buildWarehouseVariantResponse(wpv);
    const key = String(item.variant_id || item.id);

    if (!grouped.has(key)) {
      grouped.set(key, {
        ...item,
        lot_ids: [item.id],
        lots: [item]
      });
      continue;
    }

    const current = grouped.get(key);
    current.stock += item.stock;
    current.lot_ids.push(item.id);
    current.lots.push(item);
  }

  return Array.from(grouped.values());
}

const WarehouseProductRepository = {
async findFiltered({ companyId, userId, branchId, warehouseId, includeInactive = false } = {}) {
  const where = {};
  const include = [];

  // 🎯 CASO ESPECIAL: companyId sin branchId específico
  // Incluir productos vinculados directamente O vía branch del warehouse
  if (companyId != null && companyId !== 0 && (branchId == null || branchId === 0)) {
    
    // Incluir relación con warehouse y su branch para poder filtrar por branch.company_id
    include.push({
      model: Warehouse,
      as: 'warehouse',
      attributes: ['id', 'company_id', 'branch_id'],
      required: false,
      include: [{
        model: Branch,
        as: 'branch',
        attributes: ['id', 'company_id'],
        required: false
      }]
    });

    // Filtro OR: company_id directo O company_id del branch asociado al warehouse
    where[Op.or] = [
      { company_id: companyId },
      { 
        '$warehouse.branch.company_id$': companyId 
      }
    ];

  } else {
    // 🎯 Caso normal: filtros directos
    if (companyId != null && companyId !== 0) where.company_id = companyId;
    if (branchId != null && branchId !== 0) where.branch_id = branchId;
  }

  // Otros filtros
  if (userId != null && userId !== 0) where.user_id = userId;
  if (!includeInactive) where.active = true;
  
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
      ...include,
      {
        model: Product,
        as: 'product',
        attributes: [
          'id', 'sku', 'name', 'description', 'brand', 'model', 
          'condition', 'gtin', 'mpn', 'attributes', 'warranty_months', 
          'warranty_text', 'weight_grams', 'length_cm', 'width_cm', 
          'height_cm', 'product_measurements', 'packaging_measurements',
          'images', 'category_id', 'user_id', 'company_id'
        ],
        include: [
          { 
            model: ProductVariant, 
            as: 'variants',
            attributes: ['id', 'sku', 'attributes'],
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
          {
            model: ProductAttribute,
            as: 'productAttributes',
            attributes: ['id', 'attribute_id', 'value'],
            include: [{
              model: Attribute,
              as: 'attribute',
              attributes: ['id', 'name']
            }]
          }
        ],
        where: includeInactive ? undefined : { state: { [Op.ne]: 0 } }
      },
      {
        model: WarehouseProductVariant,
        as: 'warehouseVariants',
        attributes: [
          'id', 'warehouse_product_id', 'variant_id',
          'active', 'published', 'local_sku',
          'price', 'promotional_price', 'purchase_price', 'stock',
          'createdAt'
        ],
        include: [{
          model: ProductVariant,
          as: 'variant',
          attributes: ['id', 'sku', 'attributes'],
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
        }]
      }
    ],
    distinct: true,
    subQuery: false
  });

  return records.map(wp => {
    const wpJson = wp.toJSON ? wp.toJSON() : wp;
    const product = wpJson.product;

    // Procesar imágenes y atributos del producto
    let productImages = [];
    let productImagesWithVersion = [];
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

        // Imágenes con versión para caché
        productImagesWithVersion = productImages.map(img => {
          try {
            const filename = path.basename(img);
            const filepath = path.join(UPLOAD_BASE_PATH, 'products', filename);
            const version = fs.existsSync(filepath)
              ? generateImageVersion(filename, filepath)
              : Date.now().toString();
            return {
              url: img,
              version: version,
              fullUrl: `/images/products/${filename}?v=${version}`
            };
          } catch (e) {
            logger.warn(`Error generando versión para imagen ${img}:`, e.message);
            return { url: img, version: null, fullUrl: `/images/products/${img}` };
          }
        });

        // Atributos
        if (Array.isArray(product.productAttributes)) {
          for (const pa of product.productAttributes) {
            if (pa.attribute) {
              productAttributes.push({
                id: pa.id,
                attribute_id: pa.attribute.id,
                name: pa.attribute.name,
                value: pa.value
              });
            }
          }
        }
      } catch (e) {
        logger.error('Error parsing product ', JSON.stringify(e));
      }
    }

    const parseJsonObjectField = (value) => {
      if (value == null) return {};
      if (typeof value === 'string') {
        try {
          return JSON.parse(value);
        } catch (error) {
          logger.warn('Invalid JSON field in warehouse product response:', error.message);
          return {};
        }
      }
      if (typeof value === 'object') return value;
      return {};
    };

    // Procesar variantes del almacén
    const warehouseVariants = wpJson.warehouseVariants || [];

    const variantsWithStock = consolidateWarehouseVariants(warehouseVariants);

    // Calcular stock total solo de variantes activas
    const totalStock = variantsWithStock
      .filter(v => v.active)
      .reduce((sum, v) => sum + (v.stock || 0), 0);

    const result = {
      id: wpJson.id,
      product_id: wpJson.product_id,
      warehouse_id: wpJson.warehouse_id,
      active: wpJson.active !== false,
      code: wpJson.code || null,
      minimum_stock: parseInt(wpJson.minimum_stock, 10) || 0,
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
      product_measurements: parseJsonObjectField(product?.product_measurements),
      packaging_measurements: parseJsonObjectField(product?.packaging_measurements),
      product_images: productImages,
      product_images_with_version: productImagesWithVersion,
      product_image: productImages[0] || null,
      product_image_url: productImagesWithVersion[0]?.fullUrl || null,
      image_version: productImagesWithVersion[0]?.version || null,
      product_attributes: productAttributes,

      // Variantes con stock/precio
      variants: variantsWithStock,

      // Stock total para facilitar acceso
      stock: totalStock
    };

    return result;
  });
},

async getProductWarehousesWithStock({ productIds, companyId, branchId, warehouseId }) {
  if (!productIds || productIds.length === 0) {
    return {};
  }

  let warehouseIds = [];

  if (warehouseId != null && warehouseId !== 0) {
    const warehouse = await Warehouse.findByPk(warehouseId, {
      attributes: ['id']
    });
    warehouseIds = warehouse ? [warehouse.id] : [];
  } else if (branchId != null && branchId !== 0) {
    // Solo almacenes de esa sucursal
    const warehouses = await Warehouse.findAll({
      where: { branch_id: branchId },
      attributes: ['id']
    });
    warehouseIds = warehouses.map(w => w.id);
  } else if (companyId != null && companyId !== 0) {
    // Almacenes directos de la empresa
    const directWarehouses = await Warehouse.findAll({
      where: { company_id: companyId },
      attributes: ['id']
    });

    // Almacenes de sucursales de la empresa
    const branchWarehouses = await Warehouse.findAll({
      where: {
        branch_id: {
          [Op.in]: literal(`(SELECT id FROM branches WHERE company_id = ${companyId})`)
        }
      },
      attributes: ['id']
    });

    warehouseIds = [
      ...directWarehouses.map(w => w.id),
      ...branchWarehouses.map(w => w.id)
    ];
  } else {
    // Sin filtro: todos los almacenes posibles
    const allWarehouses = await Warehouse.findAll({ attributes: ['id'] });
    warehouseIds = allWarehouses.map(w => w.id);
  }

  if (warehouseIds.length === 0) {
    return {};
  }

  // Ahora obtenemos los WarehouseProducts con stock y precios de las variantes
  const results = await WarehouseProduct.findAll({
    where: {
      product_id: { [Op.in]: productIds },
      warehouse_id: { [Op.in]: warehouseIds }
    },
    attributes: [
      'product_id',
      'id', // warehouse_product_id
      'minimum_stock'
    ],
    include: [
      {
        model: Warehouse,
        as: 'warehouse',
        attributes: ['id', 'code', 'name', 'description', 'address', 'image'],
        required: true
      },
      {
        model: WarehouseProductVariant,
        as: 'warehouseVariants',
        attributes: [
          'id',
          'variant_id',
          'stock',
          'price',
          'purchase_price',
          'promotional_price',
          'active',
          'published',
          'local_sku'
        ],
        required: false,
        where: { active: true },
        include: [{
          model: ProductVariant,
          as: 'variant',
          attributes: ['id', 'sku', 'attributes'],
          required: false,
          include: [{
            model: VariantValue,
            as: 'variantValues',
            attributes: ['id', 'name', 'code', 'variant_definition_id'],
            through: { attributes: [] },
            required: false,
            include: [{
              model: VariantDefinition,
              as: 'definition',
              attributes: ['id', 'name'],
              required: false
            }]
          }]
        }]
      }
    ],
    raw: false
  });

    const resultMap = {};
    results.forEach(wp => {
    const warehouse = wp.warehouse || null;
    const productId = wp.product_id;
    if (!resultMap[productId]) resultMap[productId] = [];

    // Calcular stock total y obtener precios de las variantes
    const variants = consolidateWarehouseVariants(wp.warehouseVariants || []);
    const totalStock = variants.reduce((sum, v) => sum + (parseInt(v.stock, 10) || 0), 0);

    // Obtener precios (usar el primer variante activo como referencia)
    const firstVariant = variants.length > 0 ? variants[0] : null;

    resultMap[productId].push({
      id: warehouse?.id ?? wp.warehouse_id,
      name: warehouse?.name || null,
      code: warehouse?.code || null,
      description: warehouse?.description || null,
      address: warehouse?.address || null,
      image: warehouse?.image || null,
      stock: totalStock,
      warehouse_product_id: wp.id,
      minimum_stock: parseInt(wp.minimum_stock, 10) || 0,
      warehouse: {
        id: warehouse?.id ?? wp.warehouse_id,
        name: warehouse?.name || null,
        code: warehouse?.code || null,
        description: warehouse?.description || null,
        address: warehouse?.address || null,
        image: warehouse?.image || null
      },
      variants
    });
  });

  return resultMap;
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
    
    // Solo agregar condición de Compañía si se proporciona
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
      }],
      order: [['name', 'ASC']],
      limit: 100
    });

    // 4. Procesar resultados
    return products.map(product => {
      // Procesar imágenes
      let firstImage = null;
      let firstImageWithVersion = null;
      let imageVersion = null;
      
      if (product.images) {
        try {
          const images = typeof product.images === 'string'
            ? JSON.parse(product.images)
            : product.images;
          if (Array.isArray(images) && images.length > 0) {
            firstImage = images[0];
            
            // Generar versión para la primera imagen
            const filename = path.basename(firstImage);
            const filepath = path.join(UPLOAD_BASE_PATH, 'products', filename);
            imageVersion = fs.existsSync(filepath)
              ? generateImageVersion(filename, filepath)
              : Date.now().toString();
            
            firstImageWithVersion = `/images/products/${filename}?v=${imageVersion}`;
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
        purchase_price: product.purchase_price,
        sale_price: product.sale_price,
        status: product.status || 1,
        image: firstImage,
        image_url: firstImageWithVersion,
        image_version: imageVersion,
        attributes: attributes,
        variants: (product.variants || []).map(v => {
          const variantValuesRaw = Array.isArray(v.variantValues) ? v.variantValues : [];
          const variantValues = variantValuesRaw.map(val => ({
            id: val.id,
            name: val.name,
            code: val.code,
            variant_definition_id: val.variant_definition_id,
            definition: val.definition ? { id: val.definition.id, name: val.definition.name } : null
          })).sort((a, b) => {
            if (a.variant_definition_id !== b.variant_definition_id) {
              return a.variant_definition_id - b.variant_definition_id;
            }
            return a.id - b.id;
          });
          const variantLabel = variantValues.map(val => val.name).filter(Boolean).join(" / ");

          return {
            id: v.id,
            sku: v.sku || '',
            attributes: v.attributes || {},
            variant_values: variantValues,
            variant_label: variantLabel
          };
        }),
        // Información adicional para el autocomplete
        display_name: `${product.name}${product.brand ? ` - ${product.brand}` : ''}${product.sku ? ` (${product.sku})` : ''}`
      };
    });

  } catch (error) {
    logger.error('WarehouseProductRepository->findProductsNotInWarehouse:', JSON.stringify(error));
    throw error;
  }
},

async findProductsByWarehouseIds({ companyId, warehouseIds, includeInactive = false } = {}) {
  const normalizedWarehouseIds = Array.isArray(warehouseIds)
    ? warehouseIds.map((id) => Number(id)).filter((id) => Number.isFinite(id))
    : [];

  if (normalizedWarehouseIds.length === 0) {
    return [];
  }

  const productWhere = {
    state: { [Op.ne]: 0 }
  };

  if (companyId != null && companyId !== 0) {
    productWhere.company_id = companyId;
  }

  // Paso 1: Obtener todos los warehouse_products + relaciones
  const records = await WarehouseProduct.findAll({
    where: {
      warehouse_id: { [Op.in]: normalizedWarehouseIds },
      ...(includeInactive ? {} : { active: true }),
      ...(companyId != null && companyId !== 0
        ? {
            [Op.or]: [
              { company_id: companyId },
              { '$warehouse.company_id$': companyId },
              { '$warehouse.branch.company_id$': companyId }
            ]
          }
        : {})
    },
    include: [
      {
        model: Warehouse,
        as: 'warehouse',
        required: true,
        attributes: ['id', 'code', 'name', 'description', 'address', 'image', 'company_id', 'branch_id'],
        include: [{
          model: Branch,
          as: 'branch',
          required: false,
          attributes: ['id', 'name', 'company_id']
        }]
      },
      {
        model: Product,
        as: 'product',
        required: true,
        where: includeInactive ? undefined : productWhere,
        attributes: [
          'id', 'sku', 'name', 'description', 'brand', 'model', 'condition', 'gtin', 'mpn',
          'attributes', 'warranty_months', 'warranty_text', 'weight_grams', 'length_cm',
          'width_cm', 'height_cm', 'product_measurements', 'packaging_measurements',
          'images', 'category_id', 'user_id', 'company_id', 'state'
        ],
        include: [{
          model: ProductVariant,
          as: 'variants',
          attributes: ['id', 'sku', 'attributes'],
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
          attributes: ['id', 'sku', 'attributes'],
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
        }]
      }
    ],
    distinct: true,
    subQuery: false
  });

  // Paso 2: Consolidar por product_id
  const productMap = new Map();

  for (const wp of records) {
    const productId = wp.product_id;
    const productData = wp.product;

    if (!productMap.has(productId)) {
      // Parsear imágenes y atributos una sola vez
      let images = [];
      let imagesWithVersion = [];
      
      if (productData.images) {
        try {
          images = typeof productData.images === 'string'
            ? JSON.parse(productData.images)
            : productData.images;
          
          // Generar versiones para las imágenes
          imagesWithVersion = images.map(img => {
            try {
              const filename = path.basename(img);
              const filepath = path.join(UPLOAD_BASE_PATH, 'products', filename);
              const version = fs.existsSync(filepath)
                ? generateImageVersion(filename, filepath)
                : Date.now().toString();
              return {
                url: img,
                version: version,
                fullUrl: `/images/products/${filename}?v=${version}`
              };
            } catch (e) {
              logger.warn(`Error generando versión para imagen ${img}:`, e.message);
              return { url: img, version: null, fullUrl: `/images/products/${img}` };
            }
          });
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

      const parseJsonObjectField = (value) => {
        if (value == null) return {};
        if (typeof value === 'string') {
          try {
            return JSON.parse(value);
          } catch (error) {
            logger.warn(`Error parsing JSON field for product ${productId}:`, error.message);
            return {};
          }
        }
        if (typeof value === 'object') return value;
        return {};
      };

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
        product_measurements: parseJsonObjectField(productData.product_measurements),
        packaging_measurements: parseJsonObjectField(productData.packaging_measurements),
        images: images,
        images_with_version: imagesWithVersion,
        image_version: imagesWithVersion[0]?.version || null,
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
      const price = parseFloat(wv.price) || 0;
      const purchasePrice = parseFloat(wv.purchase_price) || 0; // ⭐ AGREGADO
      const variantValuesRaw = Array.isArray(wv.variant?.variantValues) ? wv.variant.variantValues : [];
      const variantValues = variantValuesRaw.map(v => ({
        id: v.id,
        name: v.name,
        code: v.code,
        variant_definition_id: v.variant_definition_id,
        definition: v.definition ? { id: v.definition.id, name: v.definition.name } : null
      })).sort((a, b) => {
        if (a.variant_definition_id !== b.variant_definition_id) {
          return a.variant_definition_id - b.variant_definition_id;
        }
        return a.id - b.id;
      });
      const variantLabel = variantValues.map(v => v.name).filter(Boolean).join(" / ");

      if (!consolidated.variants.has(variantId)) {
        consolidated.variants.set(variantId, {
          id: variantId,
          sku: wv.variant?.sku || '',
          attributes: wv.variant?.attributes || {},
          variant_values: variantValues,
          variant_label: variantLabel,
          price: price,
          purchase_price: purchasePrice, // ⭐ AGREGADO
          totalStock: 0
        });
      }

      const variant = consolidated.variants.get(variantId);
      variant.totalStock += stock;
      consolidated.totalStock += stock;
      
      // Actualizar price y purchase_price con el promedio ponderado si hay múltiples lotes
      if (variant.totalStock > 0) {
        variant.purchase_price = ((variant.totalStock - stock) * variant.purchase_price + stock * purchasePrice) / variant.totalStock;
      }
    }
  }

  // Paso 3: Convertir a array plano
  return Array.from(productMap.values()).map(p => ({
    ...p,
    variants: Array.from(p.variants.values())
  }));
},

async getProductStockByWarehouseIds({ productId, warehouseIds }) {
  if (!productId || !Array.isArray(warehouseIds) || warehouseIds.length === 0) {
    return {};
  }

  const result = await sequelize.query(`
    SELECT
      wp.warehouse_id,
      COALESCE(SUM(wpv.stock), 0) AS total_stock
    FROM warehouse_products wp
    INNER JOIN products p ON p.id = wp.product_id AND p.state <> 0
    LEFT JOIN warehouse_product_variants wpv
      ON wpv.warehouse_product_id = wp.id
    WHERE wp.product_id = :productId
      AND wp.warehouse_id IN (:warehouseIds)
      AND wp.active = 1
    GROUP BY wp.warehouse_id
  `, {
    replacements: { productId, warehouseIds },
    type: sequelize.QueryTypes.SELECT
  });

  const stockMap = {};
  result.forEach(row => {
    stockMap[row.warehouse_id] = parseInt(row.total_stock, 10) || 0;
  });

  return stockMap;
},

async getCountsByWarehouse(warehouseIds) {
  if (!warehouseIds || warehouseIds.length === 0) return {};
  // CORRECCIÓN: Usar los nuevos nombres de campos
  const result = await sequelize.query(`
    SELECT
      wp.warehouse_id,
      COUNT(DISTINCT wp.id) AS product_count,
      COALESCE(SUM(wpv.stock), 0) AS total_stock,
      COALESCE(SUM(CASE WHEN wpv.active = 1 THEN 1 ELSE 0 END), 0) AS published_count
    FROM warehouse_products wp
    INNER JOIN products p ON p.id = wp.product_id AND p.state <> 0
    INNER JOIN warehouse_product_variants wpv ON wpv.warehouse_product_id = wp.id
    WHERE wp.warehouse_id IN (:warehouseIds)
      AND wp.active = 1
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

async countUniqueProductsByCompanyId(companyId) {
  const query = `
    SELECT COUNT(DISTINCT wp.product_id) AS count
    FROM warehouse_products wp
    LEFT JOIN warehouses w ON wp.warehouse_id = w.id
    LEFT JOIN branches b ON w.branch_id = b.id
    WHERE wp.company_id = :companyId
       OR (b.company_id = :companyId AND wp.company_id IS NULL)
  `;
  const result = await sequelize.query(query, {
    replacements: { companyId },
    type: sequelize.QueryTypes.SELECT
  });
  return parseInt(result[0].count, 10) || 0;
},

async getTotalsByCompanyId(companyId) {
  const query = `
    SELECT
      COUNT(DISTINCT wp.product_id) AS total_products,
      COUNT(DISTINCT wp.id) AS total_warehouse_products,
      COALESCE(SUM(wpv.stock), 0) AS total_stock,
      COALESCE(SUM(wpv.stock * wpv.purchase_price), 0) AS total_inventory_value -- ⭐ NUEVO
    FROM warehouse_products wp
    LEFT JOIN warehouses w ON wp.warehouse_id = w.id
    LEFT JOIN branches b ON w.branch_id = b.id
    LEFT JOIN warehouse_product_variants wpv ON wpv.warehouse_product_id = wp.id
    WHERE wp.company_id = :companyId
       OR (b.company_id = :companyId AND wp.company_id IS NULL)
  `;
  const result = await sequelize.query(query, {
    replacements: { companyId },
    type: sequelize.QueryTypes.SELECT
  });
  const row = result[0] || {};
  return {
    totalProducts: parseInt(row.total_products, 10) || 0,
    totalWarehouseProducts: parseInt(row.total_warehouse_products, 10) || 0,
    totalStock: parseInt(row.total_stock, 10) || 0,
    totalInventoryValue: parseFloat(row.total_inventory_value) || 0 // ⭐ NUEVO: Valor total del inventario
  };
},

async getTotalsByCompanyByWarehouseId(companyId) {
  const query = `
    SELECT
      wp.warehouse_id,
      COUNT(DISTINCT wp.product_id) AS total_products,
      COUNT(DISTINCT wp.id) AS total_warehouse_products,
      COALESCE(SUM(wpv.stock), 0) AS total_stock,
      COALESCE(SUM(wpv.stock * wpv.purchase_price), 0) AS total_inventory_value -- ⭐ NUEVO
    FROM warehouse_products wp
    LEFT JOIN warehouses w ON wp.warehouse_id = w.id
    LEFT JOIN branches b ON w.branch_id = b.id
    LEFT JOIN warehouse_product_variants wpv ON wpv.warehouse_product_id = wp.id
    WHERE wp.company_id = :companyId
       OR (b.company_id = :companyId AND wp.company_id IS NULL)
    GROUP BY wp.warehouse_id
  `;
  const result = await sequelize.query(query, {
    replacements: { companyId },
    type: sequelize.QueryTypes.SELECT
  });

  const totalsByWarehouse = {};
  result.forEach(row => {
    totalsByWarehouse[row.warehouse_id] = {
      totalProducts: parseInt(row.total_products, 10) || 0,
      totalWarehouseProducts: parseInt(row.total_warehouse_products, 10) || 0,
      totalStock: parseInt(row.total_stock, 10) || 0,
      totalInventoryValue: parseFloat(row.total_inventory_value) || 0 // ⭐ NUEVO
    };
  });

  return totalsByWarehouse;
},

// Verifica si un producto YA está asociado a una Compañía
async isProductAssociatedWithCompany(productId, companyId) {
  const query = `
    SELECT 1
    FROM warehouse_products wp
    LEFT JOIN warehouses w ON wp.warehouse_id = w.id
    LEFT JOIN branches b ON w.branch_id = b.id
    WHERE wp.product_id = :productId
      AND (wp.company_id = :companyId OR (b.company_id = :companyId AND wp.company_id IS NULL))
    LIMIT 1
  `;
  const result = await sequelize.query(query, {
    replacements: { productId, companyId },
    type: sequelize.QueryTypes.SELECT
  });
  return result.length > 0;
},

/**
 * Obtiene resumen de productos y stock por empresa:
 * - Totales generales consolidados
 * - Desglose por almacén en formato array []
 *
 * @param {number} companyId - ID de la empresa
 * @returns {Promise<Object>}
 */
async getWarehouseSummaryByCompanyId(companyId) {
  // Primero obtener los IDs de almacenes que pertenecen a la Compañía
  // (directos o a través de branches)
  const warehousesResult = await sequelize.query(`
    SELECT DISTINCT w.id
    FROM warehouses w
    LEFT JOIN branches b ON w.branch_id = b.id
    WHERE w.company_id = :companyId
       OR b.company_id = :companyId
  `, {
    replacements: { companyId },
    type: sequelize.QueryTypes.SELECT
  });

  const warehouseIds = warehousesResult.map(r => r.id);

  if (warehouseIds.length === 0) {
    return {
      summary: { totalProducts: 0, totalWarehouseProducts: 0, totalStock: 0 },
      productsByWarehouse: []
    };
  }

  // Ahora usar esos IDs para obtener el resumen (misma lógica que getCountsByWarehouse)
  const query = `
    SELECT
      wp.warehouse_id,
      w.name AS warehouse_name,
      COUNT(DISTINCT wp.product_id) AS total_products,
      COUNT(DISTINCT wp.id) AS total_warehouse_products,
      COALESCE(SUM(CASE WHEN wpv.active = 1 THEN wpv.stock ELSE 0 END), 0) AS total_stock,
      COALESCE(SUM(CASE WHEN wpv.active = 1 THEN (wpv.stock * wpv.purchase_price) ELSE 0 END), 0) AS total_inventory_value,
      COALESCE(AVG(CASE WHEN wpv.active = 1 THEN wpv.purchase_price ELSE NULL END), 0) AS avg_purchase_price
    FROM warehouse_products wp
    INNER JOIN warehouses w ON wp.warehouse_id = w.id
    INNER JOIN products p ON p.id = wp.product_id AND p.state <> 0
    INNER JOIN warehouse_product_variants wpv ON wpv.warehouse_product_id = wp.id
    WHERE wp.warehouse_id IN (:warehouseIds)
      AND wp.active = 1
    GROUP BY wp.warehouse_id, w.name
    ORDER BY w.name ASC
  `;

  const result = await sequelize.query(query, {
    replacements: { warehouseIds },
    type: sequelize.QueryTypes.SELECT
  });

  // 📦 Transformar resultado a array de objetos
  const productsByWarehouse = result.map(row => ({
    warehouse_id: row.warehouse_id,
    warehouse_name: row.warehouse_name || 'Sin nombre',
    totalProducts: parseInt(row.total_products, 10) || 0,
    totalWarehouseProducts: parseInt(row.total_warehouse_products, 10) || 0,
    totalStock: parseInt(row.total_stock, 10) || 0,
    totalInventoryValue: parseFloat(row.total_inventory_value) || 0, // ⭐ NUEVO
    avgPurchasePrice: parseFloat(row.avg_purchase_price) || 0 // ⭐ NUEVO
  }));

  // Calcular totales generales a partir del desglose
  const totals = productsByWarehouse.reduce((acc, curr) => ({
    totalProducts: acc.totalProducts + curr.totalProducts,
    totalWarehouseProducts: acc.totalWarehouseProducts + curr.totalWarehouseProducts,
    totalStock: acc.totalStock + curr.totalStock
  }), {
    totalProducts: 0,
    totalWarehouseProducts: 0,
    totalStock: 0
  });

  // ⚠️ Ajuste crítico: totalProducts NO debe sumarse por almacén
  // porque un producto en 2 almacenes se contaría 2 veces
  // Necesitamos recalcular productos únicos a nivel empresa
  const uniqueProductsQuery = `
    SELECT COUNT(DISTINCT wp.product_id) AS unique_products
    FROM warehouse_products wp
    LEFT JOIN warehouses w ON wp.warehouse_id = w.id
    LEFT JOIN branches b ON w.branch_id = b.id
    INNER JOIN products p ON p.id = wp.product_id AND p.state <> 0
    WHERE wp.active = 1
      AND (
        wp.company_id = :companyId
        OR (b.company_id = :companyId AND wp.company_id IS NULL)
      )
  `;
  
  const [uniqueResult] = await sequelize.query(uniqueProductsQuery, {
    replacements: { companyId },
    type: sequelize.QueryTypes.SELECT
  });
  
  totals.totalProducts = parseInt(uniqueResult?.unique_products, 10) || 0;

  return {
    summary: totals,
    productsByWarehouse
  };
},

  async create(body, options = {}) {
        logger.info('Datos recibidos arehouseproductrepository.create:');
    logger.info(JSON.stringify(body));
    const { product_id, warehouse_id, active, code, minimum_stock, company_id, branch_id, user_id } = body;
     try {
    return await WarehouseProduct.create({
      product_id,
      warehouse_id,
      active: active !== undefined ? active : true,
      code,
      minimum_stock: minimum_stock !== undefined ? minimum_stock : 5,
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
    const updatable = ['active', 'code', 'minimum_stock'];
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
        minimum_stock: options.minimum_stock !== undefined ? options.minimum_stock : 5,
        company_id: options.company_id,
        branch_id: options.branch_id,
        user_id: options.user_id
      }, options);
    }
    return record;
  },

  async getProductAndWarehouseData(productId, warehouseId) {
    const [product, warehouseProduct] = await Promise.all([
      Product.findByPk(productId),
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
