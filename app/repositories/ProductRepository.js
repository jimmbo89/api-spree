const { Product, ProductVariant, ProductAttribute, Attribute, VariantValue, VariantDefinition, sequelize } = require("../models");
const { Op } = require("sequelize");
const logger = require("../../config/logger");
const WarehouseProductRepository = require("./WarehouseProductRepository");
const FileService = require("../services/FileService");
const { generateImageVersion } = require("../util/imageCacheUtils");
const DEFAULT_IMAGE = "products/default.jpg";
const path = require("path");
const fs = require("fs");
const { UPLOAD_BASE_PATH } = require("../../config/upload");

const ProductRepository = {
  async findFiltered({ companyId, userId, branchId, categoryId, brand, state, hasGtin, productId }) {
    const where = { };
    
    // ✅ FILTRAR POR EMPRESA (obligatorio para seguridad)
    if (companyId !== undefined && companyId !== null) {
      where.company_id = companyId;
    }
    
    if (categoryId !== undefined) where.category_id = categoryId;
    if (brand !== undefined && brand !== '') where.brand = brand;
    if (state !== undefined) where.state = state;
    if (hasGtin === true) where.gtin = { [Op.not]: null };
    if (hasGtin === false) where.gtin = null;
    if (productId) {
    if (Array.isArray(productId)) {
      where.id = { [Op.in]: productId };
    } else {
      where.id = productId;
    }
  }

    const products = await Product.findAll({
      where,
      attributes: [
        "id", "sku", "name", "description",
        "category_id", "user_id", "company_id",
        "brand", "model", "condition", "gtin", "mpn",
        "attributes", "warranty_months", "warranty_text",
        "weight_grams", "length_cm", "width_cm", "height_cm",
        "product_measurements", "packaging_measurements",
        "images", "sync_meta", "state",
        "purchase_price", "sale_price"
      ],
      include: [
        {
          model: ProductVariant,
          as: 'variants',
          attributes: ['id', 'sku', 'attributes', 'image'],
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
          attributes: ['id', 'name'] // Solo necesitamos el nombre del atributo
        }]
      }
      ]
    });

    // Definir los arrays de mapeo
    const productStatus = [
      { id: 0, name: 'Inactivo', key: 'inactive' },
      { id: 1, name: 'Activo', key: 'active' },
      { id: 2, name: 'Archivado', key: 'archived' }
    ];

    const conditions = [
      { id: "new", name: "Nuevo" },
      { id: "used", name: "Usado" },
      { id: "refurbished", name: "Reacondicionado" },
      { id: "not_specified", name: "No especificado" }
    ];

    const productIds = products.map(p => p.id);
    const commonCompanyId = companyId;

    let productToWarehousesMap = {};

  if (productIds.length > 0) {
  try {
    const warehouseMap = await WarehouseProductRepository.getProductWarehousesWithStock({
      productIds,
      companyId: companyId,   // ← usa el parámetro original
      branchId: branchId      // ← no uses commonCompanyId=1 fijo
    });
    productToWarehousesMap = warehouseMap;
  } catch (error) {
    logger.error('Error al cargar almacenes de productos:', error);
  }
}
    logger.info('almacenes asociados');
    logger.info(JSON.stringify(productToWarehousesMap));
    return products.map(product => {
      // Buscar el status correspondiente
      const statusMatch = productStatus.find(s => s.id === product.status);

      // Buscar la condición correspondiente
      const conditionMatch = conditions.find(c => c.id === product.condition);

      // ⭐ Crear mapa de precios y stock por variant_id desde warehouses
      const warehouses = productToWarehousesMap[product.id] || [];
      const variantPricesMap = {};
      const variantStockMap = {};

      for (const warehouse of warehouses) {
        if (warehouse.variants && warehouse.variants.length > 0) {
          for (const wv of warehouse.variants) {
            if (!variantPricesMap[wv.variant_id]) {
              variantPricesMap[wv.variant_id] = {
                price: wv.price,
                purchase_price: wv.purchase_price,
                promotional_price: wv.promotional_price
              };
            }
            
            // ⭐ Acumular stock por variante (sumando de todos los warehouses)
            if (!variantStockMap[wv.variant_id]) {
              variantStockMap[wv.variant_id] = 0;
            }
            variantStockMap[wv.variant_id] += parseInt(wv.stock) || 0;
          }
        }
      }

      // Procesar variantes con atributos y agregar precios y stock
      const processedVariants = (Array.isArray(product.variants) ? product.variants : []).map(variant => {
        let attributesObj = {};
        try {
          attributesObj = typeof variant.attributes === 'string' ? JSON.parse(variant.attributes) : variant.attributes;
        } catch (error) {
          attributesObj = {};
        }

        // ⭐ Agregar precios si existen para esta variante
        const priceData = variantPricesMap[variant.id];
        
        // ⭐ Agregar stock total de la variante (sumado de todos los warehouses)
        const totalStock = variantStockMap[variant.id] || 0;

        const variantValues = Array.isArray(variant.variantValues)
          ? variant.variantValues.map(v => ({
            id: v.id,
            name: v.name,
            code: v.code,
            variant_definition_id: v.variant_definition_id,
            definition: v.definition ? { id: v.definition.id, name: v.definition.name } : null
          }))
          : [];

        variantValues.sort((a, b) => {
          if (a.variant_definition_id !== b.variant_definition_id) {
            return a.variant_definition_id - b.variant_definition_id;
          }
          return a.id - b.id;
        });

        // ⭐ Crear variant_label similar a /warehouse-products-not-in-warehouse
        const variantLabel = variantValues.map(vv => vv.name).filter(Boolean).join(" / ");

        return {
          id: variant.id,
          sku: variant.sku,
          attributes: attributesObj,
          image: variant.image,
          variant_values: variantValues,
          variant_label: variantLabel,
          stock: totalStock,  // ⭐ Stock total de la variante
          ...(priceData ? {
            price: priceData.price,
            purchase_price: priceData.purchase_price,
            promotional_price: priceData.promotional_price
          } : {})
        };
      });

    const realAttributes = [];
    if (Array.isArray(product.productAttributes)) {
      for (const pa of product.productAttributes) {
        if (pa.attribute) {
          realAttributes.push({
            id: pa.id,                     // ID de la relación product_attributes
            attribute_id: pa.attribute.id, // ID del atributo (tabla attributes)
            name: pa.attribute.name,       // Nombre del atributo
            value: pa.value                // Valor asignado
          });
        }
      }
    }

    // Procesar imágenes con versión para caché
    const images = Array.isArray(product.images) ? product.images : JSON.parse(product.images || "[]");
    const imagesWithVersion = images.map(img => {
      try {
        // Construir ruta completa del archivo
        const filename = path.basename(img);
        const filepath = path.join(UPLOAD_BASE_PATH, 'products', filename);
        
        // Generar versión basada en mtime del archivo
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

      // ⭐ Calcular stock total del producto (sumando todas las variantes)
      const totalProductStock = Object.values(variantStockMap).reduce((sum, stock) => sum + stock, 0);

      return {
        id: product.id,
        sku: product.sku,
        name: product.name,
        description: product.description,
        category_id: product.category_id,
        user_id: product.user_id,
        company_id: product.company_id,
        brand: product.brand,
        model: product.model,
        state: product.state,
        condition: product.condition,
        conditionValue: conditionMatch ? conditionMatch.name : product.condition,
        gtin: product.gtin,
        mpn: product.mpn,
        attributes: realAttributes,
        warranty_months: product.warranty_months,
        warranty_text: product.warranty_text,
        weight_grams: product.weight_grams,
        length_cm: product.length_cm,
        width_cm: product.width_cm,
        height_cm: product.height_cm,
        product_measurements: product.product_measurements || {},
        packaging_measurements: product.packaging_measurements || {},
        images: images,
        images_with_version: imagesWithVersion,
        image_version: imagesWithVersion[0]?.version || null,
        purchase_price: product.purchase_price,
        sale_price: product.sale_price,
        sync_meta: product.sync_meta || {},
        stock: totalProductStock,  // ⭐ Stock total del producto (suma de todas las variantes)
        variants: processedVariants,
        warehouses: productToWarehousesMap[product.id] || []
      };
    });
  },

  async findById(id) {
    return await Product.findByPk(id, {
      attributes: [
        'id', 'sku', 'name', 'description',
        'category_id', 'user_id', 'company_id',
        'brand', 'model', 'condition', 'gtin', 'mpn',
        'attributes', 'warranty_months', 'warranty_text',
        'weight_grams', 'length_cm', 'width_cm', 'height_cm',
        'product_measurements', 'packaging_measurements',
        'images', 'sync_meta', 'state',
        'purchase_price', 'sale_price'
      ],
      include: [
        {
          model: ProductVariant,
          as: 'variants',
          attributes: ['id', 'sku', 'attributes', 'image'],
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
        }
      ]
    });
  },

  /**
   * Obtiene múltiples productos por sus IDs
   * @param {Array} ids - Array de IDs de productos
   * @returns {Array} Lista de productos encontrados
   */
  async findByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }

    return await Product.findAll({
      where: {
        id: { [Op.in]: ids }
      },
      attributes: [
        'id', 'sku', 'name', 'description',
        'category_id', 'user_id', 'company_id',
        'brand', 'model', 'condition', 'gtin', 'mpn',
        'attributes', 'warranty_months', 'warranty_text',
        'weight_grams', 'length_cm', 'width_cm', 'height_cm',
        'product_measurements', 'packaging_measurements',
        'images', 'sync_meta', 'state',
        'purchase_price', 'sale_price'
      ],
      include: [
        {
          model: ProductVariant,
          as: 'variants',
          attributes: ['id', 'sku', 'attributes', 'image'],
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
        }
      ]
    });
  },

  async create(body, files = [], options = {}) {
    try {
      const productData = {
        sku: body.sku,
        name: body.name,
        description: body.description || null,
        brand: body.brand || 'Generico',
        model: body.model || null,
        state: body.state || 1,
        condition: body.condition || 'new',
        gtin: body.gtin || null,
        mpn: body.mpn || null,
        warranty_months: body.warranty_months || null,
        warranty_text: body.warranty_text || null,
        weight_grams: body.weight_grams || null,
        length_cm: body.length_cm || null,
        width_cm: body.width_cm || null,
        height_cm: body.height_cm || null,
        product_measurements: body.product_measurements || {},
        packaging_measurements: body.packaging_measurements || {},
        category_id: body.category_id || null,
        user_id: body.user_id || null,
        company_id: body.company_id || null,
        sync_meta: body.sync_meta || {},
        purchase_price: body.purchase_price || null,
        sale_price: body.sale_price || null
      };

      const product = await Product.create(productData, options);

      if (files?.length > 0) {
        const imagePaths = [];
        for (const file of files) {
          if (file?.originalname) {
            const newFilename = await FileService.generateFilename(
              "products",
              `${product.id}_${Date.now()}`,
              file.originalname
            );
            const filePath = await FileService.moveFile(file, newFilename);
            imagePaths.push(filePath);
          }
        }
        if (imagePaths.length > 0) {
          await product.update({ images: imagePaths }, options);
        }
      }

      logger.info(`Producto creado: ${product.name} (ID: ${product.id}, SKU: ${product.sku})`);
      return product;
    } catch (error) {
      logger.error("Error en ProductRepository->create:", error);
      throw new Error(`Error al crear producto: ${error.message}`);
    }
  },

  async update(product, body, files = []) {
    try {
      let currentImages = [];
      if (Array.isArray(product.images)) {
        currentImages = [...product.images];
      } else if (typeof product.images === 'string') {
        try {
          const parsedImages = JSON.parse(product.images);
          currentImages = Array.isArray(parsedImages) ? parsedImages : [];
        } catch (error) {
          logger.warn(`[ProductRepository] No se pudo parsear images de producto ${product.id}: ${error.message}`);
        }
      }

      let finalImages = [...currentImages];
      const hasImageChanges =
        Array.isArray(files) && files.length > 0 ||
        body.images_order !== undefined ||
        body.images_to_remove !== undefined ||
        body.images !== undefined;

      // 👇 LÓGICA DE ELIMINACIÓN (solo si NO viene images_order)
      // Si viene images_order, el frontend ya excluyó las imágenes a eliminar
      if (body.images_to_remove && !body.images_order) {
        const namesToRemove = Array.isArray(body.images_to_remove)
          ? body.images_to_remove
          : (typeof body.images_to_remove === 'string' ? JSON.parse(body.images_to_remove) : []);

        if (Array.isArray(namesToRemove)) {
          const validToRemove = namesToRemove.filter(name =>
            finalImages.includes(name) && name !== DEFAULT_IMAGE
          );
          if (validToRemove.length > 0) {
            finalImages = finalImages.filter(img => !validToRemove.includes(img));
          }
        }
      }

      // 👇 Subir nuevas imágenes y generar filenames
      let newImagePaths = [];
      if (files?.length > 0) {
        for (const file of files) {
          if (file?.originalname) {
            const newFilename = await FileService.generateFilename(
              "products",
              `${product.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              file.originalname
            );
            const filePath = await FileService.moveFile(file, newFilename);
            newImagePaths.push(filePath);
          }
        }
      }

      // 👇 ORDENAMIENTO: si el frontend envía images_order, lo usamos como fuente de verdad
      if (body.images_order && Array.isArray(body.images_order)) {
        const PLACEHOLDER = '__NEW__';
        // Contar cuántos placeholders hay
        const placeholderCount = body.images_order.filter(item => item === PLACEHOLDER).length;

        // Debe coincidir con la cantidad de nuevas imágenes subidas
        if (placeholderCount !== newImagePaths.length) {
          throw new Error(`images_order tiene ${placeholderCount} placeholder(s) "__NEW__" pero se subieron ${newImagePaths.length} imagen(es) nueva(s)`);
        }

        // Reemplazar cada "__NEW__" secuencialmente con los nombres generados
        let newIdx = 0;
        finalImages = body.images_order.map(item => {
          if (item === PLACEHOLDER) {
            return newImagePaths[newIdx++];
          }
          return item;
        });

        logger.info(`[ProductRepository] Imágenes finales ordenadas:`, JSON.stringify(finalImages));
      } else {
        // Fallback: comportamiento actual (nuevas imágenes al final)
        if (newImagePaths.length > 0) {
          finalImages = [...finalImages, ...newImagePaths];
        }
      }

      const fieldsToUpdate = [
        "sku", "name", "description", "category_id",
        "user_id", "company_id",
        "brand", "model", "condition", "gtin", "mpn", "warranty_months", "warranty_text",
        "weight_grams", "length_cm", "width_cm", "height_cm",
        "product_measurements", "packaging_measurements",
        "sync_meta", "state",
        "purchase_price", "sale_price"
      ];

      const updatedData = {};
      for (const key of fieldsToUpdate) {
        if (body[key] !== undefined) updatedData[key] = body[key];
      }
      if (hasImageChanges) {
        updatedData.images = finalImages;
      }

      await product.update(updatedData);
      logger.info(`Producto actualizado (ID: ${product.id})`);
      return product;
    } catch (error) {
      logger.error(`Error en ProductRepository->update (ID: ${product.id}):`, error);
      throw new Error(`Error al actualizar producto: ${error.message}`);
    }
  },

  async updateAttributes(product, attributes, options = {}) {

    try {

      // Actualizar solo el campo attributes
      await product.update({ attributes }, options);

      return product;
    } catch (error) {
      logger.error("Error in ProductRepository.updateAttributes:", error);
      throw error;
    }
  },
  async delete(product) {
    if (Array.isArray(product.images)) {
      for (const imagePath of product.images) {
        if (imagePath && imagePath !== DEFAULT_IMAGE) {
          await FileService.deleteFile(imagePath);
        }
      }
    }
    return await product.destroy();
  },

  async changeState(product, state){
    await product.update({state: state});
  },

async existsBySku(sku, companyId = null, excludeId = null) {
  try {
    if (!sku || typeof sku !== 'string' || sku.trim() === '') {
      console.log('SKU inválido o vacío');
      return false;
    }

    const cleanSku = sku.trim();

    // ✅ Usar el método estático del modelo con company_id
    const exists = await Product.skuExists(cleanSku, companyId, excludeId);

    return exists;

  } catch (error) {
    console.error('Error en existsBySku:', error);

    // Fallback: consulta directa más simple
    try {
      const whereConditions = ['sku = ?'];
      const replacements = [sku];
      
      if (companyId) {
        whereConditions.push('company_id = ?');
        replacements.push(companyId);
      }
      
      const count = await sequelize.query(
        `SELECT COUNT(*) as count FROM products WHERE ${whereConditions.join(' AND ')}`,
        {
          replacements,
          type: sequelize.QueryTypes.SELECT
        }
      );

      return count[0].count > 0;
    } catch (fallbackError) {
      console.error('Error en fallback query:', fallbackError);
      throw error; // Relanzar el error original
    }
  }
},

  async findBySku(sku) {
    return await Product.findOne({ where: { sku } });
  },

  async findBySku(sku) {
    return await Product.findOne({ where: { sku } });
  },

  async findBySkus(skus) {
    return await Product.findAll({ where: { sku: skus } });
  },

  async findByBrand(brand, companyId = null) {
    const where = { brand };
    if (companyId) where.company_id = companyId;
    return await Product.findAll({
      where,
      attributes: ['id', 'sku', 'name', 'brand', 'model', 'base_price']
    });
  },

  async validateForMarketplace(productIds, marketplaceType) {
    const products = await Product.findAll({
      where: { id: productIds },
      attributes: ['id', 'sku', 'name', 'brand', 'condition', 'gtin', 'attributes']
    });

    const results = products.map(product => {
      const validation = product.hasMinimumMarketplaceData();
      return {
        product_id: product.id,
        sku: product.sku,
        name: product.name,
        valid: validation.valid,
        missing_fields: validation.missing,
        marketplace_ready: validation.valid && 
          (marketplaceType === 'mercadolibre' ? !!product.brand && !!product.gtin : true)
      };
    });
    return results;
  }
};

module.exports = ProductRepository;
