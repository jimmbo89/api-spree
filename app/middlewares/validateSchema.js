// app/middlewares/validateSchema.js
const logger = require("../../config/logger");

/**
 * Middleware de validación flexible
 * Uso:
 *   validateSchema({ body: schemaBody, params: schemaParams })
 */
const validateSchema = (schemas) => {
  // Normalización recursiva
  const normalizeValue = (value) => {
    if (value === "" || value === null) return null;
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
          obj[key] = obj[key].map(item => typeof item === 'object' && item !== null ? normalizeObject({ ...item }) : normalizeValue(item));
        } else {
          obj[key] = normalizeValue(obj[key]);
        }
      }
    }
    return obj;
  };

  return (req, res, next) => {
    const sources = ['body', 'params', 'query'];
    const errors = [];

    for (const source of sources) {
      if (schemas[source] && req[source]) {
        const data = source === 'body' ? normalizeObject({ ...req[source] }) : { ...req[source] };
        const { error } = schemas[source].validate(data, { abortEarly: false });
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

      return res.status(400).json({
        msg: "Error de validación",
        details: errors.map(e => `${e.source}.${e.path}: ${e.message}`)
      });
    }

    next();
  };
};

module.exports = validateSchema;