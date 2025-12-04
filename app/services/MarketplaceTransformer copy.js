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

        // 4. Asignar al campo externo
        this.setNestedField(transformed, external_field, value);
      }

      return transformed;
    });
  }

  /**
   * Establece un campo en un objeto, soportando rutas anidadas y transformaciones especiales.
   * @param {Object} obj - Objeto destino
   * @param {string} path - Ruta del campo (ej: 'description.plain_text', 'pictures')
   * @param {*} value - Valor a asignar
   */
  static setNestedField(obj, path, value) {
  // Caso especial: imágenes - MANEJAR MÚLTIPLES FORMATOS
  if (path === 'pictures') {
    obj.pictures = this.normalizePictures(value);
    return;
  }

  // Caso especial: attributes → debe usar value_name (¡no valueName!)
 if (path === 'attributes' && Array.isArray(value)) {
  obj.attributes = value.map(attr => {
    const attribute = {
      id: attr.id,
      value_name: attr.value_name || attr.value
    };
    // Incluir value_id si está disponible (importante para catálogo)
    if (attr.value_id) {
      attribute.value_id = attr.value_id;
    }
    return attribute;
  });
  return;
}

  // Caso especial: sale_terms → debe usar value_name
  if (path === 'sale_terms' && Array.isArray(value)) {
    obj.sale_terms = value.map(term => ({
      id: term.id,
      value_name: term.value_name
    }));
    return;
  }

  // Caso especial: descripción anidada
  /*if (path === 'description.plain_text') {
    if (!obj.description) obj.description = {};
    obj.description.plain_text = value;
    return;
  }*/

  // Rutas anidadas genéricas (a.b.c)
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
 * Normaliza imágenes de diferentes formatos al formato de Mercado Libre
 * @param {*} value - Valor del campo pictures (string, array, objeto, etc.)
 * @returns {Array} - Array de objetos { source: url }
 */
static normalizePictures(value) {
  const result = [];
  
  try {
    // Caso 1: Ya está en formato correcto
    if (Array.isArray(value) && value.length > 0) {
      for (const item of value) {
        if (typeof item === 'object' && item.source) {
          result.push({ source: this.normalizeImageUrl(item.source) });
        } else if (typeof item === 'object' && item.url) {
          result.push({ source: this.normalizeImageUrl(item.url) });
        } else if (typeof item === 'string' && item.trim()) {
          result.push({ source: this.normalizeImageUrl(item) });
        }
      }
    }
    // Caso 2: Es un string simple (como "warehouse_products/default.jpg")
    else if (typeof value === 'string' && value.trim()) {
      // Intentar parsear como JSON primero
      if (value.startsWith('[') || value.startsWith('{')) {
        try {
          const parsed = JSON.parse(value);
          return this.normalizePictures(parsed); // Recursión
        } catch (e) {
          // No es JSON válido, tratar como string simple
        }
      }
      
      // Extraer todas las URLs del string
      const urlRegex = /(https?:\/\/[^\s\]}]+|[\w\-_]+\.(jpg|jpeg|png|gif|webp))/gi;
      const matches = value.match(urlRegex);
      
      if (matches) {
        matches.forEach(url => {
          result.push({ source: this.normalizeImageUrl(url) });
        });
      } else {
        // Es una ruta relativa como "warehouse_products/default.jpg"
        result.push({ source: this.normalizeImageUrl(value) });
      }
    }
    // Caso 3: Es un objeto individual
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (value.source) {
        result.push({ source: this.normalizeImageUrl(value.source) });
      } else if (value.url) {
        result.push({ source: this.normalizeImageUrl(value.url) });
      }
    }
    
  } catch (error) {
    logger.error(`[Transformer] Error normalizando imágenes:`, error.message);
  }
  
  // Si no se encontraron imágenes válidas, usar placeholder
  if (result.length === 0) {
    logger.warn(`[Transformer] No se encontraron imágenes válidas, usando placeholder`);
    result.push({ 
      source: 'https://via.placeholder.com/600x600/3498db/ffffff?text=Producto+Sin+Imagen' 
    });
  }
  
  logger.info(`[Transformer] Normalizadas ${result.length} imágenes`);
  return result;
}

/**
 * Normaliza una URL de imagen a formato completo
 * @param {string} url - URL o ruta de imagen
 * @returns {string} - URL completa
 */
  static normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') {
      return 'https://via.placeholder.com/600x600/e74c3c/ffffff?text=Error+URL';
    }
    
    url = url.trim();
    
    // Si ya es una URL completa, retornarla
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    
    // Si es una ruta relativa, convertirla a URL absoluta
    // Ajusta esto según tu configuración
    const baseUrl = process.env.APP_URL || 'https://spree.api.klint.cl/api';
    
    // Remover barras iniciales duplicadas
    if (url.startsWith('/')) {
      url = url.substring(1);
    }
    
    // Para rutas como "warehouse_products/default.jpg"
    if (url.includes('warehouse_products/') || url.includes('products/')) {
      return `${baseUrl}/images/${url}`;
    }
    
    // Para otros casos, asumir que está en storage
    return `${baseUrl}/images/${url}`;
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
      // Validación especial para el título
      if (field === 'title' || field === 'name') {
        const clean = this.validateTitle(value);
        return clean || 'Producto genérico'; // fallback seguro
      }

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
   * Valida el título según las normas de Mercado Libre.
   * @param {string} title
   * @returns {string|null}
   */
  static validateTitle(title) {
    if (typeof title !== 'string') return title;

    const forbiddenPhrases = [
     /^stock$/i,  // Solo si es exactamente "stock"
    /envío gratis/i,
    /cuotas sin interés/i,
    /devolución gratis/i,
    /oferta exclusiva/i,
    /descuento especial/i,
    /garantía incluida/i,
    /mejor precio/i
  ];

    for (const phrase of forbiddenPhrases) {
      if (phrase.test(title)) {
        logger.warn(`[Transformer] Título rechazado por contener frase prohibida: "${title}"`);
        return null; // o podrías limpiarlo, pero recomendado rechazar
      }
    }

    // Normalizar y limpiar
    let clean = title.trim().replace(/[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ\s]/g, ' ');
    clean = clean.replace(/\s+/g, ' ');

    return clean;
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