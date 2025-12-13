// validations/warehouseProductValidationSchemas.js
const Joi = require('joi');

// Esquema para variantes en el cuerpo de la petición
const variantItemSchema = Joi.object({
  attributes: Joi.object().optional().default({}),
  published: Joi.boolean().optional().default(false),
  local_sku: Joi.string().max(100).optional().allow(null, ''),
  price: Joi.number().precision(2).min(0).required(),
  stock: Joi.number().integer().min(0).required()
}).unknown(false);

const storeWarehouseProductSchema = Joi.object({
  // ===== DATOS DE WAREHOUSE_PRODUCT =====
  warehouse_id: Joi.number().integer().positive().required(),
  company_id: Joi.number().integer().positive().optional(),
  branch_id: Joi.number().integer().positive().optional().allow(null),
  user_id: Joi.number().integer().positive().optional().allow(null),

  // ===== PRODUCTO EXISTENTE =====
  product_id: Joi.number().integer().positive().optional(),

  // ===== NUEVO PRODUCTO (como JSON string) =====
  product: Joi.string()
    .custom((value, helpers) => {
      try {
        if (value) {
          const parsed = JSON.parse(value);
          if (typeof parsed !== 'object' || parsed === null) {
            return helpers.message('product debe ser un objeto JSON válido');
          }
        }
        return value;
      } catch {
        return helpers.message('product debe ser un JSON válido');
      }
    })
    .optional(),

  // ===== ATRIBUTOS DEL PRODUCTO =====
  attributes: Joi.string()
    .custom((value, helpers) => {
      try {
        if (value) {
          const parsed = JSON.parse(value);
          if (!Array.isArray(parsed)) {
            return helpers.message('attributes debe ser un array JSON válido');
          }
        }
        return value;
      } catch {
        return helpers.message('attributes debe ser un JSON válido');
      }
    })
    .optional(),

  // ===== VARIANTES (stock/precio por variante) =====
  variants: Joi.array().items(variantItemSchema).optional().default([]),

  // ===== SI NO HAY VARIANTES, USAR ESTOS CAMPOS =====
  price: Joi.when('variants', {
    is: Joi.array().length(0),
    then: Joi.number().precision(2).min(0).required(),
    otherwise: Joi.forbidden()
  }),
  stock: Joi.when('variants', {
    is: Joi.array().length(0),
    then: Joi.number().integer().min(0).required(),
    otherwise: Joi.forbidden()
  }),

  // ===== IMAGEN DEL PRODUCTO (si se crea nuevo) =====
  images: Joi.any().optional()
})
  // Validación cruzada: o producto existente o nuevo
  .custom((value, helpers) => {
    const { product_id, product } = value;
    if (!product_id && !product) {
      return helpers.message('Debe proporcionar product_id o datos de producto (product)');
    }
    if (product_id && product) {
      return helpers.message('No se puede enviar product_id y product al mismo tiempo');
    }
    return value;
  });

const updateWarehouseProductSchema = Joi.object({
  id: Joi.number().required(),
  active: Joi.boolean().optional(),
  code: Joi.string().max(100).optional().allow(null, ''),
  company_id: Joi.number().integer().positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null),
  user_id: Joi.number().integer().positive().optional().allow(null)
});

const idWarehouseProductSchema = Joi.object({
  id: Joi.number().required()
});

const listWarehouseProductSchema = Joi.object({
  company_id: Joi.number().allow(null).empty('').optional(),
  user_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional(),
  warehouse_id: Joi.number().allow(null).empty('').optional()
});

const transferSchema = Joi.object({
  product_id: Joi.number().integer().positive().required(),
  from_warehouse_id: Joi.number().integer().positive().required(),
  to_warehouse_id: Joi.number().integer().positive().required(),
  quantity: Joi.number().integer().min(1).required()
});

const bulkUploadSchema = Joi.object({
  warehouse_id: Joi.number().integer().positive().required(),
  file: Joi.any()
    .meta({ swaggerType: 'file' })
    .custom((value, helpers) => {
      if (!value) return helpers.message('Archivo es obligatorio');
      const validMimeTypes = [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ];
      if (!validMimeTypes.includes(value.mimetype)) {
        return helpers.message('Formato no soportado. Use CSV o XLSX.');
      }
      if (value.size > 5 * 1024 * 1024) {
        return helpers.message('El archivo debe pesar máximo 5 MB');
      }
      return value;
    })
    .required()
});

module.exports = {
  storeWarehouseProductSchema,
  updateWarehouseProductSchema,
  idWarehouseProductSchema,
  listWarehouseProductSchema,
  transferSchema,
  bulkUploadSchema
};