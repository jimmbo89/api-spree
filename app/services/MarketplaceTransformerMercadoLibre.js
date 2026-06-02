// src/services/MarketplaceTransformerMercadoLibre.js
const logger = require('../../config/logger');
const { MarketplaceRepository } = require('../repositories');

class MarketplaceTransformerMercadoLibre {
  static isGenericLabel(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return (
      normalized === 'producto sin nombre' ||
      normalized === 'producto sin titulo' ||
      normalized === 'producto sin título' ||
      normalized.startsWith('producto sin ')
    );
  }

  static resolveDisplayName(product) {
    return (
      product?.family_name ||
      product?.name ||
      product?.title ||
      "Producto sin nombre"
    );
  }

  static async transformProducts(products, marketplaceId) {
    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplaceId);
    const exportMappings = mappings.filter(m => m.direction !== 'import');

    return products.map(product => {
      const transformed = {};

      // 🔑 Preservar name/title usando family_name como respaldo para ML
      const displayName = this.resolveDisplayName(product);
      transformed.name = (!product.name || this.isGenericLabel(product.name))
        ? displayName
        : product.name;
      transformed.title = (!product.title || this.isGenericLabel(product.title))
        ? displayName || "Producto sin título"
        : product.title;

      // 🔑 Preservar family_name si existe
      if (product.family_name) {
        transformed.family_name = product.family_name;
      }

      // ✅ ATRIBUTOS PRIORITARIOS CON NORMALIZACIÓN DE IMÁGENES
      if (product.attributes) transformed.attributes = product.attributes;
      if (product.variations) transformed.variations = product.variations;
      if (product.sale_terms) transformed.sale_terms = product.sale_terms;
      if (product.description) transformed.description = product.description;
      
      // ✅ NORMALIZAR IMÁGENES ANTES DE ASIGNAR
      if (product.pictures) {
        transformed.pictures = this.normalizePictures(product.pictures);
      }
      
      if (product.price !== undefined) transformed.price = product.price;
      if (product.available_quantity !== undefined) transformed.available_quantity = product.available_quantity;
      if (product.stock !== undefined) transformed.stock = product.stock;
      if (product.category_id) transformed.category_id = product.category_id;
      if (product.condition) transformed.condition = product.condition;
      if (product.currency_id) transformed.currency_id = product.currency_id;
      if (product.buying_mode) transformed.buying_mode = product.buying_mode;
      if (product.listing_type_id) transformed.listing_type_id = product.listing_type_id;
      if (product.shipping_mode) transformed.shipping_mode = product.shipping_mode;
      if (product.logistic_type) transformed.logistic_type = product.logistic_type;
      if (product.seller_custom_field) transformed.seller_custom_field = product.seller_custom_field;

      // Mappings adicionales
      for (const mapping of exportMappings) {
        if (transformed[mapping.external_field] !== undefined) continue;

        let value = product[mapping.internal_field];
        if (value !== undefined && value !== null) {
          transformed[mapping.external_field] = value;
        }
      }

      // 🔑 Fallback para family_name con variaciones
      if (!transformed.family_name && (transformed.variations || product.variants)) {
        transformed.family_name = transformed.name || transformed.title || "Producto";
      }

      return transformed;
    });
  }

  // ✅ MÉTODO DE NORMALIZACIÓN DE IMÁGENES (COPIADO DE MarketplaceTransformer)
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
      logger.error(`[TransformerML] Error normalizando imágenes:`, error.message);
    }
    
    if (result.length === 0) {
      logger.warn(`[TransformerML] No se encontraron imágenes válidas, usando placeholder`);
      result.push({ 
        source: 'https://via.placeholder.com/600x600/3498db/ffffff?text=Producto+Sin+Imagen'
      });
    }
    
    logger.info(`[TransformerML] Normalizadas ${result.length} imágenes`);
    return result;
  }

  // ✅ MÉTODO DE NORMALIZACIÓN DE URL (COPIADO DE MarketplaceTransformer)
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
}

module.exports = MarketplaceTransformerMercadoLibre;
