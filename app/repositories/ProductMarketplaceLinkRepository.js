// src/repositories/ProductMarketplaceLinkRepository.js
const { ProductMarketplaceLink } = require('../models');
const logger = require('../../config/logger');

const ProductMarketplaceLinkRepository = {
  async findByProductAndMarketplace(productId, marketplaceId, companyId, branchId) {
    const where = { product_id: productId, marketplace_id: marketplaceId };
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;

    return await ProductMarketplaceLink.findOne({ where });
  },

  async upsert(linkData, options = {}) {
    logger.info(`[REPO] Guardando link para producto ${linkData.product_id}`);
    try {
      // Validar contexto
      if ((linkData.company_id && linkData.branch_id) || (!linkData.company_id && !linkData.branch_id)) {
        throw new Error('Debe proporcionar company_id o branch_id');
      }

      const [record] = await ProductMarketplaceLink.upsert(linkData, options);
      return record;
    } catch (error) {
      logger.error(`[REPO] ERROR al guardar link:`, error.message);
      throw error;
    }
  },

  async findByMarketplace(marketplaceId, companyId, branchId) {
    const where = { marketplace_id: marketplaceId };
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;

    return await ProductMarketplaceLink.findAll({ where });
  }
};

module.exports = ProductMarketplaceLinkRepository;