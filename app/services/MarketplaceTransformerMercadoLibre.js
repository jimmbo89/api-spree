// src/services/MarketplaceTransformerMercadoLibre.js
const { MarketplaceRepository } = require('../repositories');

class MarketplaceTransformerMercadoLibre {

 static async transformProducts(products, marketplaceId) {
    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplaceId);
    const exportMappings = mappings.filter(m => m.direction !== 'import');

    return products.map(product => {
      const transformed = {};

      // 🔑 CORREGIDO: Preservar SIEMPRE name y title originales
      transformed.name = product.name || product.title || "Producto sin nombre";
      transformed.title = product.title || product.name || "Producto sin título";

      // 🔑 CORREGIDO: Si existe family_name en el producto original, preservarlo
      if (product.family_name) {
        transformed.family_name = product.family_name;
      }

      // Atributos prioritarios
      if (product.attributes) transformed.attributes = product.attributes;
      if (product.variations) transformed.variations = product.variations;
      if (product.sale_terms) transformed.sale_terms = product.sale_terms;
      if (product.description) transformed.description = product.description;
      if (product.pictures) transformed.pictures = product.pictures;
      if (product.price !== undefined) transformed.price = product.price;
      if (product.available_quantity !== undefined) transformed.available_quantity = product.available_quantity;
      if (product.stock !== undefined) transformed.stock = product.stock;
      if (product.category_id) transformed.category_id = product.category_id;
      if (product.condition) transformed.condition = product.condition;
      if (product.currency_id) transformed.currency_id = product.currency_id;
      if (product.buying_mode) transformed.buying_mode = product.buying_mode;
      if (product.listing_type_id) transformed.listing_type_id = product.listing_type_id;
      if (product.seller_custom_field) transformed.seller_custom_field = product.seller_custom_field;

      // Mappings adicionales (solo si no existen ya)
      for (const mapping of exportMappings) {
        if (transformed[mapping.external_field] !== undefined) continue;

        let value = product[mapping.internal_field];
        if (value !== undefined && value !== null) {
          transformed[mapping.external_field] = value;
        }
      }

      // 🔑 CORREGIDO: Si no hay family_name pero sí hay variaciones, usar name como fallback
      if (!transformed.family_name && (transformed.variations || product.variants)) {
        transformed.family_name = transformed.name || transformed.title || "Producto";
      }

      return transformed;
    });
  }
}

module.exports = MarketplaceTransformerMercadoLibre;
