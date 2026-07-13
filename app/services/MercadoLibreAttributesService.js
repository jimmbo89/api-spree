const axios = require('axios');
const logger = require('../../config/logger');

class MercadoLibreAttributesService {
  /**
   * Obtiene TODOS los atributos de una categoría desde la API
   */
  static async getCategoryAttributes(categoryId, accessToken, siteId = 'MLC') {
    try {
      // ✅ Corregido: eliminar espacios en la URL
      const url = `https://api.mercadolibre.com/categories/${categoryId}/attributes`;
    
      const response = await axios.get(url, {
        headers: { 
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        params: { site_id: siteId },
        timeout: 15000
      });

      // Procesar y clasificar atributos
      const attributes = response.data.map(attr => ({
        id: attr.id,
        name: attr.name,
        value_type: attr.value_type,
        values: attr.values || [],
        tags: attr.tags || {},
        hint: attr.hint || attr.tooltip || '',
        required: !!(attr.tags?.required),
        catalog_required: !!(attr.tags?.catalog_required),
        variations_attribute: !!(attr.tags?.allow_variations), // ✅ Corregido: usar allow_variations
        hidden: !!(attr.tags?.hidden),
        read_only: !!(attr.tags?.read_only),
        multivalued: !!(attr.tags?.multivalued),
        allowed_units: attr.allowed_units || [],
        default_unit: attr.default_unit,
        value_max_length: attr.value_max_length,
        value_min_length: attr.value_min_length,
        example: attr.example,
        help: attr.help
      }));

      return {
        success: true,
        attributes,
        required: attributes.filter(attr => attr.required),
        catalog_required: attributes.filter(attr => attr.catalog_required),
        variations: attributes.filter(attr => attr.variations_attribute),
        all: attributes
      };
    } catch (error) {
      logger.error(`[AttributesService] Error obteniendo atributos: ${error.message}`);
      
      if (error.response?.status === 404) {
        logger.error(`[AttributesService] Categoría ${categoryId} no encontrada`);
      }
      
      return { 
        success: false, 
        error: error.message,
        status_code: error.response?.status
      };
    }
  }

  /**
   * Obtiene valores posibles para un atributo específico
   */
  static async getAttributeValues(attributeId, accessToken, siteId = 'MLC') {
    try {
      // ✅ Corregido: eliminar espacios en la URL
      const url = `https://api.mercadolibre.com/attributes/${attributeId}`;
      
      const response = await axios.get(url, {
        headers: { 
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        params: { site_id: siteId },
        timeout: 10000
      });

      const attribute = response.data;
      
      return {
        success: true,
        attribute: {
          id: attribute.id,
          name: attribute.name,
          value_type: attribute.value_type,
          values: attribute.values || [],
          tags: attribute.tags || {},
          hint: attribute.hint,
          allowed_units: attribute.allowed_units || [],
          example: attribute.example
        },
        values: attribute.values || [],
        allowed_units: attribute.allowed_units || []
      };
    } catch (error) {
      logger.warn(`[AttributesService] No se pudieron obtener valores para ${attributeId}: ${error.message}`);
      return { 
        success: false, 
        error: error.message,
        status_code: error.response?.status
      };
    }
  }

  /**
   * Busca en el catálogo de Mercado Libre
   */
  static async searchCatalog(query, accessToken, siteId = 'MLC') {
    try {
      // ✅ Corregido: eliminar espacios en la URL
      const url = `https://api.mercadolibre.com/sites/${siteId}/search`;
      
      const response = await axios.get(url, {
        headers: { 
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json'
        },
        params: {
          q: query,
          category: 'catalog',
          limit: 5
        },
        timeout: 10000
      });

      const catalogProducts = response.data.results || [];
      
      return {
        success: true,
        results: catalogProducts.map(product => ({
          id: product.id,
          title: product.title,
          catalog_product_id: product.catalog_product_id,
          attributes: product.attributes,
          thumbnail: product.thumbnail,
          price: product.price
        })),
        total: response.data.paging?.total || 0
      };
    } catch (error) {
      logger.warn(`[AttributesService] Búsqueda en catálogo falló: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  /**
   * Valida un conjunto de atributos contra una categoría
   */
  static async validateAttributes(attributes, categoryId, accessToken, siteId) {
    const validation = {
      valid: true,
      errors: [],
      warnings: [],
      suggestions: []
    };

    try {
      const categoryAttrs = await this.getCategoryAttributes(categoryId, accessToken, siteId);
      
      if (!categoryAttrs.success) {
        validation.warnings.push('No se pudieron validar atributos (categoría no disponible)');
        return validation;
      }

      const attributesMap = {};
      if (attributes && Array.isArray(attributes)) {
        attributes.forEach(attr => {
          if (attr.id) {
            attributesMap[attr.id] = attr;
          }
        });
      }

      for (const requiredAttr of categoryAttrs.required) {
        const providedAttr = attributesMap[requiredAttr.id];
        
        if (!providedAttr) {
          validation.errors.push(`Atributo requerido faltante: ${requiredAttr.name} (${requiredAttr.id})`);
          validation.valid = false;
          continue;
        }

        if (!providedAttr.value_name && !providedAttr.value_id) {
          validation.errors.push(`Atributo ${requiredAttr.name} no tiene valor`);
          validation.valid = false;
          continue;
        }

        if (requiredAttr.values && requiredAttr.values.length > 0) {
          let isValid = false;
          
          if (providedAttr.value_id) {
            isValid = requiredAttr.values.some(val => val.id === providedAttr.value_id);
          }
          
          if (!isValid && providedAttr.value_name) {
            isValid = requiredAttr.values.some(val => 
              (val.name || val.value_name || '').toLowerCase() === providedAttr.value_name.toLowerCase()
            );
          }
          
          if (!isValid) {
            validation.warnings.push(`Valor "${providedAttr.value_name}" puede no ser válido para ${requiredAttr.name}`);
          }
        }

        if (requiredAttr.value_max_length && providedAttr.value_name) {
          if (providedAttr.value_name.length > requiredAttr.value_max_length) {
            validation.warnings.push(
              `${requiredAttr.name} excede longitud máxima: ${providedAttr.value_name.length} > ${requiredAttr.value_max_length}`
            );
          }
        }
      }

      for (const catalogAttr of categoryAttrs.catalog_required) {
        const providedAttr = attributesMap[catalogAttr.id];
        
        if (!providedAttr || !providedAttr.value_id) {
          validation.warnings.push(
            `Atributo de catálogo ${catalogAttr.name} requiere value_id válido`
          );
        }
      }

      const providedIds = Object.keys(attributesMap);
      const validIds = categoryAttrs.all.map(attr => attr.id);
      const unknownAttrs = providedIds.filter(id => !validIds.includes(id));
      if (unknownAttrs.length > 0) {
        validation.warnings.push(`Atributos no reconocidos para esta categoría: ${unknownAttrs.join(', ')}`);
      }

    } catch (error) {
      validation.valid = false;
      validation.errors.push(`Error en validación: ${error.message}`);
    }

    return validation;
  }

  /**
   * Valida el formato de un GTIN (EAN/UPC)
   */
  static validateGTINFormat(gtin) {
    if (!gtin || typeof gtin !== 'string') return false;
    
    const digits = gtin.replace(/\D/g, '');
    const length = digits.length;
    
    if (![8, 12, 13, 14].includes(length)) {
      return false;
    }
    
    return this.calculateGTINChecksum(digits) === parseInt(digits.charAt(length - 1));
  }

  /**
   * Calcula el dígito verificador para GTIN
   */
  static calculateGTINChecksum(gtinWithoutCheck) {
    const digits = gtinWithoutCheck.replace(/\D/g, '');
    let sum = 0;
    
    const isEvenLength = digits.length % 2 === 0;
    
    for (let i = 0; i < digits.length - 1; i++) {
      const digit = parseInt(digits.charAt(i));
      const multiplier = (i % 2 === 0) ? (isEvenLength ? 3 : 1) : (isEvenLength ? 1 : 3);
      sum += digit * multiplier;
    }
    
    const remainder = sum % 10;
    return remainder === 0 ? 0 : 10 - remainder;
  }

  /**
   * Genera un EAN-13 válido basado en un identificador
   */
  static generateValidEAN13(baseId) {
    if (!baseId) baseId = '000000001';
    
    const genericPrefixes = ['00', '01', '02', '03', '04', '05', '06', '07', '08', '09'];
    const randomPrefix = genericPrefixes[Math.floor(Math.random() * genericPrefixes.length)];
    
    const baseDigits = baseId.toString().replace(/\D/g, '').substring(0, 10);
    const padded = (baseDigits + '0000000000').substring(0, 10);
    const code12 = randomPrefix + padded;
    const checkDigit = this.calculateGTINChecksum(code12 + '0');
    
    return code12 + checkDigit;
  }

  /**
   * Genera un GTIN válido basado en dígitos existentes
   */
  static generateValidGTIN(existingDigits) {
    const digits = String(existingDigits || '').replace(/\D/g, '');

    if (!digits) {
      return this.generateValidEAN13('000000001');
    }

    if (digits.length >= 12) {
      const base12 = digits.substring(0, 12);
      const checkDigit = this.calculateGTINChecksum(base12 + '0');
      return base12 + checkDigit;
    }

    if (digits.length === 7) {
      const checkDigit = this.calculateGTINChecksum(`${digits}0`);
      return `${digits}${checkDigit}`;
    }

    if (digits.length > 7 && digits.length < 12) {
      return this.generateValidEAN13(digits);
    }

    if (digits.length > 14) {
      return this.generateValidEAN13(digits.substring(0, 10));
    }

    return this.generateValidEAN13(digits);
  }
}

module.exports = MercadoLibreAttributesService;
