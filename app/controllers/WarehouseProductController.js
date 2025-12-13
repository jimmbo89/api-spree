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
} = require("../repositories");
const fs = require("fs").promises;
const { detectChanges } = require("../util/auditUtils");
const { getRequestMetadata } = require("../util/requestUtil");

const WarehouseProductController = {
  async list(req, res) {
    logger.info(`${req.user?.name || "Unknown"} - Lista warehouse_products`);
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
      res.status(200).json({ warehouse_products: records });
    } catch (error) {
      logger.error("WarehouseProductController->list: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },

  async getProductsNotInWarehouse(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Obtiene productos no en almacén`
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
    logger.info(
      `${req.user?.name || "Unknown"} - Actualiza warehouse_product ${
        req.body.id
      }`
    );
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

  async transfer(req, res) {
    logger.info(
      `${req.user?.name || "Unknown"} - Transfiere stock entre almacenes`
    );
    const { product_id, from_warehouse_id, to_warehouse_id, quantity } =
      req.body;
    const user_id = req.user.id;
    let transaction;

    try {
      if (from_warehouse_id === to_warehouse_id) {
        return res
          .status(400)
          .json({ msg: "Los almacenes deben ser distintos" });
      }
      if (!Number.isInteger(quantity) || quantity <= 0) {
        return res
          .status(400)
          .json({ msg: "quantity debe ser entero positivo" });
      }

      transaction = await sequelize.transaction();

      const fromWh = await WarehouseRepository.findById(from_warehouse_id);
      const toWh = await WarehouseRepository.findById(to_warehouse_id);
      const product = await ProductRepository.findById(product_id);
      if (!fromWh || !toWh || !product) {
        await transaction.rollback();
        return res.status(400).json({ msg: "Datos inválidos" });
      }

      const fromWp = await WarehouseProductRepository.findByProductAndWarehouse(
        product_id,
        from_warehouse_id
      );
      if (!fromWp) {
        await transaction.rollback();
        return res
          .status(400)
          .json({ msg: "Producto no existe en almacén origen" });
      }

      const fromWpvs =
        await WarehouseProductVariantRepository.findByWarehouseProductId(
          fromWp.id
        );
      const totalStock = fromWpvs.reduce((sum, v) => sum + v.stock, 0);
      if (totalStock < quantity) {
        await transaction.rollback();
        return res
          .status(400)
          .json({
            msg: "stockInsufficient",
            available: totalStock,
            requested: quantity,
          });
      }

      // Distribuir reducción de stock
      let remaining = quantity;
      for (const wpv of fromWpvs) {
        if (remaining <= 0) break;
        const reduce = Math.min(wpv.stock, remaining);
        await WarehouseProductVariantRepository.update(
          wpv,
          { stock: wpv.stock - reduce },
          { transaction }
        );
        remaining -= reduce;
      }

      // Asegurar destino
      let toWp = await WarehouseProductRepository.findByProductAndWarehouse(
        product_id,
        to_warehouse_id
      );
      if (!toWp) {
        toWp = await WarehouseProductRepository.create(
          {
            product_id,
            warehouse_id: to_warehouse_id,
            active: true,
            company_id: toWh.company_id,
            branch_id: toWh.branch_id,
            user_id,
          },
          { transaction }
        );

        // Crear variante destino
        const globalVars = await ProductVariantRepository.findByProductId(
          product_id
        );
        for (const gv of globalVars) {
          await WarehouseProductVariantRepository.create(
            {
              warehouse_product_id: toWp.id,
              variant_id: gv.id,
              active: true,
              published: false,
              price: 0,
              stock: 0,
            },
            { transaction }
          );
        }
      }

      const toWpvs =
        await WarehouseProductVariantRepository.findByWarehouseProductId(
          toWp.id
        );
      let added = 0;
      for (const wpv of toWpvs) {
        if (added >= quantity) break;
        const add = Math.min(quantity - added, 1000); // simple distribución
        await WarehouseProductVariantRepository.update(
          wpv,
          { stock: wpv.stock + add },
          { transaction }
        );
        added += add;
      }

      await transaction.commit();
      res
        .status(200)
        .json({
          message: "Transferencia realizada",
          from: from_warehouse_id,
          to: to_warehouse_id,
        });
    } catch (error) {
      if (transaction) await transaction.rollback();
      logger.error("WarehouseProductController->transfer: " + error.message);
      res.status(500).json({ error: "ServerError", details: error.message });
    }
  },
};

module.exports = WarehouseProductController;
