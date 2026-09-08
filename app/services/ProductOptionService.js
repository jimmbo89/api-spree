'use strict';

const { ProductVariant, ProductVariantValue } = require('../models');

function normalizeVariantValueIds(valueIds = []) {
  if (!Array.isArray(valueIds)) return [];

  return [...new Set(
    valueIds
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )].sort((left, right) => left - right);
}

function buildOptionKey(productId, valueIds = []) {
  return `${Number(productId)}:${normalizeVariantValueIds(valueIds).join(',')}`;
}

function getDuplicateOptionGroups(variants = [], productId = null) {
  const grouped = new Map();

  for (const variant of variants) {
    const valueIds = normalizeVariantValueIds(variant?.variant_value_ids);
    const key = buildOptionKey(productId ?? variant?.product_id, valueIds);
    const current = grouped.get(key) || {
      option_key: key,
      variant_value_ids: valueIds,
      variants: []
    };
    current.variants.push(variant);
    grouped.set(key, current);
  }

  return [...grouped.values()].filter((group) => group.variants.length > 1);
}

async function findProductOptions(productId, options = {}) {
  const rows = await ProductVariantValue.findAll({
    include: [{
      model: ProductVariant,
      as: 'productVariant',
      where: { product_id: productId },
      attributes: ['id', 'product_id', 'sku', 'attributes'],
      required: true
    }],
    attributes: ['product_variant_id', 'variant_value_id'],
    transaction: options.transaction
  });

  const grouped = new Map();
  for (const row of rows) {
    const variantId = Number(row.product_variant_id);
    const valueIds = grouped.get(variantId) || [];
    valueIds.push(Number(row.variant_value_id));
    grouped.set(variantId, valueIds);
  }

  const variants = await ProductVariant.findAll({
    where: { product_id: productId },
    attributes: ['id', 'product_id', 'sku', 'attributes'],
    transaction: options.transaction
  });

  return variants.map((variant) => {
    const valueIds = normalizeVariantValueIds(grouped.get(Number(variant.id)) || []);
    return {
      variant,
      variant_value_ids: valueIds,
      option_key: buildOptionKey(productId, valueIds)
    };
  });
}

function buildDuplicateOptionError(duplicates, message = 'La combinación de características ya existe') {
  return {
    success: false,
    code: 'PRODUCT_OPTION_DUPLICATE',
    message,
    duplicates: duplicates.map((duplicate) => ({
      variant_value_ids: duplicate.variant_value_ids,
      client_keys: duplicate.variants
        .map((variant) => variant?.client_key)
        .filter(Boolean),
      variant_ids: duplicate.variants
        .map((variant) => variant?.id)
        .filter((id) => id !== undefined && id !== null)
    }))
  };
}

module.exports = {
  normalizeVariantValueIds,
  buildOptionKey,
  getDuplicateOptionGroups,
  findProductOptions,
  buildDuplicateOptionError
};
