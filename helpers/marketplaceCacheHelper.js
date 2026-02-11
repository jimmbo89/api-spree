// helpers/marketplaceCacheHelper.js
const { marketplaceCache } = require('../config/cache');

/**
 * Genera una clave única para el caché (sin dependencia de usuario)
 * @param {string} marketplaceId - ID de la plataforma (ej: "falabella")
 * @param {string} type - Tipo de dato: 'product_suggestion' o 'category_attributes'
 * @param {string} identifier - Identificador único (nombre del producto o ID de categoría)
 * @returns {string} Clave del caché
 */
const generateCacheKey = (marketplaceId, type, identifier) => {
  return `${marketplaceId}_${type}_${identifier}`;
};

/**
 * Obtiene datos del caché
 * @param {string} marketplaceId
 * @param {string} type
 * @param {string} identifier
 * @returns {any|null} Datos del caché o null si no existe
 */
const getFromCache = (marketplaceId, type, identifier) => {
  const key = generateCacheKey(marketplaceId, type, identifier);
  return marketplaceCache.get(key);
};

/**
 * Guarda datos en el caché
 * @param {string} marketplaceId
 * @param {string} type
 * @param {string} identifier
 * @param {any} data - Datos a guardar
 * @param {number} ttl - Tiempo de vida en segundos (opcional)
 */
const saveToCache = (marketplaceId, type, identifier, data, ttl = null) => {
  const key = generateCacheKey(marketplaceId, type, identifier);
  marketplaceCache.set(key, data, ttl);
};

/**
 * Elimina datos del caché
 * @param {string} marketplaceId
 * @param {string} type
 * @param {string} identifier
 */
const deleteFromCache = (marketplaceId, type, identifier) => {
  const key = generateCacheKey(marketplaceId, type, identifier);
  marketplaceCache.del(key);
};

/**
 * Limpia caché de una plataforma y site específico (para MercadoLibre)
 * @param {string} marketplaceId
 * @param {string} siteId - Opcional, ej: 'MLC', 'MLA'
 */
const clearMarketplaceCache = (marketplaceId, siteId = null) => {
  const keys = marketplaceCache.keys();
  
  let filteredKeys;
  if (siteId) {
    // Limpiar solo un site específico
    filteredKeys = keys.filter(key => 
      key.startsWith(`${marketplaceId}_`) && 
      (key.includes(`_${siteId}_`) || !key.includes('_ML'))
    );
  } else {
    // Limpiar toda la plataforma
    filteredKeys = keys.filter(key => key.startsWith(`${marketplaceId}_`));
  }
  
  marketplaceCache.del(filteredKeys);
  return filteredKeys.length;
};

/**
 * Limpia todo el caché global
 */
const clearAllCache = () => {
  marketplaceCache.flushAll();
};


/**
 * Obtiene estadísticas del caché
 */
const getCacheStats = () => {
  return marketplaceCache.getStats();
};

module.exports = {
  generateCacheKey,
  getFromCache,
  saveToCache,
  deleteFromCache,
  clearMarketplaceCache,
  clearAllCache,
  getCacheStats
};