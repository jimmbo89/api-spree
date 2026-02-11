// config/cache.js
const NodeCache = require('node-cache');

// Caché para la API de Falabella
const marketplaceCache = new NodeCache({
  stdTTL: 600,        // Tiempo de vida: 10 minutos
  checkperiod: 120,   // Limpieza automática cada 2 minutos
  useClones: false    // Mejor rendimiento, no clona objetos
});

module.exports = { marketplaceCache };