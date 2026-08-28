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
const AuditEventService = require("../services/AuditEventService");
const { detectChanges } = require("../util/auditUtils");

function toPlain(record) {
  if (!record) return null;
  return typeof record.get === "function" ? record.get({ plain: true }) : record;
}

function getWarehouseAuditLabel(warehouse) {
  const plain = toPlain(warehouse) || {};
  return [plain.code, plain.name].filter(Boolean).join(" / ") || "Almacén sin nombre";
}

function getProductAuditLabel(product) {
  const plain = toPlain(product) || {};
  return [plain.sku, plain.name].filter(Boolean).join(" / ") || "Producto sin nombre";
}

function getVariantAuditLabel(variant, variantData = {}) {
  const plain = toPlain(variant) || {};
  return [plain.sku, plain.internal_code || variantData.local_sku]
    .filter(Boolean)
    .join(" / ") || "Variante sin identificador";
}

function buildAddedWarehouseVariantAuditDetail(variant, variantData = {}) {
  return {
    variante: getVariantAuditLabel(variant, variantData),
    sku_local: variantData.local_sku || null,
    existencias_iniciales: Number(variantData.stock) || 0,
    precio_venta: Number(variantData.price) || 0,
    precio_compra: Number(variantData.purchase_price) || 0,
    precio_promocional: variantData.promotional_price ?? null,
    estado: variantData.active === false ? "Inactivo" : "Activo",
    publicar: variantData.published ? "Sí" : "No"
  };
}

function buildWarehouseAuditPayload(warehouse, data = {}) {
  const plain = toPlain(warehouse) || {};
  const companyId = data.company_id || plain.company_id;
  return {
    company_id: companyId,
    module: "warehouse",
    resource_type: "warehouse",
    resource_id: plain.id,
    resource_label: getWarehouseAuditLabel(plain),
    warehouse_id: plain.id,
    branch_id: plain.branch_id,
    ...data
  };
}

function changesToValueSnapshot(changes, valueKey) {
  return changes.reduce((snapshot, change) => {
    snapshot[change.field] = change[valueKey];
    return snapshot;
  }, {});
}

function getMovementAuditAction(movementType, isBulk = false) {
  if (isBulk && (movementType === "transfer" || movementType === "transfer_exit" || movementType === "transfer_entry")) {
    return "warehouse.bulk_transfer";
  }
  if (isBulk) return "warehouse.bulk_operation";
  if (movementType === "entry") return "warehouse.stock_entry";
  if (movementType === "exit") return "warehouse.stock_exit";
  if (movementType === "transfer" || movementType === "transfer_exit" || movementType === "transfer_entry") {
    return "warehouse.transfer";
  }
  return "warehouse.stock_adjustment";
}

function getMovementDescription(movement) {
  const type = movement.movement_type;
  const productName = movement.product?.name || `producto ${movement.product_id}`;

  if (type === "entry") return `Entrada de stock: ${productName}`;
  if (type === "exit") return `Salida de stock: ${productName}`;
  if (type === "transfer_exit") return `Transferencia de salida: ${productName}`;
  if (type === "transfer_entry") return `Transferencia de entrada: ${productName}`;
  return `Movimiento de inventario: ${productName}`;
}

async function recordMovementAuditEvents(req, referenceId, { isBulk = false } = {}) {
  const movements = await InventoryMovementRepository.findByReferenceId(referenceId);

  await Promise.all(movements.map(async (movement) => {
    const [warehouse, productRecord, originWarehouse, destinationWarehouse] = await Promise.all([
      WarehouseRepository.findById(movement.warehouse_id),
      movement.product_id ? ProductRepository.findById(movement.product_id) : null,
      movement.origin_warehouse_id ? WarehouseRepository.findById(movement.origin_warehouse_id) : null,
      movement.destination_warehouse_id ? WarehouseRepository.findById(movement.destination_warehouse_id) : null
    ]);
    if (!warehouse) return null;
    const companyId = warehouse.company_id || await _resolveCompanyFromWarehouse(warehouse.id);
    const productLabel = productRecord ? getProductAuditLabel(productRecord) : null;

    return AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
      company_id: companyId,
      action: getMovementAuditAction(movement.movement_type, isBulk),
      result: "success",
      related_resource_type: "inventory_movement",
      related_resource_id: movement.id,
      job_id: null,
      previous_value: { stock: movement.stock_before },
      new_value: { stock: movement.stock_after },
      changes: [{
        field: "stock",
        old_value: movement.stock_before,
        new_value: movement.stock_after
      }],
      description: getMovementDescription(movement),
      correlation_id: referenceId,
      metadata: {
        movement_type: movement.movement_type,
        product_label: productLabel,
        warehouse_label: getWarehouseAuditLabel(warehouse),
        source_warehouse_label: originWarehouse ? getWarehouseAuditLabel(originWarehouse) : null,
        destination_warehouse_label: destinationWarehouse ? getWarehouseAuditLabel(destinationWarehouse) : null,
        quantity: movement.quantity,
        reference_type: movement.reference_type,
        reason: movement.reason,
        notes: movement.notes,
        total_value: movement.total_value,
        transfer_side: movement.movement_type === "transfer_exit"
          ? "origin"
          : (movement.movement_type === "transfer_entry" ? "destination" : null),
        bulk: isBulk
      }
    }));
  }));
}

function normalizeVariantsInput(variants, { required = false } = {}) {
  if (variants === undefined || variants === null || variants === "") {
    if (required) {
      return { ok: false, variants: [], message: "variantsRequired" };
    }
    return { ok: true, variants: [] };
  }

  let parsed = variants;
  if (typeof variants === "string") {
    try {
      parsed = JSON.parse(variants);
    } catch (error) {
      return { ok: false, variants: [], message: "variantsInvalidJSON" };
    }
  }

  if (Array.isArray(parsed)) {
    if (required && parsed.length === 0) {
      return { ok: false, variants: [], message: "variantsRequired" };
    }
    return { ok: true, variants: parsed };
  }

  if (parsed && typeof parsed === "object") {
    return { ok: true, variants: [parsed] };
  }

  return { ok: false, variants: [], message: "variants debe ser un array" };
}

function normalizeWarehouseProductVariantPayload(variantData = {}) {
  const stock = variantData.stock ?? variantData.quantity;
  return {
    ...variantData,
    ...(stock !== undefined ? { stock } : {})
  };
}

function normalizeMovementVariantPayload(variantData = {}) {
  const quantity = variantData.quantity ?? variantData.stock;
  return {
    ...variantData,
    ...(quantity !== undefined ? { quantity: Number(quantity) } : {})
  };
}

function normalizeMoneyValue(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizeNullableMoneyValue(value) {
  if (value === undefined || value === null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameMoney(left, right) {
  return Math.abs(normalizeMoneyValue(left) - normalizeMoneyValue(right)) < 0.01;
}

function sameNullableMoney(left, right) {
  const normalizedLeft = normalizeNullableMoneyValue(left);
  const normalizedRight = normalizeNullableMoneyValue(right);
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft === normalizedRight;
  }
  return Math.abs(normalizedLeft - normalizedRight) < 0.01;
}

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

    const companyWarehouses = await WarehouseRepository.findFiltered({
      companyId: company_id,
      includeProducts: false
    });
    const validWarehouseIds = new Set(companyWarehouses.map((warehouse) => Number(warehouse.id)));

    const invalidIds = [];
    for (const wid of warehouse_ids) {
      if (!validWarehouseIds.has(Number(wid))) invalidIds.push(wid);
    }
    if (invalidIds.length > 0) {
      return res.status(400).json({
        msg: "Algunos warehouse_ids no existen o no pertenecen a la empresa",
        invalid: invalidIds
      });
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
      minimum_stock,
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
          minimum_stock: minimum_stock !== undefined ? parseInt(minimum_stock, 10) || 0 : 5,
          company_id: warehouse.company_id || null,
          branch_id: warehouse.branch_id || null,
          user_id: currentUserId,
        },
        { transaction }
      );

      logger.info(`WarehouseProduct creado ID: ${wp.id}`);

      // 👉 5. PROCESAR VARIANTES
      const normalizedVariants = normalizeVariantsInput(variantsString);
      if (!normalizedVariants.ok) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          msg: normalizedVariants.message,
        });
      }
      const variantsData = normalizedVariants.variants.map(normalizeWarehouseProductVariantPayload);
      const productVariants = await ProductVariantRepository.findByProductId(productRecord.id);
      const productVariantsById = new Map(
        productVariants.map((variant) => [Number(variant.id), variant])
      );
      const variantsAuditDetail = variantsData.map((variantData) =>
        buildAddedWarehouseVariantAuditDetail(
          productVariantsById.get(Number(variantData.variant_id)),
          variantData
        )
      );
      const initialStockTotal = variantsAuditDetail.reduce(
        (total, variant) => total + variant.existencias_iniciales,
        0
      );

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
              purchase_price: parseFloat(variantData.purchase_price) || 0,
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
      await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
        action: "warehouse.product_added",
        result: "success",
        related_resource_type: "product",
        related_resource_id: productRecord.id,
        new_value: {
          estado: wp.active ? "Activo" : "Inactivo",
          codigo_local: wp.code || null,
          stock_minimo: wp.minimum_stock
        },
        description: `Producto agregado al almacen: ${getProductAuditLabel(productRecord)}`,
        metadata: {
          product_label: getProductAuditLabel(productRecord),
          warehouse_label: getWarehouseAuditLabel(warehouse),
          warehouse_code: warehouse.code || null,
          variants_count: variantsData.length,
          initial_stock_total: initialStockTotal,
          variants_detail: variantsAuditDetail
        }
      }));
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

    const { id, active, code, branch_id, minimum_stock, variants: variantsString } = req.body;
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
      const previousRecord = toPlain(record);
      const warehouse = await WarehouseRepository.findById(record.warehouse_id);
      const productRecord = await ProductRepository.findById(record.product_id);

      // 👉 2. Actualizar el registro principal (warehouse_products)
      record = await WarehouseProductRepository.update(record, req.body, {
        transaction,
      });

      // 👉 3. Procesar variantes solo si se envían
      if (variantsString !== undefined && variantsString !== null && variantsString !== "") {
        const normalizedVariants = normalizeVariantsInput(variantsString);
        if (!normalizedVariants.ok) {
          await transaction.rollback();
          return res
            .status(400)
            .json({ success: false, msg: normalizedVariants.message });
        }
        const variantsData = normalizedVariants.variants.map(normalizeWarehouseProductVariantPayload);
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

        // 👉 5. Actualizar o crear variantes (FIFO: si purchase_price es diferente, crear nuevo lote)
        const processedIds = new Set();
        const referenceId = uuidv4(); // ID único para esta operación de actualización

        logger.info(`[DEBUG] Procesando ${variantsData.length} variantes para warehouse_product ${id}`);
        logger.info(`[DEBUG] Variantes existentes en BD: ${existingVariants.length}`);

        for (const variantData of variantsData) {
          const {
            id: variantClientId, // opcional, si viene del frontend
            variant_id,
            local_sku,
            stock,
            price,
            purchase_price, // ⭐ NUEVO: Precio de compra
            promotional_price,
            active: activeVariant = true,
            published = false,
          } = variantData;

          // 🧠 Clave para identificar la variante (normalizada para evitar problemas con null/undefined)
          const normalizedVariantId = variant_id != null ? String(variant_id) : null;
          const key = `global-${normalizedVariantId}`;

          const hasStock = stock !== undefined && stock !== null;
          const hasPrice = price !== undefined && price !== null;
          const hasPurchasePrice = purchase_price !== undefined && purchase_price !== null;
          const hasPromotionalPrice = promotional_price !== undefined;
          const hasLocalSku = local_sku !== undefined;
          const hasActive = variantData.active !== undefined;
          const hasPublished = variantData.published !== undefined;

          const normalizedPrice = hasPrice ? normalizeMoneyValue(price) : null;
          const normalizedPurchasePrice = hasPurchasePrice
            ? normalizeMoneyValue(purchase_price)
            : null;
          const normalizedPromotionalPrice = hasPromotionalPrice
            ? normalizeNullableMoneyValue(promotional_price)
            : null;
          const normalizedLocalSku = hasLocalSku ? String(local_sku || '').trim() : null;

          logger.info(`[DEBUG] Buscando variante con key: ${key}, local_sku: ${normalizedLocalSku}, price: ${normalizedPrice}, purchase_price: ${normalizedPurchasePrice}, promotional_price: ${normalizedPromotionalPrice}`);

          // ⭐ BUSCAR lote existente con el MISMO purchase_price y misma variante_id
          let existingWithSamePrice = null;
          if (hasPurchasePrice) {
            existingWithSamePrice = existingVariants.find(v => {
              const vNormalizedVariantId = v.variant_id != null ? String(v.variant_id) : null;
              const vKey = `global-${vNormalizedVariantId}`;
              
              const variantMatches = vKey === key;
              const skuMatches = !hasLocalSku || String(v.local_sku || '').trim() === normalizedLocalSku;
              const priceMatches = !hasPrice || sameMoney(v.price, normalizedPrice);
              const purchasePriceMatches = sameMoney(v.purchase_price, normalizedPurchasePrice);
              const promotionalPriceMatches = !hasPromotionalPrice || sameNullableMoney(v.promotional_price, normalizedPromotionalPrice);
              const activeMatches = v.active !== false;
              const lotMatches = variantMatches
                && skuMatches
                && priceMatches
                && purchasePriceMatches
                && promotionalPriceMatches
                && activeMatches;

              logger.info(`[DEBUG] Comparando lote existente: key=${vKey}, local_sku=${v.local_sku || null}, price=${v.price}, purchase_price=${v.purchase_price}, promotional_price=${v.promotional_price || null}, match=${lotMatches}`);

              return lotMatches;
            });
          }

          if (!existingWithSamePrice && !hasPurchasePrice) {
            const candidates = existingVariants.filter(v => {
              const vNormalizedVariantId = v.variant_id != null ? String(v.variant_id) : null;
              return `global-${vNormalizedVariantId}` === key;
            });
            if (candidates.length > 0) {
              candidates.sort((a, b) => {
                const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
                const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
                if (aTime !== bTime) return bTime - aTime;
                return (b.id || 0) - (a.id || 0);
              });
              existingWithSamePrice = candidates[0];
            }
          }

          const variantToUpdate = {
            warehouse_product_id: record.id,
            variant_id: variant_id || null,
          };
          if (hasLocalSku) variantToUpdate.local_sku = local_sku || null;
          if (hasPrice) variantToUpdate.price = parseFloat(price) || 0;
          if (hasPurchasePrice) variantToUpdate.purchase_price = normalizedPurchasePrice;
          if (hasPromotionalPrice) {
            variantToUpdate.promotional_price = promotional_price
              ? parseFloat(promotional_price)
              : null;
          }
          if (hasActive) variantToUpdate.active = activeVariant !== false;
          if (hasPublished) variantToUpdate.published = published;

          if (existingWithSamePrice) {
            logger.info(`[DEBUG] Variante encontrada (ID: ${existingWithSamePrice.id}), incrementando stock`);
            
            // ✅ MISMO PRECIO DE COMPRA: Incrementar stock al lote existente
            if (hasStock) {
              const oldStock = existingWithSamePrice.stock || 0;
              const newStock = oldStock + (parseInt(stock) || 0);
              await existingWithSamePrice.update({
                ...variantToUpdate,
                stock: newStock
              }, { transaction });

              // ⭐ REGISTRAR MOVIMIENTO DE INVENTARIO (entrada de stock)
              if (parseInt(stock) > 0) {
                await InventoryMovementRepository.create({
                  warehouse_id: record.warehouse_id,
                  product_id: record.product_id,
                  variant_id: variant_id || null,
                  company_id: record.company_id,
                  branch_id: record.branch_id,
                  movement_type: 'entry',
                  quantity: parseInt(stock) || 0,
                  stock_before: oldStock,
                  stock_after: newStock,
                  unit_price: hasPrice ? (parseFloat(price) || 0) : (parseFloat(existingWithSamePrice.price) || 0),
                  purchase_price: hasPurchasePrice ? (parseFloat(purchase_price) || 0) : (parseFloat(existingWithSamePrice.purchase_price) || 0),
                  total_value: (parseFloat(purchase_price) || 0) * (parseInt(stock) || 0),
                  reference_type: 'warehouse_product_update',
                  reference_id: referenceId,
                  user_id: metadata.user_id,
                  notes: `Se agregaron ${parseInt(stock) || 0} unidades al stock existente.`,
                  meta: {
                    operation: 'warehouse_product_update',
                    warehouse_product_id: id,
                    lot_matched: true,
                    existing_variant_id: existingWithSamePrice.id
                  }
                }, { transaction });
              }
            } else {
              await existingWithSamePrice.update(variantToUpdate, { transaction });
            }
            
            processedIds.add(existingWithSamePrice.id);
          } else {
            // ⭐ DIFERENTE PRECIO DE COMPRA: Crear nuevo lote (FIFO)
            logger.info(`[DEBUG] NO se encontró variante con mismo precio, creando NUEVO lote`);
            
            const createData = {
              warehouse_product_id: record.id,
              variant_id: variant_id || null,
              local_sku: hasLocalSku ? (local_sku || null) : null,
              stock: hasStock ? (parseInt(stock) || 0) : 0,
              price: hasPrice ? (parseFloat(price) || 0) : 0,
              purchase_price: hasPurchasePrice ? normalizedPurchasePrice : 0,
              promotional_price: hasPromotionalPrice
                ? (promotional_price ? parseFloat(promotional_price) : null)
                : null,
              active: hasActive ? (activeVariant !== false) : true,
              published: hasPublished ? published : false
            };

            const newVariant = await WarehouseProductVariantRepository.create(createData, { transaction });

            logger.info(`[DEBUG] Nueva variante creada (ID: ${newVariant.id})`);
            
            // ⭐ REGISTRAR MOVIMIENTO DE INVENTARIO (entrada de stock - nuevo lote)
            if (hasStock && parseInt(stock) > 0) {
              await InventoryMovementRepository.create({
                warehouse_id: record.warehouse_id,
                product_id: record.product_id,
                variant_id: variant_id || null,
                company_id: record.company_id,
                branch_id: record.branch_id,
                movement_type: 'entry',
                quantity: parseInt(stock) || 0,
                stock_before: 0,
                stock_after: parseInt(stock) || 0,
                unit_price: hasPrice ? (parseFloat(price) || 0) : 0,
                purchase_price: hasPurchasePrice ? (parseFloat(purchase_price) || 0) : 0,
                total_value: (parseFloat(purchase_price) || 0) * (parseInt(stock) || 0),
                reference_type: 'warehouse_product_update',
                reference_id: referenceId,
                user_id: metadata.user_id,
                notes: `Se registró un nuevo lote con ${parseInt(stock) || 0} unidades.`,
                meta: {
                  operation: 'warehouse_product_update',
                  warehouse_product_id: id,
                  lot_matched: false,
                  new_variant_id: newVariant.id
                }
              }, { transaction });
            }
            
            processedIds.add(newVariant.id);
          }
        }

        logger.info(
          `Variantes sincronizadas para warehouse_product ${id}: ${variantsData.length} enviadas, ${existingVariants.length} anteriores, ${processedIds.size} procesadas/actualizadas`
        );
      }
      await transaction.commit();

      const recordChanges = detectChanges(previousRecord, toPlain(record), ["active", "code", "minimum_stock"]);
      if (warehouse) {
        await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
          action: "warehouse.product_config_updated",
          result: "success",
          related_resource_type: "product",
          related_resource_id: record.product_id,
          previous_value: changesToValueSnapshot(recordChanges, "old_value"),
          new_value: changesToValueSnapshot(recordChanges, "new_value"),
          changes: recordChanges,
          description: `Configuracion de producto modificada en almacen: ${productRecord ? getProductAuditLabel(productRecord) : record.product_id}`,
          metadata: {
            warehouse_product_id: record.id,
            product_label: productRecord ? getProductAuditLabel(productRecord) : null,
            variants_updated: variantsString !== undefined && variantsString !== null && variantsString !== ""
          }
        }));
      }

      // 👉 7. Obtener los registros actualizados con los mismos filtros del request
      /*const records = await WarehouseProductRepository.findFiltered({
        companyId: req.body.company_id,
        userId: req.body.user_id,
        branchId: req.body.branch_id,
        warehouseId: req.body.warehouse_id,
      });*/

      // 👉 8. Log y respuesta
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
        warehouse_products: null,
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
      const previousRecord = toPlain(record);
      const [warehouse, productRecord] = await Promise.all([
        WarehouseRepository.findById(record.warehouse_id),
        ProductRepository.findById(record.product_id)
      ]);

      await WarehouseProductRepository.delete(record);
      if (warehouse) {
        await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
          action: "warehouse.product_removed",
          result: "success",
          related_resource_type: "product",
          related_resource_id: previousRecord.product_id,
          previous_value: previousRecord,
          description: `Producto eliminado del almacen: ${productRecord ? getProductAuditLabel(productRecord) : previousRecord.product_id}`,
          metadata: {
            warehouse_product_id: previousRecord.id,
            product_label: productRecord ? getProductAuditLabel(productRecord) : null
          }
        }));
      }
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
  logger.info(`Datos recibidos: ${JSON.stringify(req.body)}`);

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

    const normalizedVariants = normalizeVariantsInput(variants, { required: true });
    if (!normalizedVariants.ok) {
      await transaction.rollback();
      return res.status(400).json({ success: false, message: normalizedVariants.message });
    }
    const variantsData = normalizedVariants.variants.map(normalizeMovementVariantPayload);

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
        minimum_stock: 5,
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
          minimum_stock: 5,
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
    for (const variantData of variantsData) {
      const {
        variant_id,
        quantity,
        // Campos solo para 'entry'
        local_sku,
        price,
        purchase_price,  // ⭐ NUEVO: Campo separado para precio de compra
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
        // === OBTENER O CREAR VARIANTE SI NO EXISTE ===
        // Si no se especifica variant_id, usar/crear la variante por defecto del producto
        let actualVariantId = variant_id;
        
        if (!actualVariantId) {
          // Buscar variante por defecto del producto
          const defaultVariant = await ProductVariantRepository.findOneByProductId(product.id);
          
          if (defaultVariant) {
            actualVariantId = defaultVariant.id;
          } else {
            // Crear variante por defecto si no existe
            const newVariant = await ProductVariantRepository.create({
              product_id: product.id,
              sku: product.sku,
              attributes: {}
            }, { transaction });
            actualVariantId = newVariant.id;
            logger.info(`Variante por defecto creada: ${newVariant.id} para producto ${product.id}`);
          }
        }
        
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
        // --- ENTRADA: CREAR NUEVO LOTE CON SU PRECIO DE COMPRA ---
        // IMPORTANTE: Siempre se crea un nuevo lote para mantener el precio de compra original
        // Esto permite calcular la ganancia real por cada venta basada en el costo del lote vendido
        
        // Si el frontend envía purchase_price, usarlo. Si no, usar price como fallback
        const actualPurchasePrice = parseFloat(purchase_price) || parseFloat(price) || 0;
        const salePrice = parseFloat(price) || 0;
        const effectiveLocalSku = local_sku || product.sku;
        const effectivePromotionalPrice = promotional_price || null;
        
        // Crear nuevo lote con su precio de compra específico
        const totalStockBeforeEntry = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
          actualVariantId,
          originWp.id
        );
        const stockBefore = totalStockBeforeEntry?.total_stock || 0;
        const stockAfter = stockBefore + quantity;

        const matchingLot = await WarehouseProductVariantRepository.findMatchingLotByVariantAndWarehouse({
          variantId: actualVariantId,
          warehouseProductId: originWp.id,
          localSku: effectiveLocalSku,
          price: salePrice,
          purchasePrice: actualPurchasePrice,
          promotionalPrice: effectivePromotionalPrice
        });

        let affectedLot = matchingLot;
        let lotCreated = false;
        if (matchingLot) {
          await WarehouseProductVariantRepository.update(matchingLot, {
            stock: (parseInt(matchingLot.stock, 10) || 0) + quantity,
            active: true
          }, { transaction });
        } else {
          affectedLot = await WarehouseProductVariantRepository.create({
          warehouse_product_id: originWp.id,
          variant_id: actualVariantId,  // ✅ Usar variant_id válido
          stock: quantity,
          local_sku: effectiveLocalSku,
          price: salePrice,              // Precio de venta
          purchase_price: actualPurchasePrice, // 💰 PRECIO DE COMPRA DEL LOTE (nuevo campo)
          promotional_price: effectivePromotionalPrice,
          active: true,
          published: false
        }, { transaction });
          lotCreated = true;
        }

        // Registrar movimiento de entrada con el precio de compra
        await InventoryMovementRepository.create({
          warehouse_id: origin_warehouse_id,
          product_id,
          variant_id: actualVariantId,  // ✅ Usar variant_id válido
          company_id: originWarehouse.company_id,
          branch_id: originWarehouse.branch_id,
          movement_type: 'entry',
          quantity,
          stock_before: stockBefore,
          stock_after: stockAfter,
          unit_price: salePrice,              // Precio de venta unitario
          purchase_price: actualPurchasePrice, // 💰 PRECIO DE COMPRA (nuevo campo)
          total_value: actualPurchasePrice * quantity, // Valor total de la compra
          reference_type: 'manual',
          reference_id: referenceId,
          reason: reason.trim(),
          notes: notes?.trim() || null,
          user_id: currentUserId,
          meta: {  // ⭐ AGREGADO: Información del lote creado
            lot_created: lotCreated,
            lot_updated: !lotCreated,
            lot_id: affectedLot.id,
            purchase_price: actualPurchasePrice,
            sale_price: salePrice
          }
        }, { transaction });

      } else if (movement_type === 'exit') {
        // --- SALIDA: IMPLEMENTAR FIFO PARA CALCULAR COSTO REAL ---
        // Se obtienen todos los lotes activos ordenados por fecha (más antiguo primero)
        // y se descuenta el stock comenzando por el lote más antiguo (FIFO)
        
        const lots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
          variant_id,
          originWp.id
        );

        if (!lots || lots.length === 0) {
          await transaction.rollback();
          return res.status(400).json({ 
            success: false, 
            message: `No hay stock disponible para la variante ${variant_id}` 
          });
        }

        // Calcular stock total disponible (suma de todos los lotes)
        const totalAvailableStock = lots.reduce((sum, lot) => sum + lot.stock, 0);
        
        if (totalAvailableStock < quantity) {
          await transaction.rollback();
          return res.status(400).json({ 
            success: false, 
            message: `Stock insuficiente. Disponible: ${totalAvailableStock}, Solicitado: ${quantity}` 
          });
        }

        // === APLICAR FIFO: Descontar de los lotes más antiguos primero ===
        let remainingToSell = quantity;
        let totalCost = 0; // Costo total de la venta (para calcular ganancia)
        let totalStockBefore = totalAvailableStock;
        const lotsToUpdate = [];

        for (const lot of lots) {
          if (remainingToSell <= 0) break;

          const takeFromLot = Math.min(lot.stock, remainingToSell);
          const lotCost = takeFromLot * parseFloat(lot.purchase_price);
          
          totalCost += lotCost;
          lotsToUpdate.push({
            lotId: lot.id,
            oldStock: lot.stock,
            newStock: lot.stock - takeFromLot,
            purchasePrice: lot.purchase_price
          });

          remainingToSell -= takeFromLot;
        }

        // Actualizar cada lote afectado
        for (const lotData of lotsToUpdate) {
          const updateData = { stock: lotData.newStock };
          
          // Si el lote se queda sin stock, desactivarlo
          if (lotData.newStock === 0) {
            updateData.active = false;
            updateData.published = false;
          }

          const lot = await WarehouseProductVariantRepository.findLotById(lotData.lotId);
          if (lot) {
            await WarehouseProductVariantRepository.update(lot, updateData, { transaction });
          }
        }

        // Calcular precio de costo promedio para el registro del movimiento
        const avgCostPerUnit = totalCost / quantity;

        // Registrar movimiento de salida con el costo real calculado
        await InventoryMovementRepository.create({
          warehouse_id: origin_warehouse_id,
          product_id,
          variant_id,
          company_id: originWarehouse.company_id,
          branch_id: originWarehouse.branch_id,
          movement_type: 'exit',
          quantity,
          stock_before: totalStockBefore,
          stock_after: totalStockBefore - quantity,
          unit_price: avgCostPerUnit,        // 💰 COSTO PROMEDIO (FIFO)
          purchase_price: avgCostPerUnit,    // 💰 PRECIO DE COMPRA (igual al costo promedio)
          total_value: totalCost,             // 💰 COSTO TOTAL REAL PARA CÁLCULO DE GANANCIA
          reference_type: 'manual',
          reference_id: referenceId,
          reason: reason.trim(),
          notes: notes?.trim() || null,
          user_id: currentUserId,
          meta: {
            fifo_calculation: true,
            lots_used: lotsToUpdate,
            total_purchase_cost: totalCost
          }
        }, { transaction });

      } else if (movement_type === 'transfer') {
        // --- TRANSFERENCIA: FIFO en origen, mantener purchase_price en destino ---
        // El purchase_price original se mantiene en el almacén destino para preservar
        // el costo real del producto transferido
        
        // 1. Obtener lotes del origen con FIFO
        const originLots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
          variant_id,
          originWp.id
        );

        if (!originLots || originLots.length === 0) {
          await transaction.rollback();
          return res.status(400).json({ 
            success: false, 
            message: `No hay stock disponible en origen para la variante ${variant_id}` 
          });
        }

        const totalAvailableStock = originLots.reduce((sum, lot) => sum + lot.stock, 0);
        
        if (totalAvailableStock < quantity) {
          await transaction.rollback();
          return res.status(400).json({ 
            success: false, 
            message: `Stock insuficiente en origen. Disponible: ${totalAvailableStock}, Solicitado: ${quantity}` 
          });
        }

        // 2. Aplicar FIFO en origen (igual que exit)
        let remainingToTransfer = quantity;
        let totalCost = 0;
        let totalStockBeforeOrigin = totalAvailableStock;
        const originLotsToUpdate = [];
        let weightedAvgPurchasePrice = 0;

        for (const lot of originLots) {
          if (remainingToTransfer <= 0) break;

          const takeFromLot = Math.min(lot.stock, remainingToTransfer);
          const lotCost = takeFromLot * parseFloat(lot.purchase_price);
          
          totalCost += lotCost;
          originLotsToUpdate.push({
            lotId: lot.id,
            oldStock: lot.stock,
            newStock: lot.stock - takeFromLot,
            purchasePrice: lot.purchase_price,
            quantityTransferred: takeFromLot
          });

          remainingToTransfer -= takeFromLot;
        }

        // Calcular precio de compra promedio ponderado para el destino
        weightedAvgPurchasePrice = totalCost / quantity;

        // 3. Actualizar lotes en origen
        for (const lotData of originLotsToUpdate) {
          const updateData = { stock: lotData.newStock };
          
          if (lotData.newStock === 0) {
            updateData.active = false;
            updateData.published = false;
          }

          const lot = await WarehouseProductVariantRepository.findLotById(lotData.lotId);
          if (lot) {
            await WarehouseProductVariantRepository.update(lot, updateData, { transaction });
          }
        }

        // 4. Crear/actualizar lote en destino con el purchase_price original
        // Obtener lotes existentes en destino (si los hay)
        const destLots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
          variant_id,
          destWp.id
        );

        // Buscar un lote en destino con el mismo purchase_price (para consolidar)
        let destLotConsolidated = null;
        if (destLots && destLots.length > 0) {
          // Buscar lote con purchase_price similar (margen de 0.01 para decimales)
          destLotConsolidated = destLots.find(lot => 
            Math.abs(parseFloat(lot.purchase_price) - weightedAvgPurchasePrice) < 0.01
          );
        }

        const totalStockBeforeDestInfo = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
          variant_id,
          destWp.id
        );
        const totalStockBeforeDest = totalStockBeforeDestInfo?.total_stock || 0;

        if (destLotConsolidated) {
          // Consolidar con lote existente del mismo precio
          const newStock = destLotConsolidated.stock + quantity;
          
          await WarehouseProductVariantRepository.update(destLotConsolidated, {
            stock: newStock
          }, { transaction });
        } else {
          // Crear nuevo lote en destino con el purchase_price promedio de la transferencia
          await WarehouseProductVariantRepository.create({
            warehouse_product_id: destWp.id,
            variant_id,
            active: true,
            published: false,
            local_sku: originLots[0]?.local_sku || null,
            price: originLots[0]?.price || 0,
            promotional_price: originLots[0]?.promotional_price,
            purchase_price: weightedAvgPurchasePrice, // 💰 MANTIENE EL COSTO ORIGINAL
            stock: quantity
          }, { transaction });
        }

        // 5. Registrar movimientos de transferencia con el costo real
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
          stock_before: totalStockBeforeOrigin,
          stock_after: totalStockBeforeOrigin - quantity,
          unit_price: weightedAvgPurchasePrice,
          purchase_price: weightedAvgPurchasePrice,  // 💰 PRECIO DE COMPRA (transferencia salida)
          total_value: totalCost,
          meta: {
            transfer_type: 'fifo',
            lots_used: originLotsToUpdate,
            total_purchase_cost: totalCost
          }
        }, { transaction });

        await InventoryMovementRepository.create({
          ...baseMovement,
          warehouse_id: destination_warehouse_id,
          company_id: destWarehouse.company_id,
          branch_id: destWarehouse.branch_id,
          movement_type: 'transfer_entry',
          quantity,
          stock_before: totalStockBeforeDest,
          stock_after: totalStockBeforeDest + quantity,
          unit_price: weightedAvgPurchasePrice,
          purchase_price: weightedAvgPurchasePrice,  // 💰 PRECIO DE COMPRA (transferencia entrada)
          total_value: totalCost,
          meta: {
            transfer_type: 'fifo',
            purchase_price_preserved: weightedAvgPurchasePrice
          }
        }, { transaction });
      }
    }

    await transaction.commit();
    await recordMovementAuditEvents(req, referenceId);

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
    await recordMovementAuditEvents(req, referenceId, { isBulk: true });

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
      minimum_stock: 5,
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
        minimum_stock: 5,
        company_id: destWarehouse.company_id,
        branch_id: destWarehouse.branch_id,
        user_id: currentUserId
      }, { transaction });
    }
  }

  // === Cargar variantes actuales del origen (para validar stock) ===
  const originWpVariants = await WarehouseProductVariantRepository.findByWarehouseProductId(originWp.id);
  const originVariantMap = new Map(originWpVariants.map(v => [v.variant_id, v]));
  const normalizedVariants = normalizeVariantsInput(variants, { required: true });
  if (!normalizedVariants.ok) {
    throw new Error(normalizedVariants.message);
  }
  const variantsData = normalizedVariants.variants.map(normalizeMovementVariantPayload);

  // === Procesar cada variante del producto ===
  for (const variantData of variantsData) {
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
  const { variant_id, quantity, local_sku, price, purchase_price, promotional_price } = variantData;

  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new Error(`Cantidad inválida para variante ${variant_id}`);
  }

  // Para exit/transfer, validar que haya stock (la validación detallada se hace en _processExit/_processTransfer)
  if (movement_type === 'exit' || movement_type === 'transfer') {
    const totalStock = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
      variant_id,
      originWp.id
    );
    
    if (totalStock.total_stock < quantity) {
      throw new Error(`Stock insuficiente para variante ${variant_id}. Disponible: ${totalStock.total_stock}`);
    }
  }

  if (movement_type === 'entry') {
    await _processEntry({
      originWp,
      variant_id,
      quantity,
      local_sku,
      price,
      purchase_price,
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
      originWp,
      variant_id,
      quantity,
      originWarehouse,
      product_id: product.id,
      reason,
      notes,
      currentUserId,
      referenceId,
      transaction
    });
  } else if (movement_type === 'transfer') {
    await _processTransfer({
      originWp,
      destWp,
      variant_id,
      quantity,
      originWarehouse,
      destWarehouse,
      product_id: product.id,
      reason,
      notes,
      currentUserId,
      referenceId,
      transaction
    });
  }
};

// --- ENTRADA (actualizado para lotes) ---
async function _processEntry({
  originWp,
  variant_id,
  quantity,
  local_sku,
  price,
  purchase_price,  // ⭐ NUEVO
  promotional_price,
  product,
  originWarehouse,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  // === OBTENER O CREAR VARIANTE SI NO EXISTE ===
  let actualVariantId = variant_id;
  
  if (!actualVariantId) {
    const defaultVariant = await ProductVariantRepository.findOneByProductId(product.id);
    
    if (defaultVariant) {
      actualVariantId = defaultVariant.id;
    } else {
      const newVariant = await ProductVariantRepository.create({
        product_id: product.id,
        sku: product.sku,
        attributes: {}
      }, { transaction });
      actualVariantId = newVariant.id;
    }
  }

  // Si el frontend envía purchase_price, usarlo. Si no, usar price como fallback
  const actualPurchasePrice = parseFloat(purchase_price) || parseFloat(price) || 0;
  const salePrice = parseFloat(price) || 0;
  const effectiveLocalSku = local_sku || product.sku;
  const effectivePromotionalPrice = promotional_price || null;

  // Crear nuevo lote con su precio de compra específico
  const totalStockBeforeEntry = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
    actualVariantId,
    originWp.id
  );
  const stockBefore = totalStockBeforeEntry?.total_stock || 0;
  const stockAfter = stockBefore + quantity;

  const matchingLot = await WarehouseProductVariantRepository.findMatchingLotByVariantAndWarehouse({
    variantId: actualVariantId,
    warehouseProductId: originWp.id,
    localSku: effectiveLocalSku,
    price: salePrice,
    purchasePrice: actualPurchasePrice,
    promotionalPrice: effectivePromotionalPrice
  });

  let affectedLot = matchingLot;
  let lotCreated = false;

  if (matchingLot) {
    await WarehouseProductVariantRepository.update(matchingLot, {
      stock: (parseInt(matchingLot.stock, 10) || 0) + quantity,
      active: true
    }, { transaction });
  } else {
    affectedLot = await WarehouseProductVariantRepository.create({
    warehouse_product_id: originWp.id,
    variant_id: actualVariantId,  // ✅ Usar variant_id válido
    stock: quantity,
    local_sku: effectiveLocalSku,
    price: salePrice,
    purchase_price: actualPurchasePrice, // 💰 PRECIO DE COMPRA DEL LOTE
    promotional_price: effectivePromotionalPrice,
    active: true,
    published: false
  }, { transaction });
    lotCreated = true;
  }

  await InventoryMovementRepository.create({
    warehouse_id: originWarehouse.id,
    product_id: product.id,
    variant_id: actualVariantId,  // ✅ Usar variant_id válido
    company_id: originWarehouse.company_id,
    branch_id: originWarehouse.branch_id,
    movement_type: 'entry',
    quantity,
    stock_before: stockBefore,
    stock_after: stockAfter,
    unit_price: salePrice,
    purchase_price: actualPurchasePrice, // 💰 PRECIO DE COMPRA
    total_value: actualPurchasePrice * quantity,
    reference_type: 'manual',
    reference_id: referenceId,
    reason: reason.trim(),
    notes: notes?.trim() || null,
    user_id: currentUserId,
    meta: {
      lot_created: lotCreated,
      lot_updated: !lotCreated,
      lot_id: affectedLot.id,
      purchase_price: actualPurchasePrice,
      sale_price: salePrice
    }
  }, { transaction });
};

// --- SALIDA (con FIFO para costo real) ---
async function _processExit({
  originWp,
  variant_id,
  quantity,
  originWarehouse,
  product_id,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  // Obtener lotes con FIFO
  const lots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
    variant_id,
    originWp.id
  );

  if (!lots || lots.length === 0) {
    throw new Error(`No hay stock disponible para la variante ${variant_id}`);
  }

  const totalAvailableStock = lots.reduce((sum, lot) => sum + lot.stock, 0);
  
  if (totalAvailableStock < quantity) {
    throw new Error(`Stock insuficiente. Disponible: ${totalAvailableStock}, Solicitado: ${quantity}`);
  }

  // Aplicar FIFO
  let remainingToSell = quantity;
  let totalCost = 0;
  let totalStockBefore = totalAvailableStock;
  const lotsToUpdate = [];

  for (const lot of lots) {
    if (remainingToSell <= 0) break;

    const takeFromLot = Math.min(lot.stock, remainingToSell);
    const lotCost = takeFromLot * parseFloat(lot.purchase_price);
    
    totalCost += lotCost;
    lotsToUpdate.push({
      lotId: lot.id,
      oldStock: lot.stock,
      newStock: lot.stock - takeFromLot,
      purchasePrice: lot.purchase_price
    });

    remainingToSell -= takeFromLot;
  }

  // Actualizar lotes
  for (const lotData of lotsToUpdate) {
    const updateData = { stock: lotData.newStock };
    
    if (lotData.newStock === 0) {
      updateData.active = false;
      updateData.published = false;
    }

    const lot = await WarehouseProductVariantRepository.findLotById(lotData.lotId);
    if (lot) {
      await WarehouseProductVariantRepository.update(lot, updateData, { transaction });
    }
  }

  const avgCostPerUnit = totalCost / quantity;

  await InventoryMovementRepository.create({
    warehouse_id: originWarehouse.id,
    product_id,
    variant_id,
    company_id: originWarehouse.company_id,
    branch_id: originWarehouse.branch_id,
    movement_type: 'exit',
    quantity,
    stock_before: totalStockBefore,
    stock_after: totalStockBefore - quantity,
    unit_price: avgCostPerUnit,
    purchase_price: avgCostPerUnit,  // 💰 PRECIO DE COMPRA (igual al costo promedio)
    total_value: totalCost,
    reference_type: 'manual',
    reference_id: referenceId,
    reason: reason.trim(),
    notes: notes?.trim() || null,
    user_id: currentUserId,
    meta: {
      fifo_calculation: true,
      lots_used: lotsToUpdate,
      total_purchase_cost: totalCost
    }
  }, { transaction });
};

// --- TRANSFERENCIA (con FIFO y mantenimiento de purchase_price) ---
async function _processTransfer({
  originWp,
  destWp,
  variant_id,
  quantity,
  originWarehouse,
  destWarehouse,
  product_id,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction
}) {
  // 1. Obtener lotes del origen con FIFO
  const originLots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
    variant_id,
    originWp.id
  );

  if (!originLots || originLots.length === 0) {
    throw new Error(`No hay stock disponible en origen para la variante ${variant_id}`);
  }

  const totalAvailableStock = originLots.reduce((sum, lot) => sum + lot.stock, 0);
  
  if (totalAvailableStock < quantity) {
    throw new Error(`Stock insuficiente en origen. Disponible: ${totalAvailableStock}, Solicitado: ${quantity}`);
  }

  // 2. Aplicar FIFO en origen
  let remainingToTransfer = quantity;
  let totalCost = 0;
  let totalStockBeforeOrigin = totalAvailableStock;
  const originLotsToUpdate = [];

  for (const lot of originLots) {
    if (remainingToTransfer <= 0) break;

    const takeFromLot = Math.min(lot.stock, remainingToTransfer);
    const lotCost = takeFromLot * parseFloat(lot.purchase_price);
    
    totalCost += lotCost;
    originLotsToUpdate.push({
      lotId: lot.id,
      oldStock: lot.stock,
      newStock: lot.stock - takeFromLot,
      purchasePrice: lot.purchase_price,
      quantityTransferred: takeFromLot
    });

    remainingToTransfer -= takeFromLot;
  }

  const weightedAvgPurchasePrice = totalCost / quantity;

  // 3. Actualizar lotes en origen
  for (const lotData of originLotsToUpdate) {
    const updateData = { stock: lotData.newStock };
    
    if (lotData.newStock === 0) {
      updateData.active = false;
      updateData.published = false;
    }

    const lot = await WarehouseProductVariantRepository.findLotById(lotData.lotId);
    if (lot) {
      await WarehouseProductVariantRepository.update(lot, updateData, { transaction });
    }
  }

  // 4. Crear/actualizar lote en destino con el purchase_price original
  const destLots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
    variant_id,
    destWp.id
  );

  let destLotConsolidated = null;
  if (destLots && destLots.length > 0) {
    destLotConsolidated = destLots.find(lot => 
      Math.abs(parseFloat(lot.purchase_price) - weightedAvgPurchasePrice) < 0.01
    );
  }

  const totalStockBeforeDestInfo = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
    variant_id,
    destWp.id
  );
  const totalStockBeforeDest = totalStockBeforeDestInfo?.total_stock || 0;

  if (destLotConsolidated) {
    const newStock = destLotConsolidated.stock + quantity;
    
    await WarehouseProductVariantRepository.update(destLotConsolidated, {
      stock: newStock
    }, { transaction });
  } else {
    await WarehouseProductVariantRepository.create({
      warehouse_product_id: destWp.id,
      variant_id,
      active: true,
      published: false,
      local_sku: originLots[0]?.local_sku || null,
      price: originLots[0]?.price || 0,
      promotional_price: originLots[0]?.promotional_price,
      purchase_price: weightedAvgPurchasePrice,
      stock: quantity
    }, { transaction });
  }

  // 5. Registrar movimientos
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
    stock_before: totalStockBeforeOrigin,
    stock_after: totalStockBeforeOrigin - quantity,
    unit_price: weightedAvgPurchasePrice,
    purchase_price: weightedAvgPurchasePrice,  // 💰 PRECIO DE COMPRA (transferencia salida)
    total_value: totalCost,
    meta: {
      transfer_type: 'fifo',
      lots_used: originLotsToUpdate,
      total_purchase_cost: totalCost
    }
  }, { transaction });

  await InventoryMovementRepository.create({
    ...baseMovement,
    warehouse_id: destWarehouse.id,
    company_id: destWarehouse.company_id,
    branch_id: destWarehouse.branch_id,
    movement_type: 'transfer_entry',
    quantity,
    stock_before: totalStockBeforeDest,
    stock_after: totalStockBeforeDest + quantity,
    unit_price: weightedAvgPurchasePrice,
    purchase_price: weightedAvgPurchasePrice,  // 💰 PRECIO DE COMPRA (transferencia entrada)
    total_value: totalCost,
    meta: {
      transfer_type: 'fifo',
      purchase_price_preserved: weightedAvgPurchasePrice
    }
  }, { transaction });
}

module.exports = WarehouseProductController;
