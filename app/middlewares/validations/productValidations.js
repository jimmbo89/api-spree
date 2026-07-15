// validations/productValidationSchemas.js
const Joi = require('joi');

const normalizeTextInput = (value) => {
  if (value === undefined || value === null) {
    return value;
  }

  if (Array.isArray(value)) {
    if (!value.length) {
      return '';
    }

    return normalizeTextInput(value[0]);
  }

  if (typeof value === 'object') {
    const candidates = [
      value.value,
      value.label,
      value.text,
      value.sku,
      value.name,
      value.code,
      value.id
    ];

    for (const candidate of candidates) {
      if (candidate !== undefined && candidate !== null && candidate !== '') {
        return normalizeTextInput(candidate);
      }
    }

    return String(value);
  }

  return String(value).trim();
};

const textField = ({ max, required = false, allowNull = false, defaultValue } = {}) =>
  Joi.any().custom((value, helpers) => {
    if (value === undefined) {
      return defaultValue !== undefined ? defaultValue : value;
    }

    if (value === null) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }

      if (allowNull) {
        return null;
      }

      return required ? helpers.error('any.required') : '';
    }

    const normalized = normalizeTextInput(value);

    if (normalized === undefined || normalized === null) {
      return defaultValue !== undefined ? defaultValue : normalized;
    }

    const text = String(normalized).trim();

    if (!text) {
      if (defaultValue !== undefined) {
        return defaultValue;
      }

      return required ? helpers.error('any.required') : '';
    }

    if (max && text.length > max) {
      return helpers.error('string.max', { limit: max });
    }

    return text;
  });

const enumTextField = (validValues, options = {}) =>
  textField(options).custom((value, helpers) => {
    if (value === undefined || value === null || value === '') {
      return value;
    }

    if (!validValues.includes(value)) {
      return helpers.error('any.only', { valids: validValues });
    }

    return value;
  });

const jsonString = (validator, label) =>
  Joi.alternatives().try(
    validator,
    Joi.string().custom((value, helpers) => {
      try {
        const parsed = JSON.parse(value);
        const { error } = validator.validate(parsed);
        if (error) {
          return helpers.error('any.invalid');
        }
        return value;
      } catch (error) {
        return helpers.error('any.invalid');
      }
    }, `${label} JSON validator`)
  );

const measurementValueSchema = Joi.object({
  value: Joi.number().min(0).allow(null),
  unit: Joi.string().allow(null, '')
});

const productMeasurementsSchema = Joi.object({
  weight: measurementValueSchema.optional(),
  dimensions: Joi.object({
    length: measurementValueSchema.optional(),
    width: measurementValueSchema.optional(),
    height: measurementValueSchema.optional(),
    depth: measurementValueSchema.optional()
  }).optional(),
  volumetric_weight: measurementValueSchema.optional()
});

const packagingMeasurementsSchema = Joi.object({
  weight: measurementValueSchema.optional(),
  dimensions: Joi.object({
    length: measurementValueSchema.optional(),
    width: measurementValueSchema.optional(),
    height: measurementValueSchema.optional(),
    depth: measurementValueSchema.optional()
  }).optional(),
  material: Joi.string().allow(null, ''),
  fragile: Joi.boolean().optional(),
  units_per_box: Joi.number().integer().min(0).allow(null)
});

const productAttributeSchema = Joi.object({
  id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  attribute_id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  name: Joi.string().optional(),
  value: Joi.alternatives().try(Joi.string(), Joi.number(), Joi.boolean(), Joi.allow(null)).required(),
  unit: Joi.string().optional().allow(null, '')
});

const productVariantSchema = Joi.object({
  id: Joi.alternatives().try(Joi.string(), Joi.number()).optional(),
  sku: textField({ max: 100, required: true }),
  attributes: Joi.object().optional().default({}),
  variant_value_ids: Joi.array()
    .items(Joi.number().integer().positive())
    .optional()
    .default([])
});

const warehouseVariantSchema = Joi.object({
  active: Joi.boolean().optional().default(true),
  local_sku: Joi.string().max(100).optional().allow(null, ''),
  price: Joi.number().precision(2).min(0).optional().allow(null),
  purchase_price: Joi.number().precision(2).min(0).optional().allow(null),
  promotional_price: Joi.number().precision(2).min(0).optional().allow(null),
  stock: Joi.alternatives().try(
    Joi.number().integer().min(0),
    Joi.string().pattern(/^\d+$/)
  ).required()
});

const warehouseConfigSchema = Joi.array().items(
  Joi.object({
    warehouse_id: Joi.number().integer().positive().required(),
    active: Joi.boolean().optional().default(true),
    code: textField({ max: 100, allowNull: true }),
    minimum_stock: Joi.number().integer().min(0).optional().default(5),
    variants: Joi.array().items(warehouseVariantSchema).required()
  })
);

const productBaseSchema = {
  sku: textField({ max: 100, required: true }),
  name: textField({ max: 255, required: true }),
  description: textField({ allowNull: true }),
  brand: textField({ max: 100, required: true }),
  model: textField({ max: 100, allowNull: true }),
  condition: enumTextField(['new', 'used', 'refurbished', 'not_specified'], { defaultValue: 'new' }),
  gtin: textField({ max: 50, allowNull: true }),
  mpn: textField({ max: 100, allowNull: true }),
  warranty_months: Joi.number().integer().min(0).optional().allow(null),
  warranty_text: textField({ max: 255, allowNull: true }),
  weight_grams: Joi.number().integer().min(0).optional().allow(null),
  length_cm: Joi.number().precision(2).min(0).optional().allow(null),
  width_cm: Joi.number().precision(2).min(0).optional().allow(null),
  height_cm: Joi.number().precision(2).min(0).optional().allow(null),
  product_measurements: jsonString(productMeasurementsSchema, 'product_measurements').optional().default({}),
  packaging_measurements: jsonString(packagingMeasurementsSchema, 'packaging_measurements').optional().default({}),
  attributes: jsonString(Joi.array().items(productAttributeSchema), 'attributes').optional().default([]),
  category_id: Joi.number().integer().positive().optional().allow(null),
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null),
  images: Joi.array()
    .items(Joi.string().pattern(/\.(jpg|jpeg|png|gif|webp)$/i))
    .optional()
    .default([]),
  images_order: jsonString(Joi.array()
    .items(Joi.alternatives().try(
      Joi.string().pattern(/\.(jpg|jpeg|png|gif|webp)$/i),
      Joi.string().valid('__NEW__')
    ))
    .max(40)
    .optional(), 'images_order'),
  images_to_remove: Joi.alternatives().try(
    Joi.array()
      .items(Joi.string().pattern(/\.(jpg|jpeg|png|gif|webp)$/i))
      .optional()
      .default([]),
    Joi.string().optional().allow(null, '')
  ),
  sync_meta: Joi.object().optional().default({}),
  state: Joi.number().integer().optional(),
  purchase_price: Joi.number().precision(2).min(0).optional().allow(null),
  sale_price: Joi.number().precision(2).min(0).optional().allow(null),
};

const storeProductSchema = Joi.object({
  ...productBaseSchema,
  product_variants: jsonString(Joi.array().items(productVariantSchema), 'product_variants').optional().default([]),
  warehouse_config: jsonString(warehouseConfigSchema, 'warehouse_config').optional().default([]),
  warehouses: Joi.array().items(
    Joi.object({
      id: Joi.number().integer().positive().required(),
      published: Joi.boolean().optional().default(false),
      minimum_stock: Joi.number().integer().min(0).optional().default(5),
      price: Joi.number().precision(2).min(0).optional().allow(null), // precio por almacén/variante (puede ser null, usa fallback del producto)
      stock: Joi.number().integer().min(0).required()    // stock por almacén/variante
    })
  ).optional().default([])
});

const assignWarehouseSchema = Joi.object({
  product_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().required(),
  warehouse_config: jsonString(warehouseConfigSchema.min(1), 'warehouse_config').required()
});

const updateProductSchema = Joi.object({
  id: Joi.number().required(),
  ...Object.fromEntries(
    Object.entries(productBaseSchema).map(([key, schema]) => [key, schema.optional()])
  ),
  product_variants: jsonString(Joi.array().items(productVariantSchema), 'product_variants').optional(),
  warehouse_config: jsonString(warehouseConfigSchema, 'warehouse_config').optional()
});

const idProductSchema = Joi.object({
  id: Joi.number().required()
});

const listProductsSchema = Joi.object({
  company_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional(),
  warehouse_id: Joi.number().allow(null).empty('').optional(),
  user_id: Joi.number().allow(null).empty('').optional(),
  brand: textField({ allowNull: true }),
  has_gtin: Joi.boolean().optional(),
  state: Joi.number().allow(null).empty('').optional(),
});

const listByWarehouseIdsSchema = Joi.object({
  company_id: Joi.number().integer().required(),
  warehouse_ids: Joi.array()
    .items(Joi.number().integer().required())
    .min(1)
    .required()
    .label('warehouse_ids')
});

const bulkImportProductSchema = Joi.object({
  company_id: Joi.number().integer().positive().required(),
  user_id: Joi.number().integer().positive().optional().allow(null)
});

module.exports = {
  storeProductSchema,
  updateProductSchema,
  idProductSchema,
  listProductsSchema,
  listByWarehouseIdsSchema,
  assignWarehouseSchema,
  bulkImportProductSchema
};
