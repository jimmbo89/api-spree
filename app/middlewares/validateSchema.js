// app/middlewares/validateSchema.js
const logger = require("../../config/logger");

/**
 * Middleware de validación flexible
 * Uso:
 *   validateSchema({ body: schemaBody, params: schemaParams })
 */
const validateSchema = (schemas) => {
  const normalizedSchemas = (
    schemas && typeof schemas.validate === 'function' &&
    !Object.prototype.hasOwnProperty.call(schemas, 'body') &&
    !Object.prototype.hasOwnProperty.call(schemas, 'params') &&
    !Object.prototype.hasOwnProperty.call(schemas, 'query')
  )
    ? { body: schemas }
    : (schemas || {});

  // Normalización recursiva
  const normalizeValue = (value, key = '') => {
    if (value === "" || value === null) return null;
    if (key === 'password') return value;
    if (key === 'phone') return value;
    if (typeof value === "string") {
      const num = Number(value);
      if (!isNaN(num) && value.trim() === value) return num;
    }
    return value;
  };

  const normalizeObject = (obj) => {
    for (const key in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) {
        if (typeof obj[key] === "object" && obj[key] !== null && !Array.isArray(obj[key])) {
          normalizeObject(obj[key]);
        } else if (Array.isArray(obj[key])) {
          obj[key] = obj[key].map(item => typeof item === 'object' && item !== null ? normalizeObject({ ...item }) : normalizeValue(item, key));
        } else {
          obj[key] = normalizeValue(obj[key], key);
        }
      }
    }
    return obj;
  };

  return (req, res, next) => {
    const sources = ['body', 'params', 'query'];
    const errors = [];

    for (const source of sources) {
      if (normalizedSchemas[source] && req[source]) {
        const data = source === 'body' ? normalizeObject({ ...req[source] }) : { ...req[source] };
        const { error } = normalizedSchemas[source].validate(data, { abortEarly: false });
        if (error) {
          errors.push(...error.details.map(err => ({
            source,
            message: err.message,
            path: err.path.join('.')
          })));
        }
      }
    }

    if (errors.length > 0) {
      logger.error(
        `Validation error in ${req.method} ${req.originalUrl} - Errors: ${JSON.stringify(errors)}`
      );

      // Crear mensajes de error más descriptivos y amigables
      const friendlyMessages = errors.map(e => {
        let message = e.message;
        
        // Mensajes personalizados para campos comunes
        if (e.path.includes('mode')) {
          message = 'El campo "mode" es obligatorio y debe ser uno de los siguientes valores: quick, advanced, manual, draft, publish';
        } else if (e.path.includes('pool')) {
          message = 'El campo "pool" es obligatorio y debe incluir id, company_id, warehouses y primary_warehouse';
        } else if (e.path.includes('products')) {
          message = 'El campo "products" es obligatorio y debe ser un array con al menos un producto';
        } else if (e.path.includes('marketplaces')) {
          message = 'El campo "marketplaces" es obligatorio y debe ser un array con al menos un marketplace';
        }
        
        return `${e.source}.${e.path}: ${message}`;
      });

      return res.status(400).json({
        success: false,
        msg: "Error de validación",
        details: friendlyMessages,
        error_details: errors.map(e => ({
          field: e.path,
          message: e.message,
          source: e.source
        }))
      });
    }

    next();
  };
};

module.exports = validateSchema;
