// src/services/MarketplaceTransformer.js
const { MarketplaceRepository } = require('../repositories');
const logger = require('../../config/logger');

class MarketplaceTransformer {
  /**
   * Transforma productos al formato del marketplace, aplicando mapeos y reglas de validación.
   * @param {Array} products - Productos con campos como `stock`, `price`, `name`, etc.
   * @param {number} marketplaceId - ID del marketplace
   * @returns {Promise<Array>} - Array de productos transformados
   */
  static async transformProducts(products, marketplaceId) {
    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplaceId);
    const exportMappings = mappings.filter(m => 
      m.direction === 'export' || m.direction === 'both'
    );

    return products.map(product => {
      const transformed = {};

      for (const mapping of exportMappings) {
        const {
          internal_field,
          external_field,
          default_value,
          validation_rules
        } = mapping;

        // 1. Obtener valor del producto
        let value = product[internal_field];

        // 2. Si no existe o es null/undefined/vacío, usar default_value
        if (value === null || value === undefined || (typeof value === 'string' && value === '')) {
          value = default_value !== undefined && default_value !== null ? default_value : null;
        }

        // 3. Aplicar validación si hay reglas
        if (value !== null && validation_rules) {
          value = this.applyValidationRules(value, validation_rules, internal_field);
        }

        // 4. Asignar al campo externo (con soporte para anidados y pictures)
        this.setNestedField(transformed, external_field, value);
      }

      return transformed;
    });
  }

  /**
   * Establece un campo en un objeto, soportando rutas anidadas y transformaciones especiales.
   * @param {Object} obj - Objeto destino
   * @param {string} path - Ruta del campo (ej: 'description.plain_text' o 'pictures')
   * @param {*} value - Valor a asignar
   */
  static setNestedField(obj, path, value) {
    // Caso especial: imágenes
    if (path === 'pictures' && Array.isArray(value)) {
      obj.pictures = value.map(url => ({ source: url }));
      return;
    }

    // Caso especial: descripción anidada
    if (path === 'description.plain_text') {
      if (!obj.description) obj.description = {};
      obj.description.plain_text = value;
      return;
    }

    // Soporte genérico para rutas anidadas (a.b.c)
    if (path.includes('.')) {
      const keys = path.split('.');
      let current = obj;
      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) current[keys[i]] = {};
        current = current[keys[i]];
      }
      current[keys[keys.length - 1]] = value;
    } else {
      obj[path] = value;
    }
  }

  /**
   * Aplica reglas de validación a un valor.
   * @param {*} value - Valor a validar
   * @param {Object} rules - Reglas: { min, max, minLength, maxLength, regex, enum }
   * @param {string} field - Nombre del campo (para logs)
   * @returns {*} - Valor transformado o null si falla
   */
  static applyValidationRules(value, rules, field) {
    try {
      // Validación numérica
      if (rules.min !== undefined || rules.max !== undefined) {
        const numValue = typeof value === 'string' ? parseFloat(value) : Number(value);
        if (isNaN(numValue)) {
          logger.warn(`[Transformer] Valor no numérico en campo ${field}: ${value}`);
          return null;
        }
        if (rules.min !== undefined && numValue < rules.min) return null;
        if (rules.max !== undefined && numValue > rules.max) return null;
        return numValue;
      }

      // Validación de texto
      if (typeof value === 'string') {
        if (rules.minLength !== undefined && value.length < rules.minLength) {
          return null;
        }
        if (rules.maxLength !== undefined && value.length > rules.maxLength) {
          return value.substring(0, rules.maxLength);
        }
        if (rules.regex !== undefined) {
          const regex = new RegExp(rules.regex);
          if (!regex.test(value)) {
            return null;
          }
        }
        if (rules.enum && !rules.enum.includes(value)) {
          return null;
        }
      }

      return value;
    } catch (error) {
      logger.error(`[Transformer] Error aplicando reglas a ${field}:`, error.message);
      return null;
    }
  }

  /**
   * Transforma un payload de marketplace a formato interno.
   * @param {Object} externalPayload - Payload del marketplace
   * @param {number} marketplaceId - ID del marketplace
   * @returns {Promise<Object>} - Objeto con campos internos
   */
  static async reverseTransform(externalPayload, marketplaceId) {
    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplaceId);
    const importMappings = mappings.filter(m => 
      m.direction === 'import' || m.direction === 'both'
    );

    const internalData = {};

    for (const mapping of importMappings) {
      const { internal_field, external_field } = mapping;

      // Extraer valor del payload externo (soporta anidados)
      let value = externalPayload;
      if (external_field.includes('.')) {
        const keys = external_field.split('.');
        for (const key of keys) {
          if (value && typeof value === 'object') {
            value = value[key];
          } else {
            value = undefined;
            break;
          }
        }
      } else {
        value = externalPayload[external_field];
      }

      if (value !== undefined) {
        internalData[internal_field] = value;
      }
    }

    return internalData;
  }
}

module.exports = MarketplaceTransformer;