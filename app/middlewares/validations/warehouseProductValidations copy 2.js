const Joi = require('joi');

const storeWarehouseProductSchema = Joi.object({
  // ===== DATOS DE WAREHOUSE_PRODUCT (OBLIGATORIOS) =====
  warehouse_id: Joi.number().integer().positive().required(),
  stock: Joi.number().integer().min(0).required().default(0),
  price: Joi.number().precision(2).positive().optional().allow(null),
  published: Joi.boolean().optional().default(false),
  company_id: Joi.number().integer().positive().optional(),
  branch_id: Joi.number().integer().positive().optional().allow(null),
  user_id: Joi.number().integer().positive().optional().allow(null),
  
  // Para edición
  id: Joi.number().integer().positive().optional(),
  
  // Si es producto existente
  product_id: Joi.number().integer().positive().optional(),
  
  // ===== PRODUCTO (JSON string - opcional) =====
  product: Joi.string()
    .custom((value, helpers) => {
      try {
        if (value) {
          const parsed = JSON.parse(value);
          // Solo validar que sea un objeto, sin restricciones internas
          if (typeof parsed !== 'object' || parsed === null) {
            return helpers.message('product debe ser un objeto JSON válido');
          }
        }
        return value;
      } catch (error) {
        return helpers.message('product debe ser un JSON válido');
      }
    })
    .optional(),
    
  // ===== VARIANTES (JSON string - opcional) =====
  variants: Joi.string()
    .custom((value, helpers) => {
      try {
        if (value) {
          const parsed = JSON.parse(value);
          // Solo validar que sea un array, sin restricciones en los items
          if (!Array.isArray(parsed)) {
            return helpers.message('variants debe ser un array JSON válido');
          }
        }
        return value;
      } catch (error) {
        return helpers.message('variants debe ser un JSON válido');
      }
    })
    .optional(),
    
  // ===== ATRIBUTOS (JSON string - opcional) =====
  attributes: Joi.string()
    .custom((value, helpers) => {
      try {
        if (value) {
          const parsed = JSON.parse(value);
          // Solo validar que sea un array, sin restricciones en los items
          if (!Array.isArray(parsed)) {
            return helpers.message('attributes debe ser un array JSON válido');
          }
        }
        return value;
      } catch (error) {
        return helpers.message('attributes debe ser un JSON válido');
      }
    })
    .optional(),
    
  // ===== IMAGEN DE WAREHOUSE_PRODUCT =====
  image: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        const validMimeTypes = ['image/jpg', 'image/jpeg', 'image/png', 'image/gif'];
        if (!validMimeTypes.includes(value.mimetype || value.type)) {
          return helpers.message('El archivo debe ser una imagen válida (jpg, jpeg, png, gif)');
        }
        const maxSize = 500 * 1024;
        if (value.size > maxSize) {
          return helpers.message('El archivo debe pesar máximo 500 KB');
        }
      }
      return value;
    })
    .optional(),
    
  // ===== IMÁGENES DEL PRODUCTO (solo si se crea producto nuevo) =====
  images: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        // Si es un solo archivo
        if (value.mimetype) {
          const validMimeTypes = ['image/jpg', 'image/jpeg', 'image/png', 'image/gif'];
          if (!validMimeTypes.includes(value.mimetype)) {
            return helpers.message('Las imágenes deben ser válidas (jpg, jpeg, png, gif)');
          }
          const maxSize = 500 * 1024;
          if (value.size > maxSize) {
            return helpers.message('Cada imagen debe pesar máximo 500 KB');
          }
        }
        // Si es array de archivos (multer los agrupa)
        if (Array.isArray(value)) {
          value.forEach(file => {
            const validMimeTypes = ['image/jpg', 'image/jpeg', 'image/png', 'image/gif'];
            if (!validMimeTypes.includes(file.mimetype)) {
              return helpers.message('Todas las imágenes deben ser válidas (jpg, jpeg, png, gif)');
            }
            const maxSize = 500 * 1024;
            if (file.size > maxSize) {
              return helpers.message('Cada imagen debe pesar máximo 500 KB');
            }
          });
        }
      }
      return value;
    })
    .optional()
})
// Validación cruzada: si no hay product_id, debe haber product
.custom((value, helpers) => {
  const { product_id, product } = value;
  
  if (!product_id && !product) {
    return helpers.message('Si no se proporciona product_id, se debe enviar product');
  }
  
  return value;
});

const updateWarehouseProductSchema = Joi.object({
  id: Joi.number().required(),
  product_id: Joi.number().integer().positive().optional(),
  warehouse_id: Joi.number().integer().positive().optional(),
  stock: Joi.number().integer().min(0).optional(),
  price: Joi.number().precision(2).positive().optional().allow(null),
  published: Joi.boolean().optional(),
  company_id: Joi.number().integer().positive().optional().allow(null),
  branch_id: Joi.number().integer().positive().optional().allow(null),
  user_id: Joi.number().integer().positive().optional().allow(null),
  images: Joi.array()
      .items(Joi.string().pattern(/\.(jpg|jpeg|png|gif|webp)$/i))
      .optional().default([]),
  image: Joi.any()
    .custom((value, helpers) => {
      if (value) {
        const validMimeTypes = ['image/jpg', 'image/jpeg', 'image/png', 'image/gif', 'image/webp'];
        if (!validMimeTypes.includes(value.mimetype || value.type)) {
          return helpers.message('El archivo debe ser una imagen válida');
        }
        const maxSize = 500 * 1024;
        if (value.size > maxSize) {
          return helpers.message('El archivo debe pesar máximo 500 KB');
        }
      }
      return value;
    })
    .optional(),
     variants: Joi.string()
    .custom((value, helpers) => {
      try {
        if (value) {
          const parsed = JSON.parse(value);
          // Solo validar que sea un array, sin restricciones en los items
          if (!Array.isArray(parsed)) {
            return helpers.message('variants debe ser un array JSON válido');
          }
        }
        return value;
      } catch (error) {
        return helpers.message('variants debe ser un JSON válido');
      }
    })
    .optional(),
});

const idWarehouseProductSchema = Joi.object({
  id: Joi.number().required()
});

const listWarehouseProductSchema = Joi.object({
  company_id: Joi.number().allow(null).empty('').optional(),
  user_id: Joi.number().allow(null).empty('').optional(),
  branch_id: Joi.number().allow(null).empty('').optional(),
  warehouse_id: Joi.number().allow(null).empty('').optional(),
  published: Joi.boolean().optional()
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
      if (!value) {
        return helpers.message('Archivo es obligatorio');
      }
      const validMimeTypes = [
        'text/csv',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      ];
      if (!validMimeTypes.includes(value.mimetype)) {
        return helpers.message('Formato no soportado. Use CSV o XLSX.');
      }
      const maxSize = 5 * 1024 * 1024; // 5 MB
      if (value.size > maxSize) {
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