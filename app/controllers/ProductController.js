// controllers/ProductController.js
const logger = require("../../config/logger");
const {
  ProductRepository,
  ProductVariantRepository,
  CompanyRepository,
  UserRepository,
  BranchRepository,
  ProductCategoryRepository,
  LogRepository,
  WarehouseRepository,
  WarehouseProductRepository,
  WarehouseProductVariantRepository,
  AttributeRepository,
  ProductAttributeRepository,
} = require("../repositories");
const { sequelize } = require("../models");
const MarketplaceTransformer = require("../services/MarketplaceTransformer");
const { detectChanges } = require("../util/auditUtils");
const { getRequestMetadata } = require("../util/requestUtil");
const FileService = require("../services/FileService");
const DEFAULT_IMAGE = "products/default.jpg";

// Campos auditables (sin base_price, status, branch_id)
const PRODUCT_AUDIT_FIELDS = [
  "sku",
  "name",
  "description",
  "category_id",
  "user_id",
  "company_id",
  "brand",
  "model",
  "condition",
  "gtin",
  "mpn",
  "attributes",
  "warranty_months",
  "warranty_text",
  "weight_grams",
  "length_cm",
  "width_cm",
  "height_cm",
  "sync_meta",
];

const ProductController = {
  async list(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Lista productos`);
    const { company_id, user_id, branch_id, category_id, brand, state, has_gtin } =
      req.body;

    if (company_id) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) return res.status(400).json({ msg: "companyNotFound" });
    }
    if (user_id) {
      const user = await UserRepository.findById(user_id);
      if (!user) return res.status(400).json({ msg: "userNotFound" });
    }
    if (branch_id) {
      const branch = await BranchRepository.findById(branch_id);
      if (!branch) return res.status(400).json({ msg: "branchNotFound" });
    }
    if (category_id) {
      const category = await ProductCategoryRepository.findById(category_id);
      if (!category) return res.status(400).json({ msg: "categoryNotFound" });
    }

    try {
      const products = await ProductRepository.findFiltered({
        companyId: company_id,
        userId: user_id,
        branchId: branch_id,
        categoryId: category_id,
        brand,
        state: state,
        hasGtin: has_gtin,
      });
      res
        .status(200)
        .json({
          products: products.length ? products : [],
          message: products.length
            ? "Productos encontrtados"
            : "NoProductsFound",
        });
    } catch (error) {
      logger.error("ProductController->list: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },

  async getProductMetadata(req, res) {
    const userName = req.user?.name || "Anonymous";
    logger.info(`${userName} - Solicita metadata de productos`);
    const { company_id, branch_id, user_id, state, type } = req.body;

    try {
      const categories = await ProductCategoryRepository.findActive();
      const conditions = [
        { id: "new", name: "Nuevo" },
        { id: "used", name: "Usado" },
        { id: "refurbished", name: "Reacondicionado" },
        { id: "not_specified", name: "No especificado" },
      ];
      const warehouses = await WarehouseRepository.findFiltered({
        company_id,
        branch_id,
        user_id,
        state,
        type,
      });

      const attributes = await AttributeRepository.findAll();

      return res.status(200).json({
        productcategories: categories,
        conditions,
        warehouses,
        attributes
      });
    } catch (err) {
      logger.error("ProductController->getProductMetadata: " + err.message);
      return res
        .status(500)
        .json({ error: "ServerError", details: err.message });
    }
  },
  async store(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Crea nuevo producto`);
    logger.info("Datos recibidos del producto:");
    logger.info(JSON.stringify(req.body));

    const {
      company_id,
      user_id: bodyUserId,
      product_variants,
      warehouse_config,
      category_id,
      sku,
    } = req.body;
    const user_id = bodyUserId || req.user.id;
    req.body.user_id = user_id;

    // Validar company_id
    if (!company_id) {
      return res.status(400).json({
        success: false,
        msg: "company_id es obligatorio",
      });
    }

    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(400).json({
        success: false,
        msg: "companyNotFound",
      });
    }

    const plan = company.plan;
if (plan?.max_products !== undefined && plan.max_products !== -1) {
  const currentProductCount = await WarehouseProductRepository.countUniqueProductsByCompanyId(company_id);
  
  if (currentProductCount >= plan.max_products) {
    return res.status(403).json({
      success: false,
      code: 'PLAN_LIMIT_REACHED',
      message: "Has alcanzado el límite máximo de productos permitidos por tu plan. Actualiza tu plan para agregar más.",
      limit: plan.max_products,
      current: currentProductCount
    });
  }
}

    // Validar categoría
    if (category_id) {
      const category = await ProductCategoryRepository.findById(category_id);
      if (!category) {
        return res.status(400).json({
          success: false,
          msg: "categoryNotFound",
        });
      }
    }

    // Validar SKU
    if (!sku || sku.trim() === "") {
      return res.status(400).json({
        success: false,
        msg: "El SKU es obligatorio",
      });
    }

    if (await ProductRepository.existsBySku(sku)) {
      return res.status(400).json({
        success: false,
        msg: "skuAlreadyExists",
      });
    }

    // Normalizar atributos técnicos
    /*let attributes = [];
    if (req.body.attributes) {
      if (typeof req.body.attributes === "string") {
        try {
          attributes = JSON.parse(req.body.attributes);
        } catch (e) {
          return res.status(400).json({
            success: false,
            msg: "attributesInvalidJSON",
          });
        }
      } else if (Array.isArray(req.body.attributes)) {
        attributes = req.body.attributes;
      }
    }
    req.body.attributes = attributes;*/
    let productAttributes = [];
    if (req.body.attributes) {
      if (typeof req.body.attributes === "string") {
        try {
          productAttributes = JSON.parse(req.body.attributes);
        } catch (e) {
          return res.status(400).json({
            success: false,
            msg: "attributesInvalidJSON",
          });
        }
      } else if (Array.isArray(req.body.attributes)) {
        productAttributes = req.body.attributes;
      }
    }
    // Normalizar variantes de producto
    let parsedProductVariants = [];
    if (product_variants) {
      try {
        parsedProductVariants = JSON.parse(product_variants);
        if (!Array.isArray(parsedProductVariants)) {
          return res.status(400).json({
            success: false,
            msg: "product_variants debe ser un array",
          });
        }
      } catch (e) {
        return res.status(400).json({
          success: false,
          msg: "product_variantsInvalidJSON",
        });
      }
    }

    // Normalizar configuración de almacenes
    let parsedWarehouseConfig = [];
    if (warehouse_config) {
      try {
        parsedWarehouseConfig = JSON.parse(warehouse_config);
        if (!Array.isArray(parsedWarehouseConfig)) {
          return res.status(400).json({
            success: false,
            msg: "warehouse_config debe ser un array",
          });
        }
      } catch (e) {
        return res.status(400).json({
          success: false,
          msg: "warehouse_configInvalidJSON",
        });
      }
    }

    const files =
      req.files && Array.isArray(req.files.images) ? req.files.images : [];
    let transaction;

    try {
      transaction = await sequelize.transaction();

      // Crear producto principal
      const product = await ProductRepository.create(req.body, files, {
        transaction,
      });

      // Guardar en product_attributes
      if (productAttributes.length > 0) {
        for (const attr of productAttributes) {
          await ProductAttributeRepository.create({
            product_id: product.id,
            attribute_id: attr.attribute_id,
            value: String(attr.value)
          }, { transaction });
        }
      }
      // Crear variantes de producto y guardar sus referencias
      const createdVariants = [];

      if (parsedProductVariants.length > 0) {
        for (const variantData of parsedProductVariants) {
          const variant = await ProductVariantRepository.create(
            {
              product_id: product.id,
              sku: variantData.sku || `${product.sku}-${variantData.id}`,
              attributes: variantData.attributes || {},
            },
            { transaction }
          );

          createdVariants.push({
            id: variant.id,
            frontend_id: variantData.id || createdVariants.length,
            sku: variant.sku,
          });

          logger.info(`Variante creada: ${variant.sku} (ID: ${variant.id})`);
        }
      } else {
        // Si no hay variantes, crear una por defecto
        const defaultVariant = await ProductVariantRepository.create(
          {
            product_id: product.id,
            sku: product.sku,
            attributes: {},
          },
          { transaction }
        );

        createdVariants.push({
          id: defaultVariant.id,
          frontend_id: 0,
          sku: defaultVariant.sku,
        });

        logger.info(
          `Variante por defecto creada: ${defaultVariant.sku} (ID: ${defaultVariant.id})`
        );
      }

      // Asociar con almacenes si hay configuración
      if (parsedWarehouseConfig.length > 0) {
        logger.info(
          `Configurando ${parsedWarehouseConfig.length} almacenes...`
        );

        for (const whConfig of parsedWarehouseConfig) {
          logger.info(`Procesando almacén ID: ${whConfig.warehouse_id}`);

          const warehouse = await WarehouseRepository.findById(
            whConfig.warehouse_id
          );
          if (!warehouse) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              msg: `Warehouse ${whConfig.warehouse_id} no encontrado`,
            });
          }

          // Crear relación producto-almacén
          const wp = await WarehouseProductRepository.create(
            {
              product_id: product.id,
              warehouse_id: warehouse.id,
              active: whConfig.active !== false,
              code: whConfig.code || null,
              company_id: warehouse.company_id,
              branch_id: warehouse.branch_id,
              user_id,
            },
            { transaction }
          );

          logger.info(
            `WarehouseProduct creado ID: ${wp.id} para almacén ${warehouse.name}`
          );

          // Configurar cada variante en el almacén
          if (whConfig.variants && Array.isArray(whConfig.variants)) {
            logger.info(
              `Configurando ${whConfig.variants.length} variantes para almacén ${warehouse.name}`
            );

            for (let i = 0; i < whConfig.variants.length; i++) {
              const variantConfig = whConfig.variants[i];

              // Buscar la variante correspondiente por índice
              const variant = createdVariants[i];

              if (variant) {
                await WarehouseProductVariantRepository.create(
                  {
                    warehouse_product_id: wp.id,
                    variant_id: variant.id,
                    active: variantConfig.active !== false,
                    local_sku: variantConfig.local_sku || null,
                    price: parseFloat(variantConfig.price) || 0,
                    stock: parseInt(variantConfig.stock) || 0,
                  },
                  { transaction }
                );

                logger.info(
                  `WarehouseProductVariant creado: variante ${variant.sku} (ID: ${variant.id}) para almacén ${warehouse.name}`
                );
              } else {
                logger.warn(
                  `No se encontró variante para índice ${i} en almacén ${warehouse.name}`
                );

                // Crear variante faltante por defecto
                const missingVariant = await ProductVariantRepository.create(
                  {
                    product_id: product.id,
                    sku: `${product.sku}-wh${warehouse.id}-${i}`,
                    attributes: {},
                  },
                  { transaction }
                );

                await WarehouseProductVariantRepository.create(
                  {
                    warehouse_product_id: wp.id,
                    variant_id: missingVariant.id,
                    active: variantConfig.active !== false,
                    local_sku: variantConfig.local_sku || null,
                    price: parseFloat(variantConfig.price) || 0,
                    stock: parseInt(variantConfig.stock) || 0,
                  },
                  { transaction }
                );

                logger.info(`Variante faltante creada: ${missingVariant.sku}`);
              }
            }
          } else {
            logger.info(
              `No hay variantes configuradas para almacén ${warehouse.name}`
            );

            // Si no hay variantes configuradas, usar la primera variante por defecto
            if (createdVariants.length > 0) {
              const defaultVariant = createdVariants[0];
              await WarehouseProductVariantRepository.create(
                {
                  warehouse_product_id: wp.id,
                  variant_id: defaultVariant.id,
                  active: true,
                  local_sku: null,
                  price: 0,
                  stock: 0,
                },
                { transaction }
              );

              logger.info(
                `Usando variante por defecto ${defaultVariant.sku} para almacén ${warehouse.name}`
              );
            }
          }
        }
      } else {
        logger.info("No hay configuración de almacenes para este producto");
      }

      await transaction.commit();

      logger.info(
        `Producto ${product.name} creado exitosamente con ID: ${product.id}`
      );

      // Obtener productos actualizados
      const products = await ProductRepository.findFiltered({
        companyId: company_id,
        userId: null,
        branch_id: product.branch_id
      });

      res.status(201).json({
        success: true,
        message: "Producto creado correctamente",
        data: product,
        products,
      });
    } catch (error) {
      if (transaction) await transaction.rollback();
      logger.error("ProductController->store - Error: " + error.message);
      logger.error("Stack: " + error.stack);
      res.status(500).json({
        success: false,
        error: "ServerError",
        details: error.message,
      });
    }
  },
  async show(req, res) {
    try {
      const product = await ProductRepository.findById(req.body.id);
      if (!product) return res.status(404).json({ msg: "ProductNotFound" });

      res.status(200).json({ product });
    } catch (error) {
      logger.error("ProductController->show: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },

 async update(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Actualiza producto ${req.body.id}`
    );
    logger.info("Datos recibidos del producto:");
    logger.info(JSON.stringify(req.body));

    const { id, images_to_remove, product_variants } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const product = await ProductRepository.findById(id);
      if (!product) return res.status(404).json({ msg: "ProductNotFound" });

      // Parsear atributos e imágenes
      let productAttributes = null;
      if (req.body.attributes !== undefined) {
        if (typeof req.body.attributes === "string") {
          try {
            productAttributes = JSON.parse(req.body.attributes);
          } catch (e) {
            return res.status(400).json({
              success: false,
              msg: "attributesInvalidJSON",
            });
          }
        } else if (Array.isArray(req.body.attributes)) {
          productAttributes = req.body.attributes;
        }

        // Validar estructura
        for (const attr of productAttributes) {
          if (!attr.attribute_id || attr.value === undefined) {
            return res.status(400).json({
              success: false,
              msg: "Cada atributo debe tener attribute_id y value",
            });
          }
        }
      }
      if (req.body.images && typeof req.body.images === "string") {
        req.body.images = JSON.parse(req.body.images);
      }
      if (images_to_remove) {
        const namesToRemove = 
          typeof images_to_remove === 'string' 
            ? JSON.parse(images_to_remove) 
            : images_to_remove;

        // Validar que sean strings
        if (!Array.isArray(namesToRemove) || !namesToRemove.every(name => typeof name === 'string')) {
          return res.status(400).json({ 
            success: false, 
            error: "InvalidImagesRemove", 
            message: "images_to_remove debe ser un array de nombres de archivos" 
          });
        }

        const currentImages = Array.isArray(product.images) ? [...product.images] : [];

        // Eliminar archivos físicos
        for (const filename of namesToRemove) {
          if (currentImages.includes(filename) && filename !== DEFAULT_IMAGE) {
            await FileService.deleteFile(filename);
          }
        }

        // Actualizar el array de imágenes (quitar los nombres especificados)
        req.body.images = currentImages.filter(img => !namesToRemove.includes(img));

        // Si no se envió req.body.images, usar el filtrado
        if (req.body.images === undefined) {
          req.body.images = currentImages.filter(img => !namesToRemove.includes(img));
        }
      }
      // Validar relaciones
      if (req.body.company_id) {
        const company = await CompanyRepository.findById(req.body.company_id);
        if (!company) return res.status(400).json({ msg: "companyNotFound" });
      }
      if (req.body.user_id) {
        const user = await UserRepository.findById(req.body.user_id);
        if (!user) return res.status(400).json({ msg: "userNotFound" });
      }
      if (req.body.category_id !== undefined && req.body.category_id !== null) {
        const category = await ProductCategoryRepository.findById(
          req.body.category_id
        );
        if (!category) return res.status(400).json({ msg: "categoryNotFound" });
      }
      if (req.body.sku && req.body.sku !== product.sku) {
        if (await ProductRepository.existsBySku(req.body.sku, product.id)) {
          return res.status(400).json({ msg: "skuAlreadyExists" });
        }
      }

      let transaction;
      try {
        transaction = await sequelize.transaction();
        const files =
          req.files && Array.isArray(req.files.images) ? req.files.images : [];
        // 1. Actualizar el producto principal
        const updated = await ProductRepository.update(
          product,
          req.body,
          files,
          { transaction }
        );

        if (productAttributes !== null) {
        const existingAttrs = await ProductAttributeRepository.findByProductId(product.id);
        const existingMap = new Map(existingAttrs.map(a => [a.id, a]));

        // Actualizar/crear
        for (const attr of productAttributes) {
          if (attr.id && existingMap.has(attr.id)) {
            const existing = existingMap.get(attr.id);
            await existing.update({
              attribute_id: attr.attribute_id,
              value: String(attr.value)
            }, { transaction });
            existingMap.delete(attr.id);
          } else {
            await ProductAttributeRepository.create({
              product_id: product.id,
              attribute_id: attr.attribute_id,
              value: String(attr.value)
            }, { transaction });
          }
        }

        // Eliminar sobrantes
        for (const attr of existingMap.values()) {
          await attr.destroy({ transaction });
        }
      }
        // 2. Sincronizar variantes globales (si se envían)
        if (product_variants) {
          const parsedVariants = JSON.parse(product_variants);
          if (Array.isArray(parsedVariants)) {
            // 1. Obtener variantes existentes del producto
            const existingVariants =
              await ProductVariantRepository.findByProductId(id);
            const existingById = new Map(); // si el frontend envía ID de variante
            const existingBySku = new Map(); // SKU es único → mejor clave
            const existingByAttrs = new Map(); // fallback (pero problemático)

            for (const v of existingVariants) {
              // existingById.set(v.id, v);       // solo si usas ID real (no del frontend)
              existingBySku.set(v.sku, v);
              existingByAttrs.set(JSON.stringify(v.attributes), v);
            }

            // 2. Actualizar o crear variantes
            for (const variantData of parsedVariants) {
              let existing = null;

              // Opción 1: si el frontend envía un ID de variante real (no recomendado si es solo índice)
              // if (variantData.id && !isNaN(variantData.id)) {
              //   existing = existingById.get(Number(variantData.id));
              // }

              // Opción 2: buscar por SKU (¡el más confiable!)
              if (variantData.sku) {
                existing = existingBySku.get(variantData.sku);
              }

              // Opción 3: fallback por atributos (solo si no hay SKU)
              if (!existing && variantData.attributes) {
                const attrKey = JSON.stringify(variantData.attributes);
                existing = existingByAttrs.get(attrKey);
              }

              if (existing) {
                // Actualizar solo si hay cambios
                const updates = {};
                if (variantData.sku && existing.sku !== variantData.sku) {
                  updates.sku = variantData.sku;
                }
                if (
                  variantData.attributes &&
                  JSON.stringify(existing.attributes) !==
                    JSON.stringify(variantData.attributes)
                ) {
                  updates.attributes = variantData.attributes;
                }
                if (Object.keys(updates).length > 0) {
                  await existing.update(updates, { transaction });
                  // Si el SKU cambió, actualiza el mapa
                  if (updates.sku) {
                    existingBySku.delete(existing.sku);
                    existingBySku.set(updates.sku, existing);
                  }
                }
              } else {
                // Crear nueva variante
                await ProductVariantRepository.create(
                  {
                    product_id: product.id, // usa el ID validado
                    sku: variantData.sku,
                    attributes: variantData.attributes || {},
                  },
                  { transaction }
                );
              }
            }

            // 3. ✅ Eliminar variantes que ya NO están en el array (¡sincronización completa!)
            const newSkus = new Set(parsedVariants.map((v) => v.sku));
            for (const existing of existingVariants) {
              if (!newSkus.has(existing.sku)) {
                // ⚠️ Aquí podrías validar stock, pero si decides forzar:
                await existing.destroy({ transaction });
              }
            }
          }
        }

        await transaction.commit();

        const fieldChanges = detectChanges(
          { ...product.get({ plain: true }) },
          updated.get({ plain: true }),
          PRODUCT_AUDIT_FIELDS
        );

        await LogRepository.create({
          user_id: metadata.user_id,
          action: "product.update",
          description: `Producto actualizado: ${fieldChanges.length} campo(s) modificados`,
          ip_address: metadata.ip_address,
          user_agent: metadata.user_agent,
          status: "success",
          meta: { changes: fieldChanges },
        });

        const products = await ProductRepository.findFiltered({
          companyId: updated.company_id,
        });
        res
          .status(200)
          .json({ success: true, message: "Producto actualizado correctamente", products });
      } catch (error) {
        if (transaction) await transaction.rollback();
        throw error;
      }
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "product.update",
        description: `Error al actualizar producto ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error",
      });
      logger.error("ProductController->update: " + error.message);
      res.status(500).json({ success: false, error: "ServerError", details: error.message });
    }
  },

  async assignWarehouse(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Asignando producto a almacenes`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify(req.body));

  const { product_id, company_id, warehouse_config } = req.body;

  
  // ✅ Parsear warehouse_config si es una cadena
  if (typeof warehouse_config === 'string') {
    try {
      warehouse_config = JSON.parse(warehouse_config);
    } catch (e) {
      return res.status(400).json({
        success: false,
        msg: "warehouse_config no es un JSON válido"
      });
    }
  }

  if (!Array.isArray(warehouse_config)) {
    return res.status(400).json({
      success: false,
      msg: "warehouse_config debe ser un array"
    });
  }

  // Validar producto
  const product = await ProductRepository.findById(product_id);
  if (!product) {
    return res.status(404).json({ success: false, msg: "productNotFound" });
  }

  // Obtener variantes reales del producto
  const productVariants = await ProductVariantRepository.findByProductId(product_id);
  if (!productVariants || productVariants.length === 0) {
    return res.status(400).json({ success: false, msg: "El producto no tiene variantes definidas" });
  }

  let transaction;
  try {
    transaction = await sequelize.transaction();

    for (const whConfig of warehouse_config) {
      const warehouse = await WarehouseRepository.findById(whConfig.warehouse_id);
      // Buscar o crear WarehouseProduct
      let wp = await WarehouseProductRepository.findByProductAndWarehouse(product_id, whConfig.warehouse_id);
      if (!wp) {
        wp = await WarehouseProductRepository.create(
          {
            product_id,
            warehouse_id: warehouse.id,
            active: whConfig.active !== false,
            code: whConfig.code || null,
            company_id: warehouse.company_id,
            branch_id: warehouse.branch_id,
            user_id: req.user.id,
          },
          { transaction }
        );
      } else {
        await WarehouseProductRepository.update(
          wp,
          {
            active: whConfig.active !== false,
            code: whConfig.code || wp.code,
          },
          { transaction }
        );
      }
      // Procesar variantes (sin eliminar las existentes)
      if (whConfig.variants && Array.isArray(whConfig.variants)) {
        for (let i = 0; i < whConfig.variants.length; i++) {
          const variantConfig = whConfig.variants[i];
          const productVariant = productVariants[i];

          // Buscar si ya existe la variante en este almacén
          let wpv = await WarehouseProductVariantRepository.findByWarehouseProductIdAndVariantId(
            wp.id,
            productVariant.id
          );

          const variantData = {
            warehouse_product_id: wp.id,
            variant_id: productVariant.id,
            active: variantConfig.active !== false,
            local_sku: variantConfig.local_sku || null,
            price: parseFloat(variantConfig.price) || 0,
            stock: parseInt(variantConfig.stock) || 0,
          };

          if (wpv) {
            // 🔄 Actualizar
            await WarehouseProductVariantRepository.update(wpv, variantData, { transaction });
          } else {
            // ➕ Crear
            await WarehouseProductVariantRepository.create(variantData, { transaction });
          }
        }
      }
    }

    await transaction.commit();

    res.status(200).json({
      success: true,
      message: "Producto asignado a almacenes correctamente"
    });
  } catch (error) {
    if (transaction) await transaction.rollback();
    logger.error("ProductController->assignWarehouse - Error:", error);
    res.status(500).json({
      success: false,
      error: "ServerError",
      details: error.message
    });
  }
},
  async updateAttributes(req, res) {
  const { id, attributes } = req.body;

  const product = await ProductRepository.findById(id);
    if (!product) {
      return res.status(404).json({ success: false, message: "Producto no encontrado" });
    }
  if (!Array.isArray(attributes)) {
    return res.status(400).json({ success: false, message: "attributes debe ser un array" });
  }

  try {

    const updatedProduct = await ProductRepository.updateAttributes(product, attributes);

    return res.status(200).json({
      success: true,
      message: "Atributos actualizados",
       data: { id: product.id, attributes: product.attributes }
    });

  } catch (error) {
    logger.error("Error al actualizar atributos:", error);
    return res.status(500).json({ success: false, message: "Error interno" });
  }
},
  async destroy(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Elimina producto con ID ${req.body.id}`
    );
    const metadata = getRequestMetadata(req);

    try {
      const product = await ProductRepository.findById(req.body.id);
      if (!product) return res.status(404).json({ msg: "ProductNotFound" });

      await ProductRepository.delete(product);
      await LogRepository.create({
        user_id: metadata.user_id,
        action: "product.delete",
        description: `Producto eliminado: ID ${product.id}, nombre: "${product.name}", SKU: "${product.sku}"`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: "success",
      });

      const products = await ProductRepository.findFiltered({
        companyId: product.company_id,
        userId: product.user_id,
      });
      res
        .status(200)
        .json({ message: "Producto eliminado correctamente", products });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "product.delete",
        description: `Error al eliminar producto ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error",
      });
      logger.error("ProductController->destroy: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },

  async updateState(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Actualiza estado del producto con ID ${req.body.id}`
    );
      logger.info("Datos recibidos:");
  logger.info(JSON.stringify(req.body));
    const { id, state } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const product = await ProductRepository.findById(req.body.id);
      if (!product) return res.status(404).json({ msg: "ProductNotFound" });

      await ProductRepository.changeState(product, state);
      await LogRepository.create({
        user_id: metadata.user_id,
        action: "product.state",
        description: `Producto Actualizado: ID ${product.id}, nombre: "${product.name}", SKU: "${product.sku}"`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: "success",
      });

      const products = await ProductRepository.findFiltered({
        companyId: product.company_id
      });
      res
        .status(200)
        .json({ status: "success", message: "“Producto archivado correctamente. Su historial se conserva.”", products });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "product.delete",
        description: `Error al eliminar producto ID ${req.body?.id}: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error",
      });
      logger.error("ProductController->destroy: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },

  async transformForMarketplace(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Transformar productos para marketplace`
    );
    const { products, marketplace_id } = req.body;
    if (!marketplace_id)
      return res.status(400).json({ msg: "marketplace_id es obligatorio" });
    if (!Array.isArray(products) || products.length === 0)
      return res
        .status(400)
        .json({ msg: "Debe proporcionar al menos un producto" });

    try {
      const transformed = await MarketplaceTransformer.transformProducts(
        products,
        marketplace_id
      );
      res
        .status(200)
        .json({ success: true, transformed_products: transformed });
    } catch (error) {
      logger.error(
        "ProductController->transformForMarketplace: " + error.message
      );
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },
};

module.exports = ProductController;
