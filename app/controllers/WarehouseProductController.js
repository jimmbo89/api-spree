// controllers/WarehouseProductController.js
const logger = require("../../config/logger");
const { sequelize } = require("../models");
const {
  WarehouseProductRepository,
  WarehouseProductVariantRepository,
  ProductRepository,
  ProductVariantRepository,
  WarehouseRepository,
  CompanyRepository,
  UserRepository,
  BranchRepository,
  LogRepository,
  InventoryMovementRepository,
} = require("../repositories");
const fs = require("fs").promises;
const { getRequestMetadata } = require("../util/requestUtil");
const { getUserId } = require("../../config/context");
const { v4: uuidv4 } = require('uuid');

const WarehouseProductController = {
  async list(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Lista warehouse_products`);
    logger.info(`Datos recibidos: \n ${JSON.stringify(req.body)}`);
    const { company_id, user_id, branch_id, warehouse_id } = req.body;

    if (company_id && !(await CompanyRepository.findById(company_id))) {
      return res.status(400).json({ msg: "companyNotFound" });
    }
    if (user_id && !(await UserRepository.findById(user_id))) {
      return res.status(400).json({ msg: "userNotFound" });
    }
    if (branch_id && !(await BranchRepository.findById(branch_id))) {
      return res.status(400).json({ msg: "branchNotFound" });
    }
    if (warehouse_id && !(await WarehouseRepository.findById(warehouse_id))) {
      return res.status(400).json({ msg: "warehouseNotFound" });
    }

    try {
      const records = await WarehouseProductRepository.findFiltered({
        companyId: company_id,
        userId: user_id,
        branchId: branch_id,
        warehouseId: warehouse_id,
      });
        logger.info(`company_id: ${company_id}`);
      const sumary = await WarehouseProductRepository.getWarehouseSummaryByCompanyId(company_id);
      res.status(200).json({ warehouse_products: records, sumary });
    } catch (error) {
      logger.error("WarehouseProductController->list: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },

  async listByWarehouseIds(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Lista warehouse_products en publicación`);
    logger.info('Alamacenes recibidos')
    logger.info(JSON.stringify(req.body))
  const { company_id, warehouse_ids } = req.body;

  try {
    // Validar que la compañía exista (opcional, pero recomendado)
    const companyExists = await CompanyRepository.findById(company_id);
    if (!companyExists) {
      return res.status(400).json({ msg: "companyNotFound" });
    }

    const invalidIds = [];
    for (const wid of warehouse_ids) {
      const exists = await WarehouseRepository.findById(wid);
      if (!exists) invalidIds.push(wid);
    }
    if (invalidIds.length > 0) {
      return res.status(400).json({ msg: "Algunos warehouse_ids no existen", invalid: invalidIds });
    }

    // Obtener y consolidar
    const consolidatedProducts = await WarehouseProductRepository.findProductsByWarehouseIds({
      companyId: company_id,
      warehouseIds: warehouse_ids
    });

    res.status(200).json({ success: true, products: consolidatedProducts });
  } catch (error) {
    logger.error("WarehouseProductController->listByWarehouseIds:", error);
    res.status(500).json({ success: false, error: "ServerError" });
  }
},

  async getProductsNotInWarehouse(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Obtiene productos del almacén`
    );
    const { warehouse_id, company_id, product_id } = req.body;
    try {
      if (company_id && !(await CompanyRepository.findById(company_id))) {
        return res.status(400).json({ msg: "companyNotFound" });
      }

      const products =
        await WarehouseProductRepository.findProductsNotInWarehouse({
          warehouseId: warehouse_id,
          companyId: company_id,
          specificProductId: product_id,
        });

      res.status(200).json({ success: true, products, count: products.length });
    } catch (error) {
      logger.error(
        "WarehouseProductController->getProductsNotInWarehouse: " +
          error.message
      );
      res
        .status(500)
        .json({ success: false, error: "ServerError", details: error.message });
    }
  },

  async show(req, res) {
    try {
      const record = await WarehouseProductRepository.findById(req.body.id);
      if (!record)
        return res.status(404).json({ msg: "WarehouseProductNotFound" });
      res.status(200).json({ warehouse_product: record });
    } catch (error) {
      logger.error("WarehouseProductController->show: " + error.message);
      res.status(500).json({ error: "ServerError" });
    }
  },
  async store(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Crea nuevo warehouse_product`
    );
    logger.info("Datos recibidos del warehouse_product:");
    logger.info(JSON.stringify(req.body));
    const {
      warehouse_id,
      product_id,
      active,
      code,
      variants: variantsString,
    } = req.body;
    const currentUserId = req.body.user_id || req.user.id;
    let transaction;

    try {
      transaction = await sequelize.transaction();

      // 👉 1. VALIDAR ALMACÉN
      const warehouse = await WarehouseRepository.findById(warehouse_id);
      if (!warehouse) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          msg: "warehouseNotFound",
        });
      }

      const productRecord = await ProductRepository.findById(product_id);
      if (!productRecord) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          msg: "productNotFound",
        });
      }

      logger.info(`WarehouseProduct antes de crear el warehouse_product`);
      // 👉 4. CREAR WAREHOUSE_PRODUCT
      const wp = await WarehouseProductRepository.create(
        {
          product_id: product_id,
          warehouse_id: warehouse.id,
          active: active !== false, // Default true
          code: code || null,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: currentUserId,
        },
        { transaction }
      );

      logger.info(`WarehouseProduct creado ID: ${wp.id}`);

      // 👉 5. PROCESAR VARIANTES
      let variantsData = [];
      if (variantsString) {
        try {
          variantsData = JSON.parse(variantsString);
          if (!Array.isArray(variantsData)) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              msg: "variants debe ser un array",
            });
          }
        } catch (e) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            msg: "variantsInvalidJSON",
          });
        }
      }

      if (variantsData.length > 0) {
        logger.info(`Procesando ${variantsData.length} variantes...`);

        for (const variantData of variantsData) {
          let variantId = variantData.variant_id;
          // Crear warehouse_product_variant
          await WarehouseProductVariantRepository.create(
            {
              warehouse_product_id: wp.id,
              variant_id: variantId,
              active: variantData.active !== false,
              published: variantData.published || false,
              local_sku: variantData.local_sku || null,
              price: parseFloat(variantData.price) || 0,
              promotional_price: variantData.promotional_price
                ? parseFloat(variantData.promotional_price)
                : null,
              stock: parseInt(variantData.stock) || 0,
            },
            { transaction }
          );

          logger.info(
            `WarehouseProductVariant creado para variant_id: ${variantId}`
          );
        }
      }

      await transaction.commit();

      // Log
      const metadata = getRequestMetadata(req);
      await LogRepository.create({
        user_id: metadata.user_id,
        action: "warehouse_product.create",
        description: `Creado: producto ${productRecord.sku} en almacén ${warehouse.name}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: "success",
      });
      const records = await WarehouseProductRepository.findFiltered({
        companyId: undefined,
        userId: undefined,
        branchId: undefined,
        warehouseId: warehouse_id,
      });
      res.status(201).json({
        success: true,
        message: "Producto agregado al almacén correctamente",
        warehouse_products: records,
      });
    } catch (error) {
      if (transaction) await transaction.rollback();
      logger.error(
        "WarehouseProductController->store - Error: " + error.message
      );
      logger.error("Stack: " + error.stack);

      // Manejar error de validación de Sequelize
      if (error.name === "SequelizeValidationError") {
        const errors = error.errors.map((err) => ({
          field: err.path,
          message: err.message,
        }));

        // 👇 Agrega esto para ver el error real
        logger.error("Error detallado:", {
          name: error.name,
          message: error.message,
          parent: error.parent?.message,
          sql: error.parent?.sql,
        });

        const metadata = getRequestMetadata(req);
        await LogRepository.create({
          user_id: metadata?.user_id,
          action: "warehouse_product.create",
          description: `Error de validación: ${JSON.stringify(errors)}`,
          ip_address: metadata?.ip_address,
          user_agent: metadata?.user_agent,
          status: "error",
        });

        return res.status(400).json({
          success: false,
          msg: "validationError",
          errors: errors,
        });
      }

      const metadata = getRequestMetadata(req);
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "warehouse_product.create",
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error",
      });

      if (error instanceof SyntaxError) {
        return res.status(400).json({
          success: false,
          msg: "invalidJson",
          error: "JSON inválido",
        });
      }

      res.status(500).json({
        success: false,
        msg: "serverError",
        error: "Error interno del servidor",
      });
    }
  },

  async update(req, res) {
    logger.info( `${req.user?.name || "Unknown"} - Actualiza warehouse_product ${ req.body.id }` );
    logger.info("Datos recibidos del warehouse_product:");
    logger.info(JSON.stringify(req.body));

    const { id, active, code, branch_id, variants: variantsString } = req.body;
    const metadata = getRequestMetadata(req);
    let transaction;

    try {
      transaction = await sequelize.transaction();

      // 👉 1. Validar que el warehouse_product exista
      let record = await WarehouseProductRepository.findById(id);
      if (!record) {
        await transaction.rollback();
        return res.status(404).json({ msg: "WarehouseProductNotFound" });
      }

      // 👉 2. Actualizar el registro principal (warehouse_products)
      record = await WarehouseProductRepository.update(record, req.body, {
        transaction,
      });

      // 👉 3. Procesar variantes solo si se envían
      if (variantsString) {
        let variantsData = [];
        try {
          variantsData = JSON.parse(variantsString);
          if (!Array.isArray(variantsData)) {
            await transaction.rollback();
            return res
              .status(400)
              .json({ success: false, msg: "variants debe ser un array" });
          }
        } catch (e) {
          await transaction.rollback();
          return res
            .status(400)
            .json({ success: false, msg: "variantsInvalidJSON" });
        }

        // 👉 4. Obtener variantes existentes en la BD para este warehouse_product
        const existingVariants =
          await WarehouseProductVariantRepository.findByWarehouseProductId(id);
        const existingById = new Map();
        existingVariants.forEach((v) => {
          existingById.set(v.id, v);
        });

        // Mapa para buscar por `variant_id` + `custom_name` (clave única para variantes personalizadas)
        const existingByKey = new Map();
        existingVariants.forEach((v) => {
          const key = v.variant_id
            ? `global-${v.variant_id}`
            : `custom-${v.custom_name || ""}`;
          existingByKey.set(key, v);
        });

        // 👉 5. Actualizar o crear variantes
        const processedIds = new Set();

        for (const variantData of variantsData) {
          const {
            id: variantClientId, // opcional, si viene del frontend
            variant_id,
            local_sku,
            stock,
            price,
            promotional_price,
            active: activeVariant = true,
            published = false,
            custom_name = null,
          } = variantData;

          // 🧠 Clave para identificar la variante
          const key = variant_id
            ? `global-${variant_id}`
            : `custom-${custom_name || ""}`;

          const existing = existingByKey.get(key);

          const variantToUpdate = {
            warehouse_product_id: record.id,
            variant_id: variant_id || null,
            local_sku: local_sku || null,
            stock: parseInt(stock) || 0,
            price: parseFloat(price) || 0,
            promotional_price: promotional_price
              ? parseFloat(promotional_price)
              : null,
            active: activeVariant !== false,
            published: published,
            custom_name: custom_name,
          };

          if (existing) {
            // ✅ ACTUALIZAR
            await existing.update(variantToUpdate, { transaction });
            processedIds.add(existing.id);
          } else {
            // ✅ CREAR (asociar nueva)
            const newVariant = await WarehouseProductVariantRepository.create(
              variantToUpdate,
              { transaction }
            );
            processedIds.add(newVariant.id);
          }
        }

        // 👉 6. ELIMINAR variantes que ya NO están en el payload
        for (const existing of existingVariants) {
          if (!processedIds.has(existing.id)) {
            await existing.destroy({ transaction });
          }
        }

        logger.info(
          `Variantes sincronizadas para warehouse_product ${id}: ${variantsData.length} enviadas, ${existingVariants.length} anteriores`
        );
      }
      await transaction.commit();

      const records = await WarehouseProductRepository.findFiltered({
        companyId: undefined,
        userId: undefined,
        branchId: undefined,
        warehouseId: record.warehouse_id,
      });

      // 👉 7. Log y respuesta
      await LogRepository.create({
        user_id: metadata.user_id,
        action: "warehouse_product.update",
        description: `Actualizado: warehouse_product ID ${record.id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: "success",
      });
      res.status(200).json({
        success: true,
        message: "Producto en almacén actualizado correctamente",
        warehouse_products: records,
      });
    } catch (error) {
      if (transaction) await transaction.rollback();

      logger.error("WarehouseProductController->update: " + error.message);
      logger.error("Error detallado:", {
        name: error.name,
        message: error.message,
        parent: error.parent?.message,
        stack: error.stack,
      });

      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "warehouse_product.update",
        description: `Error al actualizar: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error",
      });

      if (
        error.name === "SequelizeValidationError" ||
        error.name === "SequelizeUniqueConstraintError"
      ) {
        return res.status(400).json({
          success: false,
          msg: "ValidationError",
          details: error.message,
        });
      }

      res.status(500).json({
        success: false,
        msg: "ServerError",
        details: error.message,
      });
    }
  },
  async destroy(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Elimina warehouse_product con ID ${
        req.body.id
      }`
    );
    const metadata = getRequestMetadata(req);

    try {
      const record = await WarehouseProductRepository.findById(req.body.id);
      if (!record)
        return res.status(404).json({ msg: "WarehouseProductNotFound" });

      await WarehouseProductRepository.delete(record);
      await LogRepository.create({
        user_id: metadata.user_id,
        action: "warehouse_product.delete",
        description: `Eliminado: ID ${record.id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: "success",
      });

      res.status(200).json({ message: "Registro eliminado correctamente" });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: "warehouse_product.delete",
        description: `Error al eliminar: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: "error",
      });
      logger.error("WarehouseProductController->destroy: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },
  async createMovement(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Crea movimiento de inventario`);
  logger.info("Datos recibidos:", JSON.stringify(req.body));

  const {
    movement_type,           // 'entry', 'exit', 'transfer'
    origin_warehouse_id,     // Siempre requerido
    destination_warehouse_id, // Solo para 'transfer'
    product_id,
    variants,                // Array de variantes
    reason,
    notes
  } = req.body;

  const currentUserId = req.user.id;
  const referenceId = uuidv4();
  let transaction;

  try {
    transaction = await sequelize.transaction();

    // === Validar movimiento_type ===
    if (!['entry', 'exit', 'transfer'].includes(movement_type)) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Tipo de movimiento inválido" });
    }

    // === Validar que destino exista solo en transferencia ===
    if (movement_type === 'transfer' && !destination_warehouse_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Almacén de destino requerido para transferencia" });
    }
    if (movement_type !== 'transfer' && destination_warehouse_id) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Almacén de destino no permitido en entrada/salida" });
    }

    // === Validar almacenes y producto ===
    const originWarehouse = await WarehouseRepository.findById(origin_warehouse_id);
    if (!originWarehouse) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Almacén de origen no encontrado" });
    }

    let destWarehouse = null;
    if (movement_type === 'transfer') {
      destWarehouse = await WarehouseRepository.findById(destination_warehouse_id);
      if (!destWarehouse) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: "Almacén de destino no encontrado" });
      }
      if (origin_warehouse_id === destination_warehouse_id) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: "Origen y destino deben ser distintos" });
      }
    }

    const product = await ProductRepository.findById(product_id);
    if (!product) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Producto no encontrado" });
    }

    // === Asegurar warehouse_product en el almacén de origen ===
    let originWp = await WarehouseProductRepository.findByWarehouseAndProduct(origin_warehouse_id, product_id);
    if (!originWp) {
      originWp = await WarehouseProductRepository.create({
        product_id,
        warehouse_id: origin_warehouse_id,
        active: true,
        company_id: originWarehouse.company_id,
        branch_id: originWarehouse.branch_id,
        user_id: currentUserId
      }, { transaction });
    }

    // === Para transferencia: asegurar warehouse_product en destino ===
    let destWp = null;
    if (movement_type === 'transfer') {
      destWp = await WarehouseProductRepository.findByWarehouseAndProduct(destination_warehouse_id, product_id);
      if (!destWp) {
        destWp = await WarehouseProductRepository.create({
          product_id,
          warehouse_id: destination_warehouse_id,
          active: true,
          company_id: destWarehouse.company_id,
          branch_id: destWarehouse.branch_id,
          user_id: currentUserId
        }, { transaction });
      }
    }

    // === Cargar variantes actuales del origen (para validar stock en 'exit' y 'transfer') ===
    const originWpVariants = await WarehouseProductVariantRepository.findByWarehouseProductId(originWp.id);
    const originVariantMap = new Map(originWpVariants.map(v => [v.variant_id, v]));

    // === Procesar cada variante ===
    for (const variantData of variants) {
      const { 
        variant_id, 
        quantity,
        // Campos solo para 'entry'
        local_sku, 
        price, 
        promotional_price 
      } = variantData;

      if (!Number.isInteger(quantity) || quantity <= 0) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: `Cantidad inválida para variante ${variant_id}` });
      }

      // === VALIDACIONES POR TIPO ===
      let originVariant = null;
      let originalStockOrigin = 0;

      if (movement_type === 'exit' || movement_type === 'transfer') {
        originVariant = originVariantMap.get(variant_id);
        if (!originVariant) {
          await transaction.rollback();
          return res.status(400).json({ 
            success: false, 
            message: `Variante ${variant_id} no encontrada en el almacén de origen` 
          });
        }
        originalStockOrigin = originVariant.stock;
        if (originalStockOrigin < quantity) {
          await transaction.rollback();
          return res.status(400).json({ 
            success: false, 
            message: `Stock insuficiente para variante ${variant_id}` 
          });
        }
      }

      // === PROCESAR SEGÚN EL TIPO ===
      if (movement_type === 'entry') {
        const originCompanyId = await _resolveCompanyFromWarehouse(origin_warehouse_id);

        const alreadyAssociated = await WarehouseProductRepository.isProductAssociatedWithCompany(
          product_id,
          originCompanyId
        );

        if (!alreadyAssociated) {
    // Es un producto nuevo → verificar límite
    const company = await CompanyRepository.findById(originCompanyId);
    if (!company?.plan) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Plan no disponible" });
    }

    const currentCount = await WarehouseProductRepository.countUniqueProductsByCompanyId(originCompanyId);
    const maxProducts = company.plan.max_products;

    if (maxProducts !== -1 && currentCount >= maxProducts) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        code: 'PLAN_LIMIT_REACHED',
        message: "Has alcanzado el límite máximo de productos permitidos por tu plan. Actualiza tu plan para agregar más.",
        limit: maxProducts,
        current: currentCount
      });
    }
  }
        // --- ENTRADA: crear o actualizar variante en el MISMO almacén ---
        let wpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
          variant_id,
          originWp.id
        );

        let newStock, oldStock = 0;
        if (wpVariant) {
          // Ya existe: aumentar stock
          oldStock = wpVariant.stock;
          newStock = oldStock + quantity;
          await WarehouseProductVariantRepository.update(wpVariant, {
            stock: newStock,
            // Solo actualizar precio/SKU si se envían (para edición)
            ...(local_sku !== undefined && { local_sku }),
            ...(price !== undefined && { price }),
            ...(promotional_price !== undefined && { promotional_price }),
            active: true
          }, { transaction });
        } else {
          // No existe: crear nueva
          newStock = quantity;
          await WarehouseProductVariantRepository.create({
            warehouse_product_id: originWp.id,
            variant_id,
            stock: newStock,
            local_sku: local_sku || product.sku,
            price: price || product.base_price || 0,
            promotional_price: promotional_price || null,
            active: true,
            published: false
          }, { transaction });
        }

        // Registrar movimiento de entrada
        await InventoryMovementRepository.create({
          warehouse_id: origin_warehouse_id,
          product_id,
          variant_id,
          company_id: originWarehouse.company_id,
          branch_id: originWarehouse.branch_id,
          movement_type: 'entry',
          quantity,
          stock_before: oldStock,
          stock_after: newStock,
          unit_price: price || product.base_price || 0,
          total_value: (price || product.base_price || 0) * quantity,
          reference_type: 'manual',
          reference_id: referenceId,
          reason: reason.trim(),
          notes: notes?.trim() || null,
          user_id: currentUserId
        }, { transaction });

      } else if (movement_type === 'exit') {
        // --- SALIDA: reducir stock en el MISMO almacén ---
        const newStock = originalStockOrigin - quantity;
        const updateData = { stock: newStock };

        if (newStock === 0) {
          updateData.price = null;
          updateData.promotional_price = null;
          updateData.local_sku = null;
          updateData.active = false;
          updateData.published = false;
        }

        await WarehouseProductVariantRepository.update(
          originVariant,
          updateData,
          { transaction }
        );

        // Registrar movimiento de salida
        await InventoryMovementRepository.create({
          warehouse_id: origin_warehouse_id,
          product_id,
          variant_id,
          company_id: originWarehouse.company_id,
          branch_id: originWarehouse.branch_id,
          movement_type: 'exit',
          quantity,
          stock_before: originalStockOrigin,
          stock_after: newStock,
          unit_price: originVariant.price,
          total_value: originVariant.price ? originVariant.price * quantity : null,
          reference_type: 'manual',
          reference_id: referenceId,
          reason: reason.trim(),
          notes: notes?.trim() || null,
          user_id: currentUserId
        }, { transaction });

      } else if (movement_type === 'transfer') {
        // --- TRANSFERENCIA: mover entre almacenes (tu lógica actual) ---
        const newStockOrigin = originalStockOrigin - quantity;
        const updateDataOrigin = { stock: newStockOrigin };

        if (newStockOrigin === 0) {
          updateDataOrigin.price = null;
          updateDataOrigin.promotional_price = null;
          updateDataOrigin.local_sku = null;
          updateDataOrigin.active = false;
          updateDataOrigin.published = false;
        }

        await WarehouseProductVariantRepository.update(
          originVariant,
          updateDataOrigin,
          { transaction }
        );

        // Actualizar/crear en destino
        let destWpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
          variant_id,
          destWp.id
        );
        let oldStockDest = 0, newStockDest = 0;

        if (destWpVariant) {
          oldStockDest = destWpVariant.stock;
          newStockDest = oldStockDest + quantity;
          await WarehouseProductVariantRepository.update(
            destWpVariant,
            { stock: newStockDest },
            { transaction }
          );
        } else {
          oldStockDest = 0;
          newStockDest = quantity;
          await WarehouseProductVariantRepository.create({
            warehouse_product_id: destWp.id,
            variant_id,
            active: true,
            published: false,
            local_sku: originVariant.local_sku || null,
            price: originVariant.price || 0,
            promotional_price: originVariant.promotional_price,
            stock: newStockDest
          }, { transaction });
        }

        // Movimientos de transferencia
        const baseMovement = {
          product_id,
          variant_id,
          user_id: currentUserId,
          reason: reason.trim(),
          notes: notes?.trim() || null,
          reference_type: 'transfer',
          reference_id: referenceId,
          origin_warehouse_id,
          destination_warehouse_id
        };

        await InventoryMovementRepository.create({
          ...baseMovement,
          warehouse_id: origin_warehouse_id,
          company_id: originWarehouse.company_id,
          branch_id: originWarehouse.branch_id,
          movement_type: 'transfer_exit',
          quantity,
          stock_before: originalStockOrigin,
          stock_after: newStockOrigin,
          unit_price: originVariant.price,
          total_value: originVariant.price ? originVariant.price * quantity : null
        }, { transaction });

        await InventoryMovementRepository.create({
          ...baseMovement,
          warehouse_id: destination_warehouse_id,
          company_id: destWarehouse.company_id,
          branch_id: destWarehouse.branch_id,
          movement_type: 'transfer_entry',
          quantity,
          stock_before: oldStockDest,
          stock_after: newStockDest,
          unit_price: originVariant.price,
          total_value: originVariant.price ? originVariant.price * quantity : null
        }, { transaction });
      }
    }

    await transaction.commit();

    // === Registrar en log ===
    const metadata = getRequestMetadata(req);
    await LogRepository.create({
      user_id: metadata.user_id,
      action: "warehouse.movement.create",
      description: `${movement_type} completado para producto ${product.sku}`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: "success",
      extra: JSON.stringify({ reference_id: referenceId })
    });

    return res.status(200).json({
      success: true,
      message: "Movimiento registrado exitosamente",
      reference_id: referenceId
    });

  } catch (error) {
    if (transaction) await transaction.rollback();
    logger.error("Error en createMovement:", error);

    const metadata = getRequestMetadata(req);
    await LogRepository.create({
      user_id: metadata?.user_id,
      action: "warehouse.movement.create",
      description: `Error: ${error.message}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: "error"
    });

    return res.status(500).json({ success: false, message: "Error interno al registrar movimiento" });
  }
},
async createBulkMovement(req, res) {
  logger.info(`${req.user?.name || "Unknown"} - Crea movimiento masivo de inventario`);
  logger.info("Datos recibidos (bulk):", JSON.stringify(req.body));
  logger.info(JSON.stringify(req.body));

  const {
    movement_type,
    origin_warehouse_id,
    destination_warehouse_id,
    products, // [{ product_id, variants: [...] }]
    reason,
    notes
  } = req.body;

  const currentUserId = req.user.id;
  const referenceId = uuidv4();
  let transaction;

  try {
    transaction = await sequelize.transaction();

    // === Validaciones básicas ===
    await _validateMovementType(movement_type);
    await _validateDestinationConsistency(movement_type, destination_warehouse_id);

    // === Cargar almacenes y validar ===
    const originWarehouse = await WarehouseRepository.findById(origin_warehouse_id);
    if (!originWarehouse) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Almacén de origen no encontrado" });
    }

    let destWarehouse = null;
    if (movement_type === 'transfer') {
      destWarehouse = await WarehouseRepository.findById(destination_warehouse_id);
      if (!destWarehouse) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: "Almacén de destino no encontrado" });
      }
      if (origin_warehouse_id === destination_warehouse_id) {
        await transaction.rollback();
        return res.status(400).json({ success: false, message: "Origen y destino deben ser distintos" });
      }
    }

    if (movement_type === 'entry') {
  // Pre-validar todos los productos nuevos antes de procesar
  const originCompanyId = await _resolveCompanyFromWarehouse(origin_warehouse_id);

  let newProductsCount = 0;
  const newProductIds = [];

  for (const { product_id } of products) {
    const alreadyAssociated = await WarehouseProductRepository.isProductAssociatedWithCompany(
      product_id,
      originCompanyId
    );
    if (!alreadyAssociated) {
      newProductIds.push(product_id);
      newProductsCount++;
    }
  }

  if (newProductsCount > 0) {
    // Verificar límite global
    const company = await CompanyRepository.findById(originCompanyId);
    if (!company?.plan) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: "Plan no disponible" });
    }

    const currentCount = await WarehouseProductRepository.countUniqueProductsByCompanyId(originCompanyId);
    const maxProducts = company.plan.max_products;

    if (maxProducts !== -1 && (currentCount + newProductsCount) > maxProducts) {
      await transaction.rollback();
      return res.status(403).json({
        success: false,
        code: 'PLAN_LIMIT_REACHED',
        message: "Has alcanzado el límite máximo de productos permitidos por tu plan. Actualiza tu plan para agregar más.",
        limit: maxProducts,
        current: currentCount,
        requested: newProductsCount
      });
    }
  }
}
    // === Procesar cada producto ===
    for (const { product_id, variants } of products) {
      await _processProductMovement({
        movement_type,
        originWarehouse,
        destWarehouse,
        product_id,
        variants,
        reason,
        notes,
        currentUserId,
        referenceId,
        transaction
      });
    }

    await transaction.commit();

    // === Log ===
    const metadata = getRequestMetadata(req);
    await LogRepository.create({
      user_id: metadata.user_id,
      action: "warehouse.bulk_movement.create",
      description: `${movement_type} masivo completado`,
      ip_address: metadata.ip_address,
      user_agent: metadata.user_agent,
      status: "success",
      extra: JSON.stringify({ reference_id: referenceId })
    });

    return res.status(200).json({
      success: true,
      message: "Movimiento masivo registrado exitosamente",
      reference_id: referenceId
    });

  } catch (error) {
    if (transaction) await transaction.rollback();
    logger.error("Error en createBulkMovement:", error);

    const metadata = getRequestMetadata(req);
    await LogRepository.create({
      user_id: metadata?.user_id,
      action: "warehouse.bulk_movement.create",
      description: `Error: ${error.message}`,
      ip_address: metadata?.ip_address,
      user_agent: metadata?.user_agent,
      status: "error"
    });

    return res.status(500).json({ success: false, message: "Error interno al registrar movimiento masivo" });
  }
},

};

// === Submétodos privados ===
async function _resolveCompanyFromWarehouse(warehouseId) {
  const warehouse = await WarehouseRepository.findById(warehouseId);
  if (warehouse.company_id) {
    return warehouse.company_id;
  }

  if (warehouse.branch_id) {
    const branch = await BranchRepository.findById(warehouse.branch_id);
    if (!branch || !branch.company_id) {
      throw new Error('Sucursal sin compañía asociada');
    }
    return branch.company_id;
  }

  throw new Error('Almacén no asociado a compañía ni sucursal');
}
async function _validateMovementType(type) {
  if (!['entry', 'exit', 'transfer'].includes(type)) {
    throw new Error("Tipo de movimiento inválido");
  }
};

async function _validateDestinationConsistency(movement_type, destination_warehouse_id) {
  if (movement_type === 'transfer' && !destination_warehouse_id) {
    throw new Error("Almacén de destino requerido para transferencia");
  }
  if (movement_type !== 'transfer' && destination_warehouse_id) {
    throw new Error("Almacén de destino no permitido en entrada/salida");
  }
};
async function _processProductMovement({
  movement_type,
  originWarehouse,
  destWarehouse,
  product_id,
  variants,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  // === Validar producto ===
  const product = await ProductRepository.findById(product_id);
  if (!product) throw new Error(`Producto ${product_id} no encontrado`);

  // === Asegurar warehouse_product en origen ===
  let originWp = await WarehouseProductRepository.findByWarehouseAndProduct(
    originWarehouse.id,
    product_id
  );
  if (!originWp) {
    originWp = await WarehouseProductRepository.create({
      product_id,
      warehouse_id: originWarehouse.id,
      active: true,
      company_id: originWarehouse.company_id,
      branch_id: originWarehouse.branch_id,
      user_id: currentUserId
    }, { transaction });
  }

  // === Para transferencia: asegurar en destino ===
  let destWp = null;
  if (movement_type === 'transfer') {
    destWp = await WarehouseProductRepository.findByWarehouseAndProduct(
      destWarehouse.id,
      product_id
    );
    if (!destWp) {
      destWp = await WarehouseProductRepository.create({
        product_id,
        warehouse_id: destWarehouse.id,
        active: true,
        company_id: destWarehouse.company_id,
        branch_id: destWarehouse.branch_id,
        user_id: currentUserId
      }, { transaction });
    }
  }

  // === Cargar variantes actuales del origen (para validar stock) ===
  const originWpVariants = await WarehouseProductVariantRepository.findByWarehouseProductId(originWp.id);
  const originVariantMap = new Map(originWpVariants.map(v => [v.variant_id, v]));

  // === Procesar cada variante del producto ===
  for (const variantData of variants) {
    await _processVariantMovement({
      movement_type,
      originWarehouse,
      destWarehouse,
      product,
      originWp,
      destWp,
      originVariantMap,
      variantData,
      reason,
      notes,
      currentUserId,
      referenceId,
      transaction
    });
  }
};

async function _processVariantMovement({
  movement_type,
  originWarehouse,
  destWarehouse,
  product,
  originWp,
  destWp,
  originVariantMap,
  variantData,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  const { variant_id, quantity, local_sku, price, promotional_price } = variantData;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Cantidad inválida para variante ${variant_id}`);
  }

  let originVariant = null;
  let originalStockOrigin = 0;

  if (movement_type === 'exit' || movement_type === 'transfer') {
    originVariant = originVariantMap.get(variant_id);
    if (!originVariant) {
      throw new Error(`Variante ${variant_id} no encontrada en almacén de origen`);
    }
    originalStockOrigin = originVariant.stock;
    if (originalStockOrigin < quantity) {
      throw new Error(`Stock insuficiente para variante ${variant_id}`);
    }
  }

  if (movement_type === 'entry') {
    await _processEntry({
      originWp,
      variant_id,
      quantity,
      local_sku,
      price,
      promotional_price,
      product,
      originWarehouse,
      reason,
      notes,
      currentUserId,
      referenceId,
      transaction
    });
  } else if (movement_type === 'exit') {
    await _processExit({
      originVariant,
      quantity,
      originalStockOrigin,
      originWarehouse,
      product_id: product.id,
      variant_id,
      reason,
      notes,
      currentUserId,
      referenceId,
      transaction
    });
  } else if (movement_type === 'transfer') {
    await _processTransfer({
      originVariant,
      destWp,
      quantity,
      originalStockOrigin,
      originWarehouse,
      destWarehouse,
      product_id: product.id,
      variant_id,
      reason,
      notes,
      currentUserId,
      referenceId,
      transaction
    });
  }
};

// --- ENTRADA ---
async function _processEntry({
  originWp,
  variant_id,
  quantity,
  local_sku,
  price,
  promotional_price,
  product,
  originWarehouse,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  const wpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
    variant_id,
    originWp.id
  );

  let newStock, oldStock = 0;
  if (wpVariant) {
    oldStock = wpVariant.stock;
    newStock = oldStock + quantity;
    await WarehouseProductVariantRepository.update(wpVariant, {
      stock: newStock,
      ...(local_sku !== undefined && { local_sku }),
      ...(price !== undefined && { price }),
      ...(promotional_price !== undefined && { promotional_price }),
      active: true
    }, { transaction });
  } else {
    newStock = quantity;
    await WarehouseProductVariantRepository.create({
      warehouse_product_id: originWp.id,
      variant_id,
      stock: newStock,
      local_sku: local_sku || product.sku,
      price: price || product.base_price || 0,
      promotional_price: promotional_price || null,
      active: true,
      published: false
    }, { transaction });
  }

  await InventoryMovementRepository.create({
    warehouse_id: originWarehouse.id,
    product_id: product.id,
    variant_id,
    company_id: originWarehouse.company_id,
    branch_id: originWarehouse.branch_id,
    movement_type: 'entry',
    quantity,
    stock_before: oldStock,
    stock_after: newStock,
    unit_price: price || product.base_price || 0,
    total_value: (price || product.base_price || 0) * quantity,
    reference_type: 'manual',
    reference_id: referenceId,
    reason: reason.trim(),
    notes: notes?.trim() || null,
    user_id: currentUserId
  }, { transaction });
};

// --- SALIDA ---
async function _processExit({
  originVariant,
  quantity,
  originalStockOrigin,
  originWarehouse,
  product_id,
  variant_id,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  const newStock = originalStockOrigin - quantity;
  const updateData = { stock: newStock };

  if (newStock === 0) {
    updateData.price = null;
    updateData.promotional_price = null;
    updateData.local_sku = null;
    updateData.active = false;
    updateData.published = false;
  }

  await WarehouseProductVariantRepository.update(originVariant, updateData, { transaction });

  await InventoryMovementRepository.create({
    warehouse_id: originWarehouse.id,
    product_id,
    variant_id,
    company_id: originWarehouse.company_id,
    branch_id: originWarehouse.branch_id,
    movement_type: 'exit',
    quantity,
    stock_before: originalStockOrigin,
    stock_after: newStock,
    unit_price: originVariant.price,
    total_value: originVariant.price ? originVariant.price * quantity : null,
    reference_type: 'manual',
    reference_id: referenceId,
    reason: reason.trim(),
    notes: notes?.trim() || null,
    user_id: currentUserId
  }, { transaction });
};

// --- TRANSFERENCIA ---
async function _processTransfer({
  originVariant,
  destWp,
  quantity,
  originalStockOrigin,
  originWarehouse,
  destWarehouse,
  product_id,
  variant_id,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  const newStockOrigin = originalStockOrigin - quantity;
  const updateDataOrigin = { stock: newStockOrigin };
  if (newStockOrigin === 0) {
    updateDataOrigin.price = null;
    updateDataOrigin.promotional_price = null;
    updateDataOrigin.local_sku = null;
    updateDataOrigin.active = false;
    updateDataOrigin.published = false;
  }
  await WarehouseProductVariantRepository.update(originVariant, updateDataOrigin, { transaction });

  let destWpVariant = await WarehouseProductVariantRepository.findByVariantAndWarehouseProduct(
    variant_id,
    destWp.id
  );
  let oldStockDest = 0, newStockDest = 0;

  if (destWpVariant) {
    oldStockDest = destWpVariant.stock;
    newStockDest = oldStockDest + quantity;
    await WarehouseProductVariantRepository.update(destWpVariant, { stock: newStockDest }, { transaction });
  } else {
    oldStockDest = 0;
    newStockDest = quantity;
    await WarehouseProductVariantRepository.create({
      warehouse_product_id: destWp.id,
      variant_id,
      active: true,
      published: false,
      local_sku: originVariant.local_sku || null,
      price: originVariant.price || 0,
      promotional_price: originVariant.promotional_price,
      stock: newStockDest
    }, { transaction });
  }

  const baseMovement = {
    product_id,
    variant_id,
    user_id: currentUserId,
    reason: reason.trim(),
    notes: notes?.trim() || null,
    reference_type: 'transfer',
    reference_id: referenceId,
    origin_warehouse_id: originWarehouse.id,
    destination_warehouse_id: destWarehouse.id
  };

  await InventoryMovementRepository.create({
    ...baseMovement,
    warehouse_id: originWarehouse.id,
    company_id: originWarehouse.company_id,
    branch_id: originWarehouse.branch_id,
    movement_type: 'transfer_exit',
    quantity,
    stock_before: originalStockOrigin,
    stock_after: newStockOrigin,
    unit_price: originVariant.price,
    total_value: originVariant.price ? originVariant.price * quantity : null
  }, { transaction });

  await InventoryMovementRepository.create({
    ...baseMovement,
    warehouse_id: destWarehouse.id,
    company_id: destWarehouse.company_id,
    branch_id: destWarehouse.branch_id,
    movement_type: 'transfer_entry',
    quantity,
    stock_before: oldStockDest,
    stock_after: newStockDest,
    unit_price: originVariant.price,
    total_value: originVariant.price ? originVariant.price * quantity : null
  }, { transaction });
}

module.exports = WarehouseProductController;
