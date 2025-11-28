// controllers/MarketplaceCredentialController.js
const logger = require('../../config/logger');
const {
  MarketplaceCredentialRepository,
  MarketplaceRepository,
  CompanyRepository,
  BranchRepository,
  LogRepository
} = require('../repositories');
const { getRequestMetadata } = require('../util/requestUtil');

const MarketplaceCredentialController = {
  async store(req, res) {
    logger.info(`${req.user?.name || 'Unknown'} - Guarda credenciales de marketplace`);
    const { marketplace_id, company_id, branch_id } = req.body;
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

      const credential = await MarketplaceCredentialRepository.createOrUpdate(req.body);

      await LogRepository.create({
        user_id: metadata.user_id,
        action: 'marketplace_credential.create',
        description: `Credenciales guardadas para marketplace ${marketplace_id}`,
        ip_address: metadata.ip_address,
        user_agent: metadata.user_agent,
        status: 'success',
        meta: { id: credential.id }
      });

      res.status(201).json({ message: "Credenciales guardadas", credential: { id: credential.id } });
    } catch (error) {
      await LogRepository.create({
        user_id: metadata?.user_id,
        action: 'marketplace_credential.create',
        description: `Error: ${error.message}`,
        ip_address: metadata?.ip_address,
        user_agent: metadata?.user_agent,
        status: 'error',
        meta: null
      });
      logger.error('MarketplaceCredentialController->store: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  },

  async show(req, res) {
    try {
      const { marketplace_id, company_id, branch_id } = req.body;
      const credential = await MarketplaceCredentialRepository.findByMarketplaceAndContext(
        marketplace_id,
        company_id,
        branch_id
      );
      if (!credential) return res.status(404).json({ msg: "CredentialNotFound" });

      // ❌ Nunca devolver secrets en la respuesta
      res.status(200).json({
        id: credential.id,
        marketplace_id: credential.marketplace_id,
        company_id: credential.company_id,
        branch_id: credential.branch_id,
        client_id: credential.client_id,
        client_secret: credential.client_secret,
        redirect_uri: credential.redirect_uri,
        expires_at: credential.expires_at,
        scopes: credential.scopes,
        active: credential.active
      });
    } catch (error) {
      logger.error('MarketplaceCredentialController->show: ' + error.message);
      res.status(500).json({ error: 'ServerError' });
    }
  }
};

module.exports = MarketplaceCredentialController;