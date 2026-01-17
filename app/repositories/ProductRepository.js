const { Product, ProductVariant, ProductAttribute, Attribute, sequelize } = require("../models");
const { Op } = require("sequelize");
const logger = require("../../config/logger");
const ImageService = require("../services/ImageService");
const WarehouseProductRepository = require("./WarehouseProductRepository");
const DEFAULT_IMAGE = "products/default.jpg";

const ProductRepository = {
  async findFiltered({ companyId, userId, branchId, categoryId, brand, state, hasGtin }) {
    const where = { };
    if (categoryId !== undefined) where.category_id = categoryId;
    if (brand !== undefined && brand !== '') where.brand = brand;
    if (state !== undefined) where.state = state;
    if (hasGtin === true) where.gtin = { [Op.not]: null };
    if (hasGtin === false) where.gtin = null;

    const products = await Product.findAll({
      where,
      attributes: [
        "id", "sku", "name", "description",
        "category_id", "user_id", "company_id",
        "brand", "model", "condition", "gtin", "mpn",
        "attributes", "warranty_months", "warranty_text",
        "weight_grams", "length_cm", "width_cm", "height_cm",
        "images", "sync_meta", "state"
      ],
      include: [
        {
          model: ProductVariant,
          as: 'variants',
          attributes: ['id', 'sku', 'attributes', 'image']
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

      const processedVariants = (Array.isArray(product.variants) ? product.variants : []).map(variant => {
    let attributesObj = {};
    try {
      // Intentar parsear la cadena JSON
      attributesObj = typeof variant.attributes === 'string' ? JSON.parse(variant.attributes) : variant.attributes;
    } catch (error) {
      console.error('Error parsing variant attributes:', error);
      // Si falla, dejarlo como objeto vacío o manejarlo según tu lógica
      attributesObj = {};
    }
    return {
      ...variant,
      attributes: attributesObj // Reemplazar la cadena por el objeto
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
        images: Array.isArray(product.images) ? product.images : JSON.parse(product.images || "[]"),
        sync_meta: product.sync_meta || {},
        variants: processedVariants,
        warehouses: productToWarehousesMap[product.id] || []
      };
    });
  },

  async findById(id) {
    return await Product.findByPk(id, {
      include: [
        {
          model: ProductVariant,
          as: 'variants',
          attributes: ['id', 'sku', 'attributes', 'image']
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
        category_id: body.category_id || null,
        user_id: body.user_id || null,
        company_id: body.company_id || null,
        sync_meta: body.sync_meta || {}
      };

      const product = await Product.create(productData, options);

      if (files?.length > 0) {
        const imagePaths = [];
        for (const file of files) {
          if (file?.originalname) {
            const newFilename = ImageService.generateFilename(
              "products",
              `${product.id}_${Date.now()}`,
              file.originalname
            );
            const filePath = await ImageService.moveFile(file, newFilename);
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
      let finalImages = Array.isArray(product.images) ? [...product.images] : [];
      
      if (body.images !== undefined) {
        finalImages = Array.isArray(body.images) ? [...body.images] : [];
      }

      if (files?.length > 0) {
        for (const file of files) {
          if (file?.originalname) {
            const newFilename = ImageService.generateFilename(
              "products",
              `${product.id}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
              file.originalname
            );
            const filePath = await ImageService.moveFile(file, newFilename);
            finalImages.push(filePath);
          }
        }
      }
      
      const fieldsToUpdate = [
        "sku", "name", "description", "category_id",
        "user_id", "company_id",
        "brand", "model", "condition", "gtin", "mpn", "warranty_months", "warranty_text",
        "weight_grams", "length_cm", "width_cm", "height_cm",
        "sync_meta", "state"
      ];

      const updatedData = {};
      for (const key of fieldsToUpdate) {
        if (body[key] !== undefined) updatedData[key] = body[key];
      }
      updatedData.images = finalImages;
      
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
          await ImageService.deleteFile(imagePath);
        }
      }
    }
    return await product.destroy();
  },

  async changeState(product, state){
    await product.update({state: state});
  },

async existsBySku(sku, excludeId = null) {
  try {
    console.log('Verificando SKU:', sku);
    
    if (!sku || typeof sku !== 'string' || sku.trim() === '') {
      console.log('SKU inválido o vacío');
      return false;
    }
    
    const cleanSku = sku.trim();
    
    // Usar el método estático del modelo
    const exists = await Product.skuExists(cleanSku, excludeId);
    console.log('SKU existe?', exists);
    
    return exists;
    
  } catch (error) {
    console.error('Error en existsBySku:', error);
    
    // Fallback: consulta directa más simple
    try {
      const count = await sequelize.query(
        'SELECT COUNT(*) as count FROM products WHERE sku = ?',
        {
          replacements: [sku],
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