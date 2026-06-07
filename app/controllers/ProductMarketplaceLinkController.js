// src/controllers/ProductMarketplaceLinkController.js
const logger = require('../../config/logger');
const {
  ProductMarketplaceLinkRepository,
  ProductRepository,
  MarketplaceRepository,
  CompanyRepository,
  BranchRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const ProductMarketplaceLinkController = {
  async list(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Lista links de marketplace`);
    const { marketplace_id, company_id, branch_id, user_id } = req.body;
    const metadata = getRequestMetadata(req);

    try {
      const marketplace = await MarketplaceRepository.findById(marketplace_id);
      if (!marketplace) return res.status(400).json({ msg: "marketplaceNotFound" });

      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) return res.status(400).json({ msg: "companyNotFound" });
      }
      if (branch_id) {
        const branch = await BranchRepository.findById(branch_id);
        if (!branch) return res.status(400).json({ msg: "branchNotFound" });
      }

      const links = await ProductMarketplaceLinkRepository.findByMarketplace(
        marketplace_id,
        company_id,
        branch_id,
        user_id || null
      );

      const mapped = links.map(l => ({
        id: l.id,
        product_id: l.product_id,
        marketplace_id: l.marketplace_id,
        company_id: l.company_id,
        branch_id: l.branch_id,
        user_id: l.user_id,
        status: l.status,
        external_id: l.external_id,
        external_url: l.external_url,
        last_synced_at: l.last_synced_at
      }));

      res.status(200).json({ product_marketplace_links: mapped });
    } catch (error) {
      logger.error('ProductMarketplaceLinkController->list: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    try {
      const { product_id, marketplace_id, company_id, branch_id, user_id } = req.body;
      
      const link = await ProductMarketplaceLinkRepository.findByProductAndMarketplace(
        product_id,
        marketplace_id,
        company_id,
        branch_id,
        null,
        user_id || null
      );
      
      if (!link) return res.status(404).json({ msg: "LinkNotFound" });

      res.status(200).json({
        product_marketplace_link: {
          id: link.id,
          product_id: link.product_id,
          marketplace_id: link.marketplace_id,
          company_id: link.company_id,
          branch_id: link.branch_id,
          user_id: link.user_id,
          status: link.status,
          external_id: link.external_id,
          external_url: link.external_url,
          last_synced_at: link.last_synced_at
        }
      });
    } catch (error) {
      logger.error('ProductMarketplaceLinkController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  }
};

module.exports = ProductMarketplaceLinkController;
