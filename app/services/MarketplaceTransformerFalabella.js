// src/services/MarketplaceTransformerFalabella.js
const { MarketplaceRepository } = require('../repositories');
const logger = require('../../config/logger');

class MarketplaceTransformerFalabella {
  static async transformProducts(products, marketplaceId) {
    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplaceId);
    const exportMappings = mappings.filter(m => m.direction !== 'import');

    return products.map(product => {
      const transformed = {};

      // 🔑 PRESERVAR CAMPOS OBLIGATORIOS DE FALABELLA (SIEMPRE)
      transformed.sku = product.sku || product.SellerSku || `PROD-${product.productId || product.id}`;
      transformed.productName = product.productName || product.name || product.title || 'Producto sin nombre';
      transformed.brand = product.brand || 'Genérica';
      transformed.price = product.price || product.Price || 0;
      transformed.stock = product.stock || product.Stock || product.available_quantity || 0;
      transformed.PrimaryCategory = product.PrimaryCategory || product.category_id || product.category?.category_id;
      transformed.description = product.description || product.Description || 'Producto sin descripción';
      
      // 🔑 Package dimensions (obligatorios para Falabella)
      transformed.package_height = product.package_height || product.height_cm || product.height || 10;
      transformed.package_width = product.package_width || product.width_cm || product.width || 10;
      transformed.package_length = product.package_length || product.length_cm || product.length || 10;
      transformed.package_weight = product.package_weight || (product.weight_grams ? product.weight_grams / 1000 : 0.5);

      // 🔑🔑 PRESERVAR ATRIBUTOS PROCESADOS (CORRECCIÓN CLAVE)
      // Los atributos YA vienen procesados desde prepareProduct, solo copiarlos manteniendo estructura
      if (Array.isArray(product.attributes) && product.attributes.length > 0) {
        transformed.attributes = product.attributes.map(attr => ({
          id: attr.id,
          value_id: attr.value_id,
          value_name: attr.value_name,
          value: attr.value_name || attr.value_id, // Compatibilidad con legacy
          example_value: attr.example_value || null
        }));
      } else {
        // Si no hay atributos, mantener array vacío (nunca undefined)
        transformed.attributes = [];
      }

      // 🔑🔑 PRESERVAR IMÁGENES (CORRECIÓN ADICIONAL)
      if (Array.isArray(product.images) && product.images.length > 0) {
        transformed.images = product.images;
      }
      // Fallback para otros nombres de campo
      if (Array.isArray(product.pictures) && product.pictures.length > 0) {
        transformed.images = transformed.images || product.pictures;
      }

      // 🔑 Campos adicionales (opcionales pero útiles)
      if (product.categoryName) transformed.categoryName = product.categoryName;
      if (product.productId) transformed.productId = product.productId;

      // 🔑 Aplicar mapeos adicionales del repositorio (solo si no existen ya)
      for (const mapping of exportMappings) {
        if (transformed[mapping.external_field] !== undefined) continue;
        
        let value = product[mapping.internal_field];
        if (value !== undefined && value !== null) {
          transformed[mapping.external_field] = value;
        }
      }

      return transformed;
    });
  }
}

module.exports = MarketplaceTransformerFalabella;