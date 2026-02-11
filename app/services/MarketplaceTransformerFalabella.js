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

      // 🔑 Campos adicionales (opcionales pero útiles)
      if (product.categoryName) transformed.categoryName = product.categoryName;
      if (product.productId) transformed.productId = product.productId;
      if (product.images) transformed.images = product.images;
      if (product.pictures) transformed.pictures = product.pictures;
      if (product.attributes) transformed.attributes = product.attributes;

      // 🔑 Aplicar mapeos adicionales (solo si no existen ya)
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