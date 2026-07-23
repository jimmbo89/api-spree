// src/repositories/ProductMarketplaceLinkRepository.js
const { ProductMarketplaceLink, MarketplaceCredential } = require('../models');
const logger = require('../../config/logger');

const ProductMarketplaceLinkRepository = {
  buildScopeWhere(linkData = {}) {
    const where = {};

    if (linkData.product_id != null) where.product_id = linkData.product_id;
    if (linkData.marketplace_id != null) where.marketplace_id = linkData.marketplace_id;
    if (linkData.company_id != null) where.company_id = linkData.company_id;
    if (linkData.branch_id != null) where.branch_id = linkData.branch_id;
    if (linkData.credential_id != null) where.credential_id = linkData.credential_id;
    if (linkData.external_id != null) where.external_id = linkData.external_id;

    return where;
  },

  /**
   * Busca un link por producto y marketplace
   * @param {number} productId - ID del producto
   * @param {number} marketplaceId - ID del marketplace
   * @param {number|null} companyId - ID de la empresa (opcional)
   * @param {number|null} branchId - ID de la sucursal (opcional)
   * @param {number|null} credentialId - ID de la credencial (opcional, NUEVO)
   * @returns {Promise<Object|null>} Link encontrado o null
   */
  async findByProductAndMarketplace(
    productId,
    marketplaceId,
    companyId = null,
    branchId = null,
    credentialId = null,
    userId = null,
    externalId = null
  ) {
    const where = { product_id: productId, marketplace_id: marketplaceId };
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;
    if (credentialId) where.credential_id = credentialId;
    if (externalId) where.external_id = externalId;

    return await ProductMarketplaceLink.findOne({ where });
  },

  /**
   * Crea o actualiza un link de producto-marketplace
   * @param {Object} linkData - Datos del link
   * @param {Object} options - Opciones de Sequelize
   * @returns {Promise<Object>} Link creado/actualizado
   */
  async upsert(linkData, options = {}) {
    logger.info(`[REPO] Guardando link para producto ${linkData.product_id}`);
    try {
      // Validar contexto: el link debe quedar ligado a company o branch, pero no a ambos a la vez.
      const hasCompany = linkData.company_id != null;
      const hasBranch = linkData.branch_id != null;

      if ((hasCompany && hasBranch) || (!hasCompany && !hasBranch)) {
        throw new Error('Debe proporcionar company_id o branch_id');
      }

      const scopeWhere = this.buildScopeWhere(linkData);
      logger.info(`[REPO] Scope link marketplace=${linkData.marketplace_id} product=${linkData.product_id}: ${JSON.stringify(scopeWhere)}`);

      const existing = await ProductMarketplaceLink.findOne({
        where: scopeWhere,
        order: [['updatedAt', 'DESC'], ['id', 'DESC']]
      });

      if (existing) {
        const updateData = { ...linkData };
        if (updateData.user_id == null && existing.user_id != null) {
          updateData.user_id = existing.user_id;
        }
        await existing.update(updateData, options);
        logger.info(`[REPO] Link actualizado id=${existing.id} product=${linkData.product_id} marketplace=${linkData.marketplace_id}`);
        return existing;
      }

      const created = await ProductMarketplaceLink.create(linkData, options);
      logger.info(`[REPO] Link creado id=${created.id} product=${linkData.product_id} marketplace=${linkData.marketplace_id}`);
      return created;
    } catch (error) {
      logger.error(`[REPO] ERROR al guardar link:`, error.message);
      throw error;
    }
  },

  /**
   * Busca todos los links de un marketplace
   * @param {number} marketplaceId - ID del marketplace
   * @param {number|null} companyId - ID de la empresa (opcional)
   * @param {number|null} branchId - ID de la sucursal (opcional)
   * @param {number|null} credentialId - ID de la credencial (opcional, NUEVO)
   * @returns {Promise<Array>} Lista de links encontrados
   */
  async findByMarketplace(marketplaceId, companyId = null, branchId = null, credentialId = null, userId = null) {
    const where = { marketplace_id: marketplaceId };
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;
    if (credentialId) where.credential_id = credentialId;

    return await ProductMarketplaceLink.findAll({ where });
  },

  /**
   * Busca un link por external_id del marketplace
   * @param {number} marketplaceId - ID del marketplace
   * @param {string} externalId - External ID (listing_id) del marketplace
   * @param {number|null} companyId - ID de la empresa (opcional)
   * @param {number|null} branchId - ID de la sucursal (opcional)
   * @param {number|null} credentialId - ID de la credencial (opcional, NUEVO)
   * @returns {Promise<Object|null>} Link encontrado o null
   */
  async findByMarketplaceExternalId(marketplaceId, externalId, companyId = null, branchId = null, credentialId = null, userId = null) {
    const where = { marketplace_id: marketplaceId, external_id: externalId };
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;
    if (credentialId) where.credential_id = credentialId;
    return await ProductMarketplaceLink.findOne({ where });
  },

  /**
   * Busca todos los links de un producto
   * @param {number} productId - ID del producto
   * @param {number|null} companyId - ID de la empresa (opcional)
   * @param {number|null} branchId - ID de la sucursal (opcional)
   * @param {number|null} credentialId - ID de la credencial (opcional, NUEVO)
   * @returns {Promise<Array>} Lista de links encontrados
   */
  async findByProduct(productId, companyId = null, branchId = null, credentialId = null, userId = null) {
    const where = { product_id: productId };
    if (companyId) where.company_id = companyId;
    if (branchId) where.branch_id = branchId;
    if (credentialId) where.credential_id = credentialId;
    if (userId) where.user_id = userId;
    return await ProductMarketplaceLink.findAll({ where });
  },

  /**
   * ✅ NUEVO: Busca un link por external_id + credential_id específico
   * Útil cuando un producto está publicado en múltiples cuentas del mismo marketplace
   * @param {number} marketplaceId - ID del marketplace
   * @param {string} externalId - External ID (listing_id) del marketplace
   * @param {number} credentialId - ID de la credencial específica
   * @returns {Promise<Object|null>} Link encontrado o null
   */
  async findByExternalIdAndCredential(marketplaceId, externalId, credentialId, userId = null) {
    if (!marketplaceId || !externalId || !credentialId) {
      logger.warn(`[ProductMarketplaceLinkRepository] Parámetros inválidos para findByExternalIdAndCredential`);
      return null;
    }

    const where = {
      marketplace_id: marketplaceId,
      external_id: externalId,
      credential_id: credentialId
    };

    return await ProductMarketplaceLink.findOne({
      where,
      include: [
        {
          model: MarketplaceCredential,
          as: 'credential',
          attributes: ['id', 'name', 'seller_email', 'active']
        }
      ]
    });
  }
};

module.exports = ProductMarketplaceLinkRepository;
