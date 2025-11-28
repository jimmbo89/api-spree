// repositories/MarketplaceCredentialRepository.js
const { MarketplaceCredential, Marketplace } = require('../models');
const EncryptionService = require('../services/EncryptionService');
const logger = require('../../config/logger');

const MarketplaceCredentialRepository = {
  async findByMarketplaceAndContext(marketplaceId, companyId, branchId) {
    const where = { marketplace_id: marketplaceId };
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;

    const record = await MarketplaceCredential.findOne({
      where,
      include: [
        {
          model: Marketplace,
          as: 'marketplace', // ajusta si usas otro alias
          attributes: ['domain'], // solo traemos el campo necesario
          required: true
        }
      ]
    });

    if (!record) return null;

    // Desencriptar campos sensibles
    if (record.access_token) record.access_token = EncryptionService.decrypt(record.access_token);
    if (record.refresh_token) record.refresh_token = EncryptionService.decrypt(record.refresh_token);
    if (record.client_secret) record.client_secret = EncryptionService.decrypt(record.client_secret);

    // Devolver credencial + dominio del marketplace
    return {
      ...record.get({ plain: true }), // asegura objeto plano
      marketplace_domain: record.marketplace?.domain?.trim()
    };
  },

  async createOrUpdate(credentialData, options = {}) {
    logger.info(`[REPO] Guardando credenciales para marketplace ${credentialData.marketplace_id}`);
    try {
      // Validar contexto
      if ((credentialData.company_id && credentialData.branch_id) || (!credentialData.company_id && !credentialData.branch_id)) {
        throw new Error('Debe proporcionar exactamente company_id O branch_id');
      }

      const dataToSave = {
        ...credentialData,
        access_token: credentialData.access_token ? EncryptionService.encrypt(credentialData.access_token) : null,
        refresh_token: credentialData.refresh_token ? EncryptionService.encrypt(credentialData.refresh_token) : null,
        client_secret: credentialData.client_secret ? EncryptionService.encrypt(credentialData.client_secret) : null
      };

      const [record] = await MarketplaceCredential.upsert(dataToSave, options);
      return record;
    } catch (error) {
      logger.error(`[REPO] ERROR al guardar credenciales:`, error.message);
      throw error;
    }
  }
};

module.exports = MarketplaceCredentialRepository;