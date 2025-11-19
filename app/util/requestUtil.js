// src/utils/requestUtils.js
const getRequestMetadata = (req) => {
  return {
    ip_address: req.ip || req.connection?.remoteAddress || 'unknown',
    user_agent: req.get('User-Agent') || null,
    user_id: req.user?.id || null
  };
};

module.exports = { getRequestMetadata };