const { MarketplaceRepository } = require('../repositories');
const logger = require('../../config/logger');

class MarketplaceTransformer {
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
        let value = product[internal_field];
        if (value === null || value === undefined || (typeof value === 'string' && value === '')) {
          value = default_value !== undefined && default_value !== null ? default_value : null;
        }
        if (value !== null && validation_rules) {
          value = this.applyValidationRules(value, validation_rules, internal_field);
        }
        this.setNestedField(transformed, external_field, value);
      }
      return transformed;
    });
  }

  static setNestedField(obj, path, value) {
    if (path === 'pictures') {
      obj.pictures = this.normalizePictures(value);
      return;
    }

    // ❌ CORREGIDO: Ahora sí se usa sale_terms para warranty
    if (path === 'sale_terms') {
      // Si es warranty string, convertirlo a sale_terms array
      if (typeof value === 'string') {
        obj.sale_terms = [
          {
            id: 'WARRANTY_TIME',
            value_name: value
          },
          {
            id: 'WARRANTY_TYPE',
            value_name: 'Garantía del vendedor'
          }
        ];
        logger.info(`[Transformer] Convertido warranty string a sale_terms array`);
      }
      // Si ya es array, asignarlo
      else if (Array.isArray(value)) {
        obj.sale_terms = value;
      }
      return;
    }

    // ❌ AÑADIDO: Manejo específico de family_name para productos de catálogo
    if (path === 'family_name' && value && typeof value === 'string') {
      // Para productos de catálogo, family_name es OBLIGATORIO
      let cleanValue = value.replace(/(\b\w+\b)(?:\s+\1)+/gi, '$1')
                          .replace(/\s+/g, ' ')
                          .trim();
      
      // Asegurar que family_name tenga al menos 3 caracteres
      if (cleanValue.length < 3) {
        // Usar título si family_name es muy corto
        if (obj.title && obj.title.length >= 3) {
          cleanValue = obj.title.substring(0, 30);
        } else {
          cleanValue = 'Producto genérico';
        }
      }
      
      obj[path] = cleanValue;
      logger.info(`[Transformer] Family_name procesado: "${cleanValue}"`);
      return;
    }

    if (path === 'attributes' && Array.isArray(value)) {
      const filteredAttributes = value.filter(attr => 
        !['WTY_TIME', 'WARRANTY', 'WARRANTY_TIME', 'WARRANTY_TYPE'].includes(attr.id)
      );
      
      obj.attributes = filteredAttributes.map(attr => ({
        id: attr.id,
        value_name: attr.value_name || attr.value || 'No especificado'
        // value_id solo si es catálogo (gestionado en adapter)
      }));
      
      // Loggear si filtramos warranty
      if (filteredAttributes.length < value.length) {
        logger.info(`[Transformer] Filtrados atributos de warranty (van en sale_terms)`);
      }
      return;
    }

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

  static normalizePictures(value) {
    const result = [];
    try {
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
      } else if (typeof value === 'string' && value.trim()) {
        if (value.startsWith('[') || value.startsWith('{')) {
          try {
            const parsed = JSON.parse(value);
            return this.normalizePictures(parsed);
          } catch (e) {}
        }
        const urlRegex = /(https?:\/\/[^\s\]}]+|[\w\-_]+\.(jpg|jpeg|png|gif|webp))/gi;
        const matches = value.match(urlRegex);
        if (matches) {
          matches.forEach(url => result.push({ source: this.normalizeImageUrl(url) }));
        } else {
          result.push({ source: this.normalizeImageUrl(value) });
        }
      } else if (value && typeof value === 'object' && !Array.isArray(value)) {
        if (value.source) result.push({ source: this.normalizeImageUrl(value.source) });
        else if (value.url) result.push({ source: this.normalizeImageUrl(value.url) });
      }
    } catch (error) {
      logger.error(`[Transformer] Error normalizando imágenes:`, error.message);
    }
    if (result.length === 0) {
      logger.warn(`[Transformer] No se encontraron imágenes válidas, usando placeholder`);
      result.push({ 
        source: 'https://via.placeholder.com/600x600/3498db/ffffff?text=Producto+Sin+Imagen' 
      });
    }
    logger.info(`[Transformer] Normalizadas ${result.length} imágenes`);
    return result;
  }

  static normalizeImageUrl(url) {
    if (!url || typeof url !== 'string') {
      return 'https://via.placeholder.com/600x600/e74c3c/ffffff?text=Error+URL';
    }
    url = url.trim();
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    const baseUrl = process.env.APP_URL || 'https://spree.api.klint.cl/api';
    if (url.startsWith('/')) url = url.substring(1);
    if (url.includes('warehouse_products/') || url.includes('products/')) {
      return `${baseUrl}/images/${url}`;
    }
    return `${baseUrl}/images/${url}`;
  }

  static applyValidationRules(value, rules, field) {
    try {
      if (field === 'title' || field === 'name') {
        const clean = this.validateTitle(value);
        return clean || 'Producto genérico';
      }
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
      if (typeof value === 'string') {
        if (rules.minLength !== undefined && value.length < rules.minLength) return null;
        if (rules.maxLength !== undefined && value.length > rules.maxLength) {
          return value.substring(0, rules.maxLength);
        }
        if (rules.regex !== undefined) {
          const regex = new RegExp(rules.regex);
          if (!regex.test(value)) return null;
        }
        if (rules.enum && !rules.enum.includes(value)) return null;
      }
      return value;
    } catch (error) {
      logger.error(`[Transformer] Error aplicando reglas a ${field}:`, error.message);
      return null;
    }
  }

  static validateTitle(title) {
    if (typeof title !== 'string') return title;
    const forbiddenPhrases = [
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
        logger.warn(`[Transformer] Título rechazado: "${title}"`);
        return null;
      }
    }
    let clean = title.trim().replace(/[^a-zA-Z0-9áéíóúüñÁÉÍÓÚÜÑ\s]/g, ' ');
    clean = clean.replace(/\s+/g, ' ');
    return clean;
  }

  static async reverseTransform(externalPayload, marketplaceId) {
    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplaceId);
    const importMappings = mappings.filter(m => 
      m.direction === 'import' || m.direction === 'both'
    );
    const internalData = {};
    for (const mapping of importMappings) {
      const { internal_field, external_field } = mapping;
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