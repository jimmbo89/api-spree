// src/services/MarketplaceTransformerFalabella.js
const { MarketplaceRepository } = require('../repositories');
const logger = require('../../config/logger');

class MarketplaceTransformerFalabella {
  static coerceNumber(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      const parsed = Number(value.trim().replace(',', '.'));
      return Number.isFinite(parsed) ? parsed : null;
    }
    if (typeof value === 'object' && value !== null && 'value' in value) {
      return this.coerceNumber(value.value);
    }
    return null;
  }

  static toCentimeters(measurement) {
    if (!measurement) return null;
    const value = this.coerceNumber(measurement);
    if (value === null) return null;
    const unit = String(measurement?.unit || 'cm').toLowerCase();

    switch (unit) {
      case 'm': return value * 100;
      case 'mm': return value / 10;
      case 'in': return value * 2.54;
      case 'ft': return value * 30.48;
      case 'cm':
      default: return value;
    }
  }

  static toKilograms(measurement) {
    if (!measurement) return null;
    const value = this.coerceNumber(measurement);
    if (value === null) return null;
    const unit = String(measurement?.unit || 'g').toLowerCase();

    switch (unit) {
      case 'kg': return value;
      case 'g': return value / 1000;
      case 'lb': return value * 0.453592;
      case 'oz': return value * 0.0283495;
      default: return value;
    }
  }

  static resolvePackageMeasurements(product) {
    const productMeasurements = product?.product_measurements || {};
    const dimensions = productMeasurements?.dimensions || {};

    const height = this.toCentimeters(dimensions.height) ??
      this.coerceNumber(product.package_height) ??
      this.coerceNumber(product.height_cm) ??
      this.coerceNumber(product.height) ??
      null;
    const width = this.toCentimeters(dimensions.width) ??
      this.coerceNumber(product.package_width) ??
      this.coerceNumber(product.width_cm) ??
      this.coerceNumber(product.width) ??
      null;
    const length = this.toCentimeters(dimensions.length ?? dimensions.depth) ??
      this.coerceNumber(product.package_length) ??
      this.coerceNumber(product.length_cm) ??
      this.coerceNumber(product.length) ??
      null;
    const weight = this.toKilograms(productMeasurements?.weight) ??
      this.coerceNumber(product.package_weight) ??
      (product.weight_grams != null ? this.coerceNumber(product.weight_grams) / 1000 : null) ??
      null;

    return { height, width, length, weight };
  }

  static async transformProducts(products, marketplaceId) {
    const mappings = await MarketplaceRepository.findMappingsByMarketplace(marketplaceId);
    const exportMappings = mappings.filter(m => m.direction !== 'import');

    return products.map(product => {
      const transformed = {};
      const packageMeasurements = this.resolvePackageMeasurements(product);

      // 🔑 PRESERVAR CAMPOS OBLIGATORIOS DE FALABELLA (SIEMPRE)
      transformed.sku = product.sku || product.SellerSku || null;
      transformed.productName = product.productName || product.name || product.title || null;
      transformed.brand = product.brand || null;
      transformed.price = product.price ?? product.Price ?? null;
      transformed.stock = product.stock ?? product.Stock ?? product.available_quantity ?? null;
      transformed.PrimaryCategory = product.PrimaryCategory || product.category_id || product.category?.category_id || product.category?.id;
      transformed.description = product.description || product.Description || null;
      
      // 🔑 Package dimensions (obligatorios para Falabella)
      transformed.package_height = packageMeasurements.height;
      transformed.package_width = packageMeasurements.width;
      transformed.package_length = packageMeasurements.length;
      transformed.package_weight = packageMeasurements.weight;

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
      if (product.ParentSku) transformed.ParentSku = product.ParentSku;
      if (Array.isArray(product.falabella_products) && product.falabella_products.length > 0) {
        transformed.falabella_products = product.falabella_products.map((item) => ({
          ...item,
          attributes: Array.isArray(item.attributes) ? item.attributes : [],
          images: Array.isArray(item.images) ? item.images : []
        }));
      }

      if (Array.isArray(product.falabella_publication_items) && product.falabella_publication_items.length > 0) {
        transformed.falabella_publication_items = product.falabella_publication_items.map((item) => ({
          ...item,
          attributes: Array.isArray(item.attributes) ? item.attributes : [],
          images: Array.isArray(item.images) ? item.images : []
        }));
      }

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
