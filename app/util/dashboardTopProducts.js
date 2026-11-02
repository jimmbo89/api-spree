function getMainImage(imagesValue) {
  try {
    const images = typeof imagesValue === 'string'
      ? JSON.parse(imagesValue)
      : imagesValue;
    return Array.isArray(images) && images.length > 0 ? images[0] : null;
  } catch (error) {
    return null;
  }
}

function getQuantity(row) {
  const quantity = Number.parseInt(row.total_quantity || 0, 10);
  return Number.isNaN(quantity) ? 0 : quantity;
}

function mergeTopProducts(linkedItems = [], unlinkedItems = [], limit = 3) {
  const linked = linkedItems.map(row => ({
    id: row.product_id,
    externalId: null,
    name: row['product.name'] || 'Producto sin identificar',
    value: getQuantity(row),
    image: getMainImage(row['product.images']),
    isLinked: true
  }));

  const unlinked = unlinkedItems.map(row => ({
    id: null,
    externalId: [
      row.marketplace,
      row.listing_id || row.marketplace_item_id || row.sku
    ].filter(Boolean).join(':') || null,
    marketplace: row.marketplace || null,
    name: row.title
      || row.sku
      || row.listing_id
      || row.marketplace_item_id
      || 'Producto sin identificar',
    value: getQuantity(row),
    image: null,
    isLinked: false
  }));

  return [...linked, ...unlinked]
    .sort((a, b) => b.value - a.value)
    .slice(0, limit);
}

module.exports = {
  mergeTopProducts
};
