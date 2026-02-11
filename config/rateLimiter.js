// config/rateLimiter.js
const { RateLimiterMemory } = require('rate-limiter-flexible');

// Límite: 100 solicitudes por minuto por usuario
const marketplaceRateLimiter = new RateLimiterMemory({
  points: 100,        // Número de solicitudes permitidas
  duration: 60,       // Período en segundos
  execEvenly: false,  // No distribuir solicitudes (mejor para API externa)
  blockDuration: 10   // Bloquear 10 segundos si se excede
});

module.exports = { marketplaceRateLimiter };