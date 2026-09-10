// controllers/WarehouseProductController.js
const logger = require("../../config/logger");
const {
  sequelize,
  WarehouseProductVariant
} = require("../models");
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
  // `Model#get({ plain: true })` puede devolver la misma referencia de
  // `dataValues` cuando no hay asociaciones incluidas. Para auditoría eso
  // destruye el estado anterior después de `update()`. `toJSON()` sí devuelve
  // una copia profunda de la instancia Sequelize.
  if (typeof record.toJSON === "function") return record.toJSON();
  if (typeof record.get === "function") {
    const plain = record.get({ plain: true });
    if (plain && typeof plain === "object") {
      return Array.isArray(plain) ? [...plain] : { ...plain };
    }
    return plain;
  }
  return record;
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

function buildWarehouseVariantAuditChanges(previousVariant, currentVariant) {
  const previous = toPlain(previousVariant) || {};
  const current = toPlain(currentVariant) || {};
  const changes = [];
  const comparableFields = [
    ['price', normalizeNullableMoneyValue],
    ['purchase_price', normalizeNullableMoneyValue],
    ['promotional_price', normalizeNullableMoneyValue],
    ['stock', (value) => value === null || value === undefined ? null : Number(value)],
    ['local_sku', (value) => value ?? null],
    ['active', (value) => value === null || value === undefined ? null : value !== false],
    ['published', (value) => value === null || value === undefined ? null : value === true]
  ];

  for (const [field, normalize] of comparableFields) {
    const oldValue = normalize(previous[field]);
    const newValue = normalize(current[field]);
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    changes.push({ field, old_value: oldValue, new_value: newValue });
  }

  return changes;
}

function markNewWarehouseAssociationAuditChanges(changes) {
  return changes.map((change) => ({
    ...change,
    is_new_association: true
  }));
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

function getMovementDescription(movement, productLabel = null) {
  const type = movement.movement_type;
  const productName = productLabel || movement.product?.name || 'Producto sin identificar';

  if (type === "entry") return `Entrada de stock: ${productName}`;
  if (type === "exit") return `Salida de stock: ${productName}`;
  if (type === "transfer_exit") return `Transferencia de salida: ${productName}`;
  if (type === "transfer_entry" && getMovementMeta(movement).is_new_variant === true) {
    return `Transferencia de entrada: nueva variante creada para ${productName}`;
  }
  if (type === "transfer_entry") return `Transferencia de entrada: ${productName}`;
  return `Movimiento de inventario: ${productName}`;
}

function getMovementPriceChanges(movement) {
  const meta = getMovementMeta(movement);
  return Array.isArray(meta.price_changes) ? meta.price_changes : [];
}

function getMovementMeta(movement) {
  let meta = movement?.meta || {};
  try {
    if (typeof meta === 'string') meta = JSON.parse(meta);
  } catch {
    meta = {};
  }
  return meta && typeof meta === 'object' ? meta : {};
}

async function getTransferDestinationPriceConflict({ productId, variantId, destinationWarehouseId, destinationWarehouseProductId, sourceLot, price, purchasePrice, promotionalPrice, confirm }) {
  const destinationLots = await WarehouseProductVariant.findAll({
    where: { warehouse_product_id: destinationWarehouseProductId, variant_id: variantId, active: true },
    order: [['createdAt', 'ASC']]
  });
  const option = destinationLots[0];
  if (!option) return null;
  const requestedPrice = normalizeNullableMoneyValue(price === undefined ? sourceLot?.price : price);
  const requestedPurchasePrice = normalizeNullableMoneyValue(purchasePrice === undefined ? sourceLot?.purchase_price : purchasePrice);
  const requestedPromotionalPrice = normalizeNullableMoneyValue(promotionalPrice === undefined ? sourceLot?.promotional_price : promotionalPrice);
  const changedFields = [
    ...(!sameNullableMoney(option.price, requestedPrice) ? ['price'] : []),
    ...(!sameNullableMoney(option.purchase_price, requestedPurchasePrice) ? ['purchase_price'] : []),
    ...(!sameNullableMoney(option.promotional_price, requestedPromotionalPrice) ? ['promotional_price'] : [])
  ];
  if (!changedFields.length || confirm === true) return null;
  return buildPriceConflictPayload({
    productId,
    variantId,
    warehouseId: destinationWarehouseId,
    option,
    price: requestedPrice,
    purchasePrice: requestedPurchasePrice,
    promotionalPrice: requestedPromotionalPrice,
    changedFields
  });
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
    const movementMeta = getMovementMeta(movement);
    const priceChanges = getMovementPriceChanges(movement).map((change) => ({
      ...change,
      ...(movementMeta.is_new_association === true ? { is_new_association: true } : {})
    }));

    return AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
      company_id: companyId,
      action: getMovementAuditAction(movement.movement_type, isBulk),
      result: "success",
      related_resource_type: "inventory_movement",
      related_resource_id: movement.id,
      job_id: null,
      previous_value: {
        stock: movement.stock_before,
        ...Object.fromEntries(priceChanges.map((change) => [change.field, change.old_value]))
      },
      new_value: {
        stock: movement.stock_after,
        ...Object.fromEntries(priceChanges.map((change) => [change.field, change.new_value]))
      },
      changes: [{
        field: "stock",
        old_value: movement.stock_before,
        new_value: movement.stock_after
      }, ...priceChanges],
      description: getMovementDescription(movement, productLabel),
      correlation_id: referenceId,
      metadata: {
        is_new_variant: movementMeta.is_new_variant === true,
        is_new_association: movementMeta.is_new_association === true,
        new_variant_id: movementMeta.new_variant_id || null,
        source_variant_id: movementMeta.source_variant_id || null,
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

function hasGlobalVariantCreationFields(payload = {}) {
  return payload?.create_new_variant === true ||
    (payload?.new_characteristic !== undefined && payload?.new_characteristic !== null) ||
    (payload?.new_variant_name !== undefined && payload?.new_variant_name !== null);
}

function hasInventoryVariantCreationRequest(payload = {}, { bulk = false } = {}) {
  if (hasGlobalVariantCreationFields(payload)) return true;

  if (bulk && Array.isArray(payload.products)) {
    return payload.products.some((product) =>
      hasGlobalVariantCreationFields(product) ||
      normalizeVariantsInput(product?.variants).variants.some(hasGlobalVariantCreationFields)
    );
  }

  return normalizeVariantsInput(payload.variants).variants.some(hasGlobalVariantCreationFields);
}

function buildVariantCreationNotAllowedError() {
  return {
    success: false,
    code: 'VARIANT_CREATION_NOT_ALLOWED_IN_INVENTORY',
    message: 'Las variantes globales deben crearse desde Productos. Este flujo solo puede asociar variantes existentes al almacén.'
  };
}

async function validateProductVariantIds(productId, variantsData) {
  const productVariants = await ProductVariantRepository.findByProductId(productId);
  const productVariantIds = new Set(productVariants.map((variant) => Number(variant.id)));
  const invalidVariant = variantsData.find((variantData) => {
    const variantId = Number(variantData.variant_id);
    return !Number.isInteger(variantId) || variantId <= 0 || !productVariantIds.has(variantId);
  });

  if (invalidVariant) {
    throw createWarehouseVariantFlowError(
      'La variante indicada debe existir previamente en el producto',
      'VARIANT_DOES_NOT_BELONG_TO_PRODUCT',
      400
    );
  }

  return productVariants;
}

function getRequestedWarehouseProductVariantId(variantData = {}) {
  return variantData.warehouse_product_variant_id !== undefined &&
    variantData.warehouse_product_variant_id !== null
    ? variantData.warehouse_product_variant_id
    : variantData.lot_id;
}

async function validateWarehouseProductContext(record, body = {}, { warehouse, product } = {}) {
  const validateMatch = (field, requestedValue, currentValue) => {
    if (requestedValue === undefined || requestedValue === null || requestedValue === '' ||
        currentValue === undefined || currentValue === null || currentValue === '') {
      return;
    }

    if (Number(requestedValue) !== Number(currentValue)) {
      throw createWarehouseVariantFlowError(
        `El ${field} no coincide con el warehouse_product indicado`,
        'WAREHOUSE_PRODUCT_CONTEXT_MISMATCH'
      );
    }
  };

  validateMatch('product_id', body.product_id, record.product_id);
  validateMatch('warehouse_id', body.warehouse_id, record.warehouse_id);

  if (body.company_id !== undefined && body.company_id !== null && body.company_id !== '') {
    const companyIds = [record.company_id, warehouse?.company_id, product?.company_id]
      .filter((companyId) => companyId !== undefined && companyId !== null && companyId !== '');

    if ((!warehouse?.company_id || companyIds.length === 0) && warehouse?.branch_id) {
      const branch = await BranchRepository.findById(warehouse.branch_id);
      if (branch?.company_id !== undefined && branch?.company_id !== null) {
        companyIds.push(branch.company_id);
      }
    }

    if (companyIds.some((companyId) => Number(companyId) !== Number(body.company_id))) {
      throw createWarehouseVariantFlowError(
        'El company_id no coincide con el producto, almacén o sucursal indicados',
        'WAREHOUSE_PRODUCT_CONTEXT_MISMATCH'
      );
    }
  }
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

function buildPriceChanges(previous, current) {
  const previousValues = previous || {};
  const currentValues = current || {};
  return ['price', 'purchase_price', 'promotional_price']
    .map((field) => ({
      field,
      old_value: normalizeNullableMoneyValue(previousValues[field]),
      new_value: normalizeNullableMoneyValue(currentValues[field])
    }))
    .filter((change) => !sameNullableMoney(change.old_value, change.new_value));
}

function buildPriceConflictPayload({ productId, variantId, warehouseId, option, price, purchasePrice, promotionalPrice, changedFields }) {
  return {
    success: false,
    code: 'PRODUCT_OPTION_PRICE_CONFLICT',
    message: 'La opción ya existe con otro precio',
    option: {
      product_id: productId,
      product_variant_id: Number(variantId),
      variant_id: Number(variantId),
      warehouse_id: warehouseId,
      warehouse_product_variant_id: option.id,
      current_price: normalizeNullableMoneyValue(option.price),
      current_purchase_price: normalizeNullableMoneyValue(option.purchase_price),
      current_promotional_price: normalizeNullableMoneyValue(option.promotional_price)
    },
    requested: {
      price: normalizeNullableMoneyValue(price),
      purchase_price: normalizeNullableMoneyValue(purchasePrice),
      promotional_price: normalizeNullableMoneyValue(promotionalPrice)
    },
    changed_fields: changedFields
  };
}

function buildWarehouseProductVariantResponse(variant, { warehouseId, productId } = {}) {
  const plain = toPlain(variant) || {};
  return {
    id: plain.id,
    warehouse_id: warehouseId,
    product_id: productId,
    product_variant_id: plain.variant_id,
    price: normalizeNullableMoneyValue(plain.price),
    purchase_price: normalizeNullableMoneyValue(plain.purchase_price),
    promotional_price: normalizeNullableMoneyValue(plain.promotional_price)
  };
}

function createWarehouseVariantFlowError(message, code = 'WAREHOUSE_PRODUCT_VARIANT_CREATE_ERROR', statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  return error;
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
        const submittedVariantIds = variantsData
          .map((variant) => Number(variant.variant_id))
          .filter((variantId) => Number.isInteger(variantId));
        const invalidVariantId = submittedVariantIds.find(
          (variantId) => !productVariantsById.has(variantId)
        );
        if (invalidVariantId) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            code: 'VARIANT_DOES_NOT_BELONG_TO_PRODUCT',
            message: 'La opción no pertenece al producto indicado'
          });
        }
        if (new Set(submittedVariantIds).size !== submittedVariantIds.length) {
          await transaction.rollback();
          return res.status(409).json({
            success: false,
            code: 'PRODUCT_OPTION_DUPLICATE',
            message: 'La combinación de características está repetida'
          });
        }
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

    if (hasInventoryVariantCreationRequest(req.body)) {
      return res.status(400).json(buildVariantCreationNotAllowedError());
    }

    const {
      id,
      active,
      code,
      branch_id,
      minimum_stock,
      variants: variantsString
    } = req.body;
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
      await validateWarehouseProductContext(record, req.body, {
        warehouse,
        product: productRecord
      });
      // La compañía puede estar asociada indirectamente mediante la sucursal.
      // Resolverla antes de escribir permite que la auditoría no falle después
      // de confirmar la transacción por un company_id nulo.
      const auditCompanyId = warehouse
        ? (req.body.company_id ||
          record.company_id ||
          warehouse.company_id ||
          await _resolveCompanyFromWarehouse(record.warehouse_id))
        : null;

      const variantAuditDetails = [];
      let totalStockAdded = 0;
      let createdLotsCount = 0;
      let updatedLotsCount = 0;
      let updatedWarehouseProductVariant = null;
      const updatedWarehouseProductVariants = [];

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
        const productVariants = await validateProductVariantIds(record.product_id, variantsData);
        const productVariantsById = new Map(
          productVariants.map((variant) => [Number(variant.id), variant])
        );
        // 👉 4. Obtener variantes existentes en la BD para este warehouse_product
        const existingVariants =
          await WarehouseProductVariantRepository.findByWarehouseProductId(id);
        const existingById = new Map();
        existingVariants.forEach((v) => {
          existingById.set(Number(v.id), v);
        });

        // Mapa para buscar por `variant_id` + `custom_name` (clave única para variantes personalizadas)
        const existingByKey = new Map();
        existingVariants.forEach((v) => {
          const key = v.variant_id
            ? `global-${v.variant_id}`
            : `custom-${v.custom_name || ""}`;
          existingByKey.set(key, v);
        });

        // 👉 5. Actualizar o crear la relación de la variante en el almacén.
        // Mientras los lotes no estén habilitados, el precio no forma parte
        // de la identidad de la opción.
        const processedIds = new Set();
        const referenceId = uuidv4(); // ID único para esta operación de actualización

         // Validar todos los precios antes de comenzar a escribir. Esto permite
         // que una sola solicitud informe cada conflicto y evita procesar
         // parcialmente las variantes anteriores al primer conflicto.
        const priceConflicts = [];
        for (const variantData of variantsData) {
          const {
            variant_id,
            price,
            purchase_price,
            promotional_price
          } = variantData;

          const requestedWarehouseProductVariantId =
            getRequestedWarehouseProductVariantId(variantData);

          // La confirmación se procesa sobre la asociación existente. La
          // detección de conflictos sin autorización aplica a opciones sin ese
          // identificador.
          if (requestedWarehouseProductVariantId !== undefined &&
              requestedWarehouseProductVariantId !== null) {
            continue;
          }

          const currentOption = existingVariants
            .filter((candidate) => Number(candidate.variant_id) === Number(variant_id))
            .sort((left, right) => Number(right.id) - Number(left.id))[0];
          if (!currentOption) continue;

          const hasPrice = price !== undefined && price !== null;
          const hasPurchasePrice = purchase_price !== undefined && purchase_price !== null;
          const hasPromotionalPrice = promotional_price !== undefined;
          const requestedPrice = hasPrice ? normalizeMoneyValue(price) : null;
          const requestedPurchasePrice = hasPurchasePrice
            ? normalizeMoneyValue(purchase_price)
            : null;
          const requestedPromotionalPrice = hasPromotionalPrice
            ? normalizeNullableMoneyValue(promotional_price)
            : null;
          const salePriceConflict = hasPrice && !sameNullableMoney(currentOption.price, requestedPrice);
          const purchasePriceConflict = hasPurchasePrice && !sameNullableMoney(
            currentOption.purchase_price,
            requestedPurchasePrice
          );
          const promotionalPriceConflict = hasPromotionalPrice && !sameNullableMoney(
            currentOption.promotional_price,
            requestedPromotionalPrice
          );

          logger.info(
            `[DEBUG] Validando conflicto de precios: variante=${variant_id}, ` +
            `actual_price=${normalizeNullableMoneyValue(currentOption.price)}, solicitado_price=${requestedPrice}, ` +
            `actual_purchase_price=${normalizeNullableMoneyValue(currentOption.purchase_price)}, ` +
            `solicitado_purchase_price=${requestedPurchasePrice}, ` +
            `actual_promotional_price=${normalizeNullableMoneyValue(currentOption.promotional_price)}, ` +
            `solicitado_promotional_price=${requestedPromotionalPrice}, ` +
            `sale_conflict=${salePriceConflict}, purchase_conflict=${purchasePriceConflict}, ` +
            `promotional_conflict=${promotionalPriceConflict}`
          );

          if (salePriceConflict || purchasePriceConflict || promotionalPriceConflict) {
            priceConflicts.push({
              success: false,
              code: 'PRODUCT_OPTION_PRICE_CONFLICT',
              message: 'La opción ya existe con otro precio',
              option: {
                product_id: record.product_id,
                product_variant_id: Number(variant_id),
                variant_id: Number(variant_id),
                warehouse_id: record.warehouse_id,
                warehouse_product_variant_id: currentOption.id,
                current_price: normalizeNullableMoneyValue(currentOption.price),
                current_purchase_price: normalizeNullableMoneyValue(currentOption.purchase_price),
                current_promotional_price: normalizeNullableMoneyValue(currentOption.promotional_price)
              },
              requested: {
                price: hasPrice ? requestedPrice : null,
                purchase_price: hasPurchasePrice ? requestedPurchasePrice : null,
                promotional_price: hasPromotionalPrice ? requestedPromotionalPrice : null
              },
              changed_fields: [
                ...(salePriceConflict ? ['price'] : []),
                ...(purchasePriceConflict ? ['purchase_price'] : []),
                ...(promotionalPriceConflict ? ['promotional_price'] : [])
              ]
            });
          }
        }

        if (priceConflicts.length) {
          await transaction.rollback();
          return res.status(409).json({
            ...priceConflicts[0],
            ...(priceConflicts.length > 1
              ? {
                  conflicts: priceConflicts,
                  options: priceConflicts.map((conflict) => conflict.option)
                }
              : {})
          });
        }

        logger.info(`[DEBUG] Procesando ${variantsData.length} variantes para warehouse_product ${id}`);
        logger.info(`[DEBUG] Variantes existentes en BD: ${existingVariants.length}`);

        for (const variantData of variantsData) {
          const {
            id: variantClientId, // opcional, si viene del frontend
            variant_id,
            warehouse_product_variant_id,
            lot_id,
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

          // Buscar la relación existente por la variante del producto. Los
          // precios son datos editables de la misma opción; una variante global
          // sin asociación todavía solo crea el registro del almacén.
          let existingWithSamePrice = null;
          const requestedWarehouseProductVariantId =
            getRequestedWarehouseProductVariantId({
              warehouse_product_variant_id,
              lot_id
            });
          if (requestedWarehouseProductVariantId !== undefined &&
              requestedWarehouseProductVariantId !== null) {
            existingWithSamePrice = existingById.get(Number(requestedWarehouseProductVariantId)) || null;
            if (!existingWithSamePrice || Number(existingWithSamePrice.variant_id) !== Number(variant_id)) {
              await transaction.rollback();
              return res.status(400).json({
                success: false,
                code: 'WAREHOUSE_PRODUCT_VARIANT_NOT_FOUND',
                message: 'La opción no pertenece al almacén indicado'
              });
            }
          }
          if (!existingWithSamePrice) {
            const candidates = existingVariants.filter(v => {
              const vNormalizedVariantId = v.variant_id != null ? String(v.variant_id) : null;
              const vKey = `global-${vNormalizedVariantId}`;
              const variantMatches = vKey === key;
              const activeMatches = v.active !== false;
              const optionMatches = variantMatches && activeMatches;

              logger.info(`[DEBUG] Comparando opción existente: key=${vKey}, local_sku=${v.local_sku || null}, price=${v.price}, purchase_price=${v.purchase_price}, match=${optionMatches}`);

              return optionMatches;
            });
            candidates.sort((a, b) => {
              const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
              const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
              if (aTime !== bTime) return bTime - aTime;
              return (b.id || 0) - (a.id || 0);
            });
            existingWithSamePrice = candidates[0] || null;
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
            const previousVariant = toPlain(existingWithSamePrice);
            
            // ✅ Misma opción: incrementar stock y actualizar sus precios.
            if (hasStock) {
              const oldStock = existingWithSamePrice.stock || 0;
              const stockAdded = parseInt(stock) || 0;
              const newStock = oldStock + stockAdded;
              await existingWithSamePrice.update({
                ...variantToUpdate,
                stock: newStock
              }, { transaction });
               updatedWarehouseProductVariant = existingWithSamePrice;
               updatedWarehouseProductVariants.push(existingWithSamePrice);

              // ⭐ REGISTRAR MOVIMIENTO DE INVENTARIO (entrada de stock)
              if (stockAdded > 0) {
                await InventoryMovementRepository.create({
                  warehouse_id: record.warehouse_id,
                  product_id: record.product_id,
                  variant_id: variant_id || null,
                  company_id: record.company_id,
                  branch_id: record.branch_id,
                  movement_type: 'entry',
                  quantity: stockAdded,
                  stock_before: oldStock,
                  stock_after: newStock,
                  unit_price: hasPrice ? (parseFloat(price) || 0) : (parseFloat(existingWithSamePrice.price) || 0),
                  purchase_price: hasPurchasePrice ? (parseFloat(purchase_price) || 0) : (parseFloat(existingWithSamePrice.purchase_price) || 0),
                  total_value: (parseFloat(purchase_price) || 0) * stockAdded,
                  reference_type: 'warehouse_product_update',
                  reference_id: referenceId,
                  user_id: metadata.user_id,
                  notes: `Se agregaron ${stockAdded} unidades al stock existente.`,
                  meta: {
                    operation: 'warehouse_product_update',
                    warehouse_product_id: id,
                    lot_matched: true,
                    existing_variant_id: existingWithSamePrice.id
                  }
                }, { transaction });
              }
              totalStockAdded += Math.max(stockAdded, 0);
              variantAuditDetails.push({
                variant_id,
                warehouse_product_variant_id: existingWithSamePrice.id,
                is_new_variant: false,
                variante: getVariantAuditLabel(productVariantsById.get(Number(variant_id)), variantData),
                operacion: stockAdded > 0 ? 'Stock agregado a lote existente' : 'Configuración de variante actualizada',
                stock_anterior: oldStock,
                cantidad_agregada: stockAdded,
                stock_nuevo: newStock,
                sku_local: hasLocalSku ? (local_sku || null) : (existingWithSamePrice.local_sku || null),
                precio_de_venta: hasPrice ? normalizedPrice : normalizeMoneyValue(existingWithSamePrice.price),
                precio_de_compra: hasPurchasePrice ? normalizedPurchasePrice : normalizeMoneyValue(existingWithSamePrice.purchase_price),
                precio_promocional: hasPromotionalPrice ? normalizedPromotionalPrice : existingWithSamePrice.promotional_price,
                estado: hasActive ? (activeVariant !== false ? 'Activo' : 'Inactivo') : (existingWithSamePrice.active !== false ? 'Activo' : 'Inactivo'),
                publicar: hasPublished ? (published ? 'Sí' : 'No') : (existingWithSamePrice.published ? 'Sí' : 'No'),
                cambios: buildWarehouseVariantAuditChanges(previousVariant, existingWithSamePrice)
              });
            } else {
              await existingWithSamePrice.update(variantToUpdate, { transaction });
               updatedWarehouseProductVariant = existingWithSamePrice;
               updatedWarehouseProductVariants.push(existingWithSamePrice);
              variantAuditDetails.push({
                variant_id,
                warehouse_product_variant_id: existingWithSamePrice.id,
                is_new_variant: false,
                variante: getVariantAuditLabel(productVariantsById.get(Number(variant_id)), variantData),
                operacion: 'Configuración de variante actualizada',
                stock_anterior: existingWithSamePrice.stock || 0,
                stock_nuevo: existingWithSamePrice.stock || 0,
                sku_local: hasLocalSku ? (local_sku || null) : (existingWithSamePrice.local_sku || null),
                precio_de_venta: hasPrice ? normalizedPrice : normalizeMoneyValue(existingWithSamePrice.price),
                precio_de_compra: hasPurchasePrice ? normalizedPurchasePrice : normalizeMoneyValue(existingWithSamePrice.purchase_price),
                precio_promocional: hasPromotionalPrice ? normalizedPromotionalPrice : existingWithSamePrice.promotional_price,
                estado: hasActive ? (activeVariant !== false ? 'Activo' : 'Inactivo') : (existingWithSamePrice.active !== false ? 'Activo' : 'Inactivo'),
                publicar: hasPublished ? (published ? 'Sí' : 'No') : (existingWithSamePrice.published ? 'Sí' : 'No'),
                cambios: buildWarehouseVariantAuditChanges(previousVariant, existingWithSamePrice)
              });
            }
            updatedLotsCount += 1;
            processedIds.add(existingWithSamePrice.id);
          } else {
            logger.info(`[DEBUG] No se encontró la opción en el almacén, creando relación nueva`);
            
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
             updatedWarehouseProductVariant = newVariant;
             updatedWarehouseProductVariants.push(newVariant);

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
            const initialStock = hasStock ? (parseInt(stock) || 0) : 0;
            totalStockAdded += Math.max(initialStock, 0);
            createdLotsCount += 1;
            variantAuditDetails.push({
              variant_id: newVariant.variant_id,
              warehouse_product_variant_id: newVariant.id,
              is_new_variant: false,
              is_new_association: true,
              variante: getVariantAuditLabel(productVariantsById.get(Number(variant_id)), variantData),
              operacion: 'Variante global asociada al almacén',
              stock_anterior: 0,
              cantidad_agregada: initialStock,
              stock_nuevo: initialStock,
              sku_local: createData.local_sku,
              precio_de_venta: createData.price,
              precio_de_compra: createData.purchase_price,
              precio_promocional: createData.promotional_price,
              estado: createData.active ? 'Activo' : 'Inactivo',
              publicar: createData.published ? 'Sí' : 'No',
              cambios: markNewWarehouseAssociationAuditChanges(
                buildWarehouseVariantAuditChanges(null, newVariant)
              )
            });
            
            processedIds.add(newVariant.id);
          }
        }

        logger.info(
          `Variantes sincronizadas para warehouse_product ${id}: ${variantsData.length} enviadas, ${existingVariants.length} anteriores, ${processedIds.size} procesadas/actualizadas`
        );
      }
      await transaction.commit();

      const recordChanges = detectChanges(previousRecord, toPlain(record), ["active", "code", "minimum_stock"]);
      const variantAuditChanges = variantAuditDetails.flatMap((detail) => detail.cambios || []);
      const auditChanges = [...recordChanges, ...variantAuditChanges];
      const auditPreviousValue = changesToValueSnapshot(auditChanges, "old_value");
      const auditNewValue = changesToValueSnapshot(auditChanges, "new_value");
      if (variantAuditDetails.length > 0) {
        auditNewValue.variantes_procesadas = variantAuditDetails.length;
        auditNewValue.total_stock_agregado = totalStockAdded;
      }
      if (warehouse) {
        await AuditEventService.safeRecordFromRequest(req, buildWarehouseAuditPayload(warehouse, {
          company_id: auditCompanyId,
          action: "warehouse.product_config_updated",
          result: "success",
          related_resource_type: "product",
          related_resource_id: record.product_id,
          previous_value: auditPreviousValue,
          new_value: auditNewValue,
          changes: auditChanges,
          description: totalStockAdded > 0
            ? `Stock y configuración de producto actualizados en almacén: ${productRecord ? getProductAuditLabel(productRecord) : 'Producto'}`
            : `Configuración de producto modificada en almacén: ${productRecord ? getProductAuditLabel(productRecord) : 'Producto'}`,
          metadata: {
            producto: productRecord ? getProductAuditLabel(productRecord) : null,
            almacen: getWarehouseAuditLabel(warehouse),
            variantes_procesadas: variantAuditDetails.length,
            total_stock_agregado: totalStockAdded,
            lotes_creados: createdLotsCount,
            lotes_actualizados: updatedLotsCount,
            detalle_de_variantes: variantAuditDetails
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
        message: "Opción actualizada correctamente",
        warehouse_product_variant: updatedWarehouseProductVariant
          ? buildWarehouseProductVariantResponse(updatedWarehouseProductVariant, {
              warehouseId: record.warehouse_id,
              productId: record.product_id
            })
          : null,
        ...(updatedWarehouseProductVariants.length > 1
          ? {
              warehouse_product_variants: updatedWarehouseProductVariants.map((variant) =>
                buildWarehouseProductVariantResponse(variant, {
                  warehouseId: record.warehouse_id,
                  productId: record.product_id
                })
              )
            }
          : {})
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

      if (error.statusCode) {
        return res.status(error.statusCode).json({
          success: false,
          code: error.code,
          message: error.message
        });
      }

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

  if (hasInventoryVariantCreationRequest(req.body)) {
    return res.status(400).json(buildVariantCreationNotAllowedError());
  }

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
    await validateProductVariantIds(product.id, variantsData);

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

    if (movement_type === 'transfer') {
      for (const variantData of variantsData) {
        const requestedLotId = variantData.warehouse_product_variant_id ?? variantData.lot_id;
        const originOption = requestedLotId != null
          ? originWpVariants.find((candidate) => Number(candidate.id) === Number(requestedLotId) && Number(candidate.variant_id) === Number(variantData.variant_id))
          : originWpVariants.find((candidate) => Number(candidate.variant_id) === Number(variantData.variant_id));
        if (!originOption) {
          await transaction.rollback();
          return res.status(400).json({
            success: false,
            code: 'WAREHOUSE_PRODUCT_VARIANT_NOT_FOUND',
            message: `La variante ${variantData.variant_id} no pertenece al almacén de origen`,
            option: {
              product_id: product.id,
              product_variant_id: Number(variantData.variant_id),
              variant_id: Number(variantData.variant_id),
              warehouse_id: origin_warehouse_id,
              warehouse_product_variant_id: requestedLotId ?? null
            }
          });
        }
      }
    }

    if (movement_type === 'entry') {
      const conflicts = [];
      for (const variantData of variantsData) {
        const variantId = variantData.variant_id;
        const option = variantData.warehouse_product_variant_id != null
          ? originWpVariants.find((candidate) => Number(candidate.id) === Number(variantData.warehouse_product_variant_id) && Number(candidate.variant_id) === Number(variantId))
          : originWpVariants
            .filter((candidate) => Number(candidate.variant_id) === Number(variantId))
            .sort((left, right) => Number(right.id) - Number(left.id))[0];
        if (!option) continue;
        const requestedPrice = variantData.price === undefined ? option.price : variantData.price;
        const requestedPurchasePrice = variantData.purchase_price === undefined ? option.purchase_price : variantData.purchase_price;
        const requestedPromotionalPrice = variantData.promotional_price === undefined ? option.promotional_price : variantData.promotional_price;
        const changedFields = [
          ...(!sameNullableMoney(option.price, requestedPrice) ? ['price'] : []),
          ...(!sameNullableMoney(option.purchase_price, requestedPurchasePrice) ? ['purchase_price'] : []),
          ...(!sameNullableMoney(option.promotional_price, requestedPromotionalPrice) ? ['promotional_price'] : [])
        ];
        if (changedFields.length && !(variantData.warehouse_product_variant_id != null && variantData.confirm_price_change === true)) {
          conflicts.push(buildPriceConflictPayload({
            productId: product.id, variantId, warehouseId: origin_warehouse_id, option,
            price: requestedPrice, purchasePrice: requestedPurchasePrice,
            promotionalPrice: requestedPromotionalPrice, changedFields
          }));
        }
      }
      if (conflicts.length) {
        await transaction.rollback();
        return res.status(409).json({
          ...conflicts[0],
          ...(conflicts.length > 1 ? { conflicts, options: conflicts.map((item) => item.option) } : {})
        });
      }
    }

    if (movement_type === 'transfer') {
      const conflicts = [];
      for (const variantData of variantsData) {
        const requestedLotId = variantData.warehouse_product_variant_id ?? variantData.lot_id;
        const sourceLot = originWpVariants.find((candidate) =>
          Number(candidate.variant_id) === Number(variantData.variant_id) &&
          (requestedLotId == null || Number(candidate.id) === Number(requestedLotId))
        );
        if (!sourceLot) continue;
        const conflict = await getTransferDestinationPriceConflict({
          productId: product.id,
          variantId: variantData.variant_id,
          destinationWarehouseId: destination_warehouse_id,
          destinationWarehouseProductId: destWp.id,
          sourceLot,
          price: variantData.price,
          purchasePrice: variantData.purchase_price,
          promotionalPrice: variantData.promotional_price,
          confirm: variantData.confirm_price_change
        });
        if (conflict) conflicts.push(conflict);
      }
      if (conflicts.length) {
        await transaction.rollback();
        return res.status(409).json({
          ...conflicts[0],
          conflicts,
          options: conflicts.map((item) => item.option)
        });
      }
    }

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
        const actualVariantId = Number(variant_id);
        const hasExistingAssociation = originWpVariants.some((candidate) =>
          Number(candidate.variant_id) === actualVariantId
        );

        const requestedWarehouseProductVariantId = variantData.warehouse_product_variant_id;
        const hasRequestedWarehouseProductVariantId =
          requestedWarehouseProductVariantId !== undefined &&
          requestedWarehouseProductVariantId !== null;
        let salePrice = normalizeNullableMoneyValue(price);
        let actualPurchasePrice = normalizeNullableMoneyValue(purchase_price);
        let effectivePromotionalPrice = normalizeNullableMoneyValue(promotional_price);
        let authorizedLot = null;

        if (hasRequestedWarehouseProductVariantId) {
          authorizedLot = originWpVariants.find((candidate) =>
            Number(candidate.id) === Number(requestedWarehouseProductVariantId) &&
            Number(candidate.variant_id) === Number(actualVariantId)
          );
          if (!authorizedLot) {
            await transaction.rollback();
            return res.status(400).json({
              success: false,
              code: 'WAREHOUSE_PRODUCT_VARIANT_NOT_FOUND',
              message: 'La opción no pertenece al almacén indicado'
            });
          }
        }
        {
          const currentOption = authorizedLot || originWpVariants
            .filter((candidate) => Number(candidate.variant_id) === Number(actualVariantId))
            .sort((left, right) => Number(right.id) - Number(left.id))[0];

          if (currentOption) {
            if (price === undefined) salePrice = normalizeNullableMoneyValue(currentOption.price);
            if (purchase_price === undefined) actualPurchasePrice = normalizeNullableMoneyValue(currentOption.purchase_price);
            if (promotional_price === undefined) effectivePromotionalPrice = normalizeNullableMoneyValue(currentOption.promotional_price);
            const salePriceConflict = !sameNullableMoney(currentOption.price, salePrice);
            const purchasePriceConflict = !sameNullableMoney(
              currentOption.purchase_price,
              actualPurchasePrice
            );
            const promotionalPriceConflict = !sameNullableMoney(
              currentOption.promotional_price,
              effectivePromotionalPrice
            );

            logger.info(
              `[DEBUG] Validando conflicto de precios en movimiento: variante=${actualVariantId}, ` +
              `actual_price=${normalizeNullableMoneyValue(currentOption.price)}, solicitado_price=${salePrice}, ` +
              `actual_purchase_price=${normalizeNullableMoneyValue(currentOption.purchase_price)}, ` +
              `solicitado_purchase_price=${actualPurchasePrice}, ` +
              `actual_promotional_price=${normalizeNullableMoneyValue(currentOption.promotional_price)}, ` +
              `solicitado_promotional_price=${normalizeNullableMoneyValue(effectivePromotionalPrice)}, ` +
              `sale_conflict=${salePriceConflict}, purchase_conflict=${purchasePriceConflict}, ` +
              `promotional_conflict=${promotionalPriceConflict}`
            );

            if ((salePriceConflict || purchasePriceConflict || promotionalPriceConflict) &&
                !(authorizedLot && variantData.confirm_price_change === true)) {
              await transaction.rollback();
              return res.status(409).json({
                success: false,
                code: 'PRODUCT_OPTION_PRICE_CONFLICT',
                message: 'La opción ya existe con otro precio',
                option: {
                  product_id: product.id,
                  product_variant_id: Number(actualVariantId),
                  variant_id: Number(actualVariantId),
                  warehouse_id: origin_warehouse_id,
                  warehouse_product_variant_id: currentOption.id,
                  current_price: normalizeNullableMoneyValue(currentOption.price),
                  current_purchase_price: normalizeNullableMoneyValue(currentOption.purchase_price),
                  current_promotional_price: normalizeNullableMoneyValue(currentOption.promotional_price)
                },
                requested: {
                  price: salePrice,
                  purchase_price: actualPurchasePrice,
                  promotional_price: normalizeNullableMoneyValue(effectivePromotionalPrice)
                },
                changed_fields: [
                  ...(salePriceConflict ? ['price'] : []),
                  ...(purchasePriceConflict ? ['purchase_price'] : []),
                  ...(promotionalPriceConflict ? ['promotional_price'] : [])
                ]
              });
            }
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
        const effectiveLocalSku = local_sku || product.sku;
        
        // Crear nuevo lote con su precio de compra específico
        const totalStockBeforeEntry = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
          actualVariantId,
          originWp.id
        );
        const stockBefore = totalStockBeforeEntry?.total_stock || 0;
        const stockAfter = stockBefore + quantity;

        const matchingLot = authorizedLot || await WarehouseProductVariantRepository.findMatchingLotByVariantAndWarehouse({
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
            active: true,
            price: salePrice,
            purchase_price: actualPurchasePrice,
            promotional_price: effectivePromotionalPrice
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
            is_new_association: !hasExistingAssociation,
            lot_id: affectedLot.id,
            purchase_price: actualPurchasePrice,
            sale_price: salePrice,
            price_changes: [
              { field: 'price', old_value: lotCreated ? null : normalizeNullableMoneyValue(matchingLot.price), new_value: salePrice },
              { field: 'purchase_price', old_value: lotCreated ? null : normalizeNullableMoneyValue(matchingLot.purchase_price), new_value: actualPurchasePrice },
              { field: 'promotional_price', old_value: lotCreated ? null : normalizeNullableMoneyValue(matchingLot.promotional_price), new_value: effectivePromotionalPrice }
            ].filter((change) => !sameNullableMoney(change.old_value, change.new_value))
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
        let originLots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
          variant_id,
          originWp.id
        );

        const requestedTransferLotId = variantData.warehouse_product_variant_id ?? variantData.lot_id;
        if (requestedTransferLotId != null) {
          originLots = originLots.filter((lot) => Number(lot.id) === Number(requestedTransferLotId));
        }

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

        const transferPriceConflict = await getTransferDestinationPriceConflict({
          productId: product.id,
          variantId: variant_id,
          destinationWarehouseId: destination_warehouse_id,
          destinationWarehouseProductId: destWp.id,
          sourceLot: originLots[0],
          price: price,
          purchasePrice: purchase_price === undefined ? weightedAvgPurchasePrice : purchase_price,
          promotionalPrice: promotional_price,
          confirm: variantData.confirm_price_change
        });
        if (transferPriceConflict) {
          await transaction.rollback();
          return res.status(409).json({
            ...transferPriceConflict,
            conflicts: [transferPriceConflict],
            options: [transferPriceConflict.option]
          });
        }

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

        // Una confirmación explícita autoriza actualizar la opción existente del
        // destino. No se debe crear otro lote solo porque cambió el costo.
        let destLotConsolidated = null;
        if (destLots && destLots.length > 0) {
          destLotConsolidated = variantData.confirm_price_change === true
            ? destLots[0]
            : destLots.find(lot =>
                Math.abs(parseFloat(lot.purchase_price) - weightedAvgPurchasePrice) < 0.01
              );
        }
        const destinationAssociationCreated = !destLots || destLots.length === 0;

        const destinationPrices = {
          price: price === undefined ? originLots[0]?.price : price,
          purchase_price: purchase_price === undefined ? weightedAvgPurchasePrice : purchase_price,
          promotional_price: promotional_price === undefined
            ? originLots[0]?.promotional_price
            : promotional_price
        };
        const destinationPriceChanges = buildPriceChanges(
          destLotConsolidated,
          destinationPrices
        );

        const totalStockBeforeDestInfo = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
          variant_id,
          destWp.id
        );
        const totalStockBeforeDest = totalStockBeforeDestInfo?.total_stock || 0;

        if (destLotConsolidated) {
          // Con confirmación se actualiza la misma asociación; sin confirmación
          // se conserva el comportamiento de consolidar solo por costo.
          const newStock = destLotConsolidated.stock + quantity;
          
          await WarehouseProductVariantRepository.update(destLotConsolidated, {
            stock: newStock,
            ...(variantData.confirm_price_change === true ? {
              price: normalizeNullableMoneyValue(destinationPrices.price),
              purchase_price: normalizeNullableMoneyValue(destinationPrices.purchase_price),
              promotional_price: normalizeNullableMoneyValue(destinationPrices.promotional_price)
            } : {})
          }, { transaction });
        } else {
          // Crear nuevo lote en destino con el purchase_price promedio de la transferencia
          await WarehouseProductVariantRepository.create({
            warehouse_product_id: destWp.id,
            variant_id,
            active: true,
            published: false,
            local_sku: originLots[0]?.local_sku || null,
            price: normalizeNullableMoneyValue(destinationPrices.price),
            promotional_price: normalizeNullableMoneyValue(destinationPrices.promotional_price),
            purchase_price: normalizeNullableMoneyValue(destinationPrices.purchase_price),
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
            purchase_price_preserved: weightedAvgPurchasePrice,
            is_new_association: destinationAssociationCreated,
            price_changes: destinationPriceChanges
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

    if (error.apiResponse) {
      return res.status(error.statusCode || 409).json(error.apiResponse);
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }

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

  if (hasInventoryVariantCreationRequest(req.body, { bulk: true })) {
    return res.status(400).json(buildVariantCreationNotAllowedError());
  }

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
    // Validar todos los conflictos antes de procesar el primer producto.
    // Así el frontend puede decidir sobre cada variante de la operación.
    const bulkPriceConflicts = await _collectBulkPriceConflicts({
      movement_type,
      originWarehouse,
      destWarehouse,
      products
    });
    if (bulkPriceConflicts.length) {
      const error = createWarehouseVariantFlowError(
        'La opción ya existe con otro precio',
        'PRODUCT_OPTION_PRICE_CONFLICT',
        409
      );
      error.apiResponse = {
        ...bulkPriceConflicts[0],
        ...(bulkPriceConflicts.length > 1
          ? {
              conflicts: bulkPriceConflicts,
              options: bulkPriceConflicts.map((item) => item.option)
            }
          : {})
      };
      throw error;
    }

    // === Procesar cada producto ===
    for (const productData of products) {
      await _processProductMovement({
        movement_type,
        originWarehouse,
        destWarehouse,
        ...productData,
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

    if (error.apiResponse) {
      return res.status(error.statusCode || 409).json(error.apiResponse);
    }
    if (error.statusCode) {
      return res.status(error.statusCode).json({
        success: false,
        code: error.code,
        message: error.message
      });
    }

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

/**
 * Valida todos los productos de una operación masiva antes de comenzar a
 * modificar stock, lotes o asociaciones. Es importante que esta validación
 * sea global: procesar producto por producto hacía que el primer conflicto
 * abortara la operación y ocultara los siguientes al frontend.
 */
async function _collectBulkPriceConflicts({
  movement_type,
  originWarehouse,
  destWarehouse,
  products = []
}) {
  const conflicts = [];

  for (const productData of products) {
    const product = await ProductRepository.findById(productData.product_id);
    if (!product) continue;

    const normalizedVariants = normalizeVariantsInput(productData.variants, { required: true });
    if (!normalizedVariants.ok) continue;
    const variantsData = normalizedVariants.variants.map(normalizeMovementVariantPayload);

    const originWp = await WarehouseProductRepository.findByWarehouseAndProduct(
      originWarehouse.id,
      productData.product_id
    );
    if (!originWp) continue;

    const originWpVariants = await WarehouseProductVariantRepository.findByWarehouseProductId(originWp.id);
    let destWp = null;
    if (movement_type === 'transfer') {
      destWp = await WarehouseProductRepository.findByWarehouseAndProduct(
        destWarehouse.id,
        productData.product_id
      );
      if (!destWp) continue;
    }

    for (const variantData of variantsData) {
      if (movement_type === 'entry') {
        const variantId = variantData.variant_id;
        const option = variantData.warehouse_product_variant_id != null
          ? originWpVariants.find((candidate) =>
              Number(candidate.id) === Number(variantData.warehouse_product_variant_id) &&
              Number(candidate.variant_id) === Number(variantId)
            )
          : originWpVariants
              .filter((candidate) => Number(candidate.variant_id) === Number(variantId))
              .sort((left, right) => Number(right.id) - Number(left.id))[0];
        if (!option) continue;

        const requestedPrice = variantData.price === undefined ? option.price : variantData.price;
        const requestedPurchasePrice = variantData.purchase_price === undefined
          ? option.purchase_price
          : variantData.purchase_price;
        const requestedPromotionalPrice = variantData.promotional_price === undefined
          ? option.promotional_price
          : variantData.promotional_price;
        const changedFields = [
          ...(!sameNullableMoney(option.price, requestedPrice) ? ['price'] : []),
          ...(!sameNullableMoney(option.purchase_price, requestedPurchasePrice) ? ['purchase_price'] : []),
          ...(!sameNullableMoney(option.promotional_price, requestedPromotionalPrice)
            ? ['promotional_price']
            : [])
        ];

        if (
          changedFields.length &&
          !(variantData.warehouse_product_variant_id != null && variantData.confirm_price_change === true)
        ) {
          conflicts.push(buildPriceConflictPayload({
            productId: product.id,
            variantId,
            warehouseId: originWarehouse.id,
            option,
            price: requestedPrice,
            purchasePrice: requestedPurchasePrice,
            promotionalPrice: requestedPromotionalPrice,
            changedFields
          }));
        }
        continue;
      }

      if (movement_type === 'transfer') {
        const requestedLotId = variantData.warehouse_product_variant_id ?? variantData.lot_id;
        const sourceLot = originWpVariants.find((candidate) =>
          Number(candidate.variant_id) === Number(variantData.variant_id) &&
          (requestedLotId == null || Number(candidate.id) === Number(requestedLotId))
        );
        if (!sourceLot) continue;

        const conflict = await getTransferDestinationPriceConflict({
          productId: product.id,
          variantId: variantData.variant_id,
          destinationWarehouseId: destWarehouse.id,
          destinationWarehouseProductId: destWp.id,
          sourceLot,
          price: variantData.price,
          purchasePrice: variantData.purchase_price,
          promotionalPrice: variantData.promotional_price,
          confirm: variantData.confirm_price_change
        });
        if (conflict) conflicts.push(conflict);
      }
    }
  }

  return conflicts;
}
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

  const normalizedVariants = normalizeVariantsInput(variants, { required: true });
  if (!normalizedVariants.ok) {
    throw new Error(normalizedVariants.message);
  }
  const variantsData = normalizedVariants.variants.map(normalizeMovementVariantPayload);
  await validateProductVariantIds(product.id, variantsData);

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
  if (movement_type === 'transfer') {
    for (const variantData of variantsData) {
      const requestedLotId = variantData.warehouse_product_variant_id ?? variantData.lot_id;
      const originOption = requestedLotId != null
        ? originWpVariants.find((candidate) => Number(candidate.id) === Number(requestedLotId) && Number(candidate.variant_id) === Number(variantData.variant_id))
        : originWpVariants.find((candidate) => Number(candidate.variant_id) === Number(variantData.variant_id));
      if (!originOption) {
        const error = createWarehouseVariantFlowError(
          `La variante ${variantData.variant_id} no pertenece al almacén de origen`,
          'WAREHOUSE_PRODUCT_VARIANT_NOT_FOUND',
          400
        );
        error.apiResponse = {
          success: false,
          code: error.code,
          message: error.message,
          option: {
            product_id: product.id,
            product_variant_id: Number(variantData.variant_id),
            variant_id: Number(variantData.variant_id),
            warehouse_id: originWarehouse.id,
            warehouse_product_variant_id: requestedLotId ?? null
          }
        };
        throw error;
      }
    }

    const conflicts = [];
    for (const variantData of variantsData) {
      const requestedLotId = variantData.warehouse_product_variant_id ?? variantData.lot_id;
      const sourceLot = originWpVariants.find((candidate) =>
        Number(candidate.variant_id) === Number(variantData.variant_id) &&
        (requestedLotId == null || Number(candidate.id) === Number(requestedLotId))
      );
      if (!sourceLot) continue;
      const conflict = await getTransferDestinationPriceConflict({
        productId: product.id,
        variantId: variantData.variant_id,
        destinationWarehouseId: destWarehouse.id,
        destinationWarehouseProductId: destWp.id,
        sourceLot,
        price: variantData.price,
        purchasePrice: variantData.purchase_price,
        promotionalPrice: variantData.promotional_price,
        confirm: variantData.confirm_price_change
      });
      if (conflict) conflicts.push(conflict);
    }
    if (conflicts.length) {
      const error = createWarehouseVariantFlowError(
        'La opción ya existe con otro precio',
        'PRODUCT_OPTION_PRICE_CONFLICT',
        409
      );
      error.apiResponse = {
        ...conflicts[0],
        conflicts,
        options: conflicts.map((item) => item.option)
      };
      throw error;
    }
  }

  if (movement_type === 'entry') {
    const conflicts = [];
    for (const variantData of variantsData) {
      const variantId = variantData.variant_id;
      const option = variantData.warehouse_product_variant_id != null
        ? originWpVariants.find((candidate) => Number(candidate.id) === Number(variantData.warehouse_product_variant_id) && Number(candidate.variant_id) === Number(variantId))
        : originWpVariants
          .filter((candidate) => Number(candidate.variant_id) === Number(variantId))
          .sort((left, right) => Number(right.id) - Number(left.id))[0];
      if (!option) continue;
      const requestedPrice = variantData.price === undefined ? option.price : variantData.price;
      const requestedPurchasePrice = variantData.purchase_price === undefined ? option.purchase_price : variantData.purchase_price;
      const requestedPromotionalPrice = variantData.promotional_price === undefined ? option.promotional_price : variantData.promotional_price;
      const changedFields = [
        ...(!sameNullableMoney(option.price, requestedPrice) ? ['price'] : []),
        ...(!sameNullableMoney(option.purchase_price, requestedPurchasePrice) ? ['purchase_price'] : []),
        ...(!sameNullableMoney(option.promotional_price, requestedPromotionalPrice) ? ['promotional_price'] : [])
      ];
      if (changedFields.length && !(variantData.warehouse_product_variant_id != null && variantData.confirm_price_change === true)) {
        conflicts.push(buildPriceConflictPayload({
          productId: product.id, variantId, warehouseId: originWarehouse.id, option,
          price: requestedPrice, purchasePrice: requestedPurchasePrice,
          promotionalPrice: requestedPromotionalPrice, changedFields
        }));
      }
    }
    if (conflicts.length) {
      const error = createWarehouseVariantFlowError(
        'La opción ya existe con otro precio',
        'PRODUCT_OPTION_PRICE_CONFLICT',
        409
      );
      error.apiResponse = {
        ...conflicts[0],
        ...(conflicts.length > 1 ? { conflicts, options: conflicts.map((item) => item.option) } : {})
      };
      throw error;
    }
  }

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
      transaction,
      warehouse_product_variant_id: variantData.warehouse_product_variant_id,
      confirm_price_change: variantData.confirm_price_change
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
        productRecord: product,
      reason,
      notes,
        currentUserId,
        referenceId,
        transaction,
        warehouse_product_variant_id: variantData.warehouse_product_variant_id ?? variantData.lot_id,
        confirm_price_change: variantData.confirm_price_change,
        requested_price: variantData.price,
        requested_purchase_price: variantData.purchase_price,
        requested_promotional_price: variantData.promotional_price,
        requested_sku: variantData.sku || variantData.local_sku
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
  transaction,
  warehouse_product_variant_id = null,
  confirm_price_change = false,
  requested_price,
  requested_purchase_price,
  requested_promotional_price
}) {
  const actualVariantId = Number(variant_id);
  if (!Number.isInteger(actualVariantId) || actualVariantId <= 0) {
    throw createWarehouseVariantFlowError(
      'Debe indicarse una variante global existente para registrar el movimiento',
      'VARIANT_DOES_NOT_BELONG_TO_PRODUCT',
      400
    );
  }

  // Si el frontend envía purchase_price, usarlo. Si no, usar price como fallback
  let actualPurchasePrice = normalizeNullableMoneyValue(purchase_price);
  let salePrice = normalizeNullableMoneyValue(price);
  const effectiveLocalSku = local_sku || product.sku;
  let effectivePromotionalPrice = normalizeNullableMoneyValue(promotional_price);

  const hasSalePrice = price !== undefined;
  const hasPurchasePrice = purchase_price !== undefined;
  const hasPromotionalPrice = promotional_price !== undefined;

  const lots = await WarehouseProductVariant.findAll({
    where: { warehouse_product_id: originWp.id, variant_id: actualVariantId },
    order: [['createdAt', 'ASC']],
    transaction
  });
  let authorizedLot = null;
  if (warehouse_product_variant_id !== null && warehouse_product_variant_id !== undefined) {
    authorizedLot = lots.find((lot) => Number(lot.id) === Number(warehouse_product_variant_id));
    if (!authorizedLot) {
      const error = createWarehouseVariantFlowError(
        'La asociación de variante indicada no pertenece al almacén de origen',
        'WAREHOUSE_PRODUCT_VARIANT_NOT_FOUND',
        400
      );
      error.apiResponse = { success: false, code: error.code, message: error.message };
      throw error;
    }
  }
  {
    const currentOption = authorizedLot || lots[0] || null;
    if (currentOption) {
      if (!hasSalePrice) salePrice = normalizeNullableMoneyValue(currentOption.price);
      if (!hasPurchasePrice) actualPurchasePrice = normalizeNullableMoneyValue(currentOption.purchase_price);
      if (!hasPromotionalPrice) effectivePromotionalPrice = normalizeNullableMoneyValue(currentOption.promotional_price);
      const changedFields = [];
      if (hasSalePrice && !sameNullableMoney(currentOption.price, salePrice)) changedFields.push('price');
      if (hasPurchasePrice && !sameNullableMoney(currentOption.purchase_price, actualPurchasePrice)) {
        changedFields.push('purchase_price');
      }
      if (hasPromotionalPrice && !sameNullableMoney(currentOption.promotional_price, effectivePromotionalPrice)) {
        changedFields.push('promotional_price');
      }
      if (changedFields.length > 0 && !(authorizedLot && confirm_price_change === true)) {
        const error = createWarehouseVariantFlowError(
          'La opción ya existe con otro precio',
          'PRODUCT_OPTION_PRICE_CONFLICT',
          409
        );
        error.apiResponse = {
          success: false,
          code: error.code,
          message: error.message,
          option: {
            product_id: product.id,
            product_variant_id: actualVariantId,
            variant_id: actualVariantId,
            warehouse_id: originWarehouse.id,
            warehouse_product_variant_id: currentOption.id,
            current_price: normalizeNullableMoneyValue(currentOption.price),
            current_purchase_price: normalizeNullableMoneyValue(currentOption.purchase_price),
            current_promotional_price: normalizeNullableMoneyValue(currentOption.promotional_price)
          },
          requested: {
            price: normalizeNullableMoneyValue(salePrice),
            purchase_price: normalizeNullableMoneyValue(actualPurchasePrice),
            promotional_price: normalizeNullableMoneyValue(effectivePromotionalPrice)
          },
          changed_fields: changedFields
        };
        throw error;
      }
    }
  }

  // Crear nuevo lote con su precio de compra específico
  const totalStockBeforeEntry = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
    actualVariantId,
    originWp.id
  );
  const stockBefore = totalStockBeforeEntry?.total_stock || 0;
  const stockAfter = stockBefore + quantity;

  const matchingLot = authorizedLot || await WarehouseProductVariantRepository.findMatchingLotByVariantAndWarehouse({
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
      price: salePrice,
      purchase_price: actualPurchasePrice,
      promotional_price: effectivePromotionalPrice,
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
      is_new_association: lots.length === 0,
      lot_id: affectedLot.id,
      purchase_price: actualPurchasePrice,
      sale_price: salePrice,
      price_changes: [
        { field: 'price', old_value: lotCreated ? null : normalizeNullableMoneyValue(matchingLot.price), new_value: salePrice },
        { field: 'purchase_price', old_value: lotCreated ? null : normalizeNullableMoneyValue(matchingLot.purchase_price), new_value: actualPurchasePrice },
        { field: 'promotional_price', old_value: lotCreated ? null : normalizeNullableMoneyValue(matchingLot.promotional_price), new_value: effectivePromotionalPrice }
      ].filter((change) => !sameNullableMoney(change.old_value, change.new_value))
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
  productRecord,
  reason,
  notes,
  currentUserId,
  referenceId,
  transaction,
  warehouse_product_variant_id = null,
  confirm_price_change = false,
  requested_price,
  requested_purchase_price,
  requested_promotional_price,
  requested_sku
}) {
  // 1. Obtener lotes del origen con FIFO
  let originLots = await WarehouseProductVariantRepository.findAllLotsByVariantAndWarehouse(
    variant_id,
    originWp.id
  );

  if (warehouse_product_variant_id != null) {
    const selectedLot = originLots.find((lot) => Number(lot.id) === Number(warehouse_product_variant_id));
    if (!selectedLot) throw createWarehouseVariantFlowError(
      'El lote indicado no pertenece a la variante del almacén de origen',
      'WAREHOUSE_PRODUCT_VARIANT_NOT_FOUND',
      400
    );
    originLots = [selectedLot];
  }

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

  // Las transferencias solo mueven variantes globales existentes. Si la
  // variante todavía no está asociada al destino, la asociación se crea más
  // abajo usando este mismo variant_id; nunca se crea una ProductVariant.
  const destinationVariantId = variant_id;

  const transferPriceConflict = await getTransferDestinationPriceConflict({
    productId: product_id,
    variantId: variant_id,
    destinationWarehouseId: destWarehouse.id,
    destinationWarehouseProductId: destWp.id,
    sourceLot: originLots[0],
    price: requested_price,
    purchasePrice: requested_purchase_price === undefined
      ? weightedAvgPurchasePrice
      : requested_purchase_price,
    promotionalPrice: requested_promotional_price,
    confirm: confirm_price_change
  });
  if (transferPriceConflict) {
    const error = createWarehouseVariantFlowError(
      'La opción ya existe con otro precio',
      'PRODUCT_OPTION_PRICE_CONFLICT',
      409
    );
    error.apiResponse = {
      ...transferPriceConflict,
      conflicts: [transferPriceConflict],
      options: [transferPriceConflict.option]
    };
    throw error;
  }

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
    destinationVariantId,
    destWp.id
  );

  let destLotConsolidated = null;
  if (destLots && destLots.length > 0) {
    destLotConsolidated = confirm_price_change === true
      ? destLots[0]
      : destLots.find(lot =>
        Math.abs(parseFloat(lot.purchase_price) - weightedAvgPurchasePrice) < 0.01
        );
  }
  const destinationAssociationCreated = !destLots || destLots.length === 0;

  const destinationPrices = {
    price: requested_price === undefined ? originLots[0]?.price : requested_price,
    purchase_price: requested_purchase_price === undefined
      ? weightedAvgPurchasePrice
      : requested_purchase_price,
    promotional_price: requested_promotional_price === undefined
      ? originLots[0]?.promotional_price
      : requested_promotional_price
  };
  const destinationPriceChanges = buildPriceChanges(destLotConsolidated, destinationPrices);

  const totalStockBeforeDestInfo = await WarehouseProductVariantRepository.getTotalStockByVariantAndWarehouse(
    destinationVariantId,
    destWp.id
  );
  const totalStockBeforeDest = totalStockBeforeDestInfo?.total_stock || 0;

  if (destLotConsolidated) {
    const newStock = destLotConsolidated.stock + quantity;
    
    await WarehouseProductVariantRepository.update(destLotConsolidated, {
      stock: newStock,
      ...(confirm_price_change === true ? {
        price: normalizeNullableMoneyValue(destinationPrices.price),
        purchase_price: normalizeNullableMoneyValue(destinationPrices.purchase_price),
        promotional_price: normalizeNullableMoneyValue(destinationPrices.promotional_price)
      } : {})
    }, { transaction });
  } else {
    await WarehouseProductVariantRepository.create({
      warehouse_product_id: destWp.id,
      variant_id,
      active: true,
      published: false,
      local_sku: originLots[0]?.local_sku || null,
      price: normalizeNullableMoneyValue(destinationPrices.price),
      promotional_price: normalizeNullableMoneyValue(destinationPrices.promotional_price),
      purchase_price: normalizeNullableMoneyValue(destinationPrices.purchase_price),
      stock: quantity
    }, { transaction });
  }

  // 5. Registrar movimientos
  const baseMovement = {
    product_id,
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
    variant_id,
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
    variant_id: destinationVariantId,
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
      purchase_price_preserved: weightedAvgPurchasePrice,
      is_new_association: destinationAssociationCreated,
      price_changes: destinationPriceChanges
    }
  }, { transaction });
}

module.exports = WarehouseProductController;
