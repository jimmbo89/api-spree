const { Op } = require('sequelize');
const { UserMarketplaceCredential, MarketplaceCredential, Marketplace, Company, User, ProductFieldMapping } = require('../models');
const logger = require('../../config/logger');

function normalizeCredentialItems(items = []) {
  if (!Array.isArray(items)) return [];

  const normalized = [];
  for (const item of items) {
    let marketplace_credential_id = null;
    let status = 1;

    if (typeof item === 'number' || typeof item === 'string') {
      marketplace_credential_id = Number(item);
    } else if (item && typeof item === 'object') {
      marketplace_credential_id = Number(
        item.marketplace_credential_id ??
        item.credential_id ??
        item.id
      );

      if (item.status !== undefined && item.status !== null && item.status !== '') {
        status = Number(item.status);
      }
    }

    if (!Number.isInteger(marketplace_credential_id) || marketplace_credential_id <= 0) {
      throw new Error('marketplace_credentials contiene un ID inválido');
    }

    if (!Number.isInteger(status) || ![0, 1].includes(status)) {
      throw new Error('marketplace_credentials.status debe ser 0 o 1');
    }

    normalized.push({ marketplace_credential_id, status });
  }

  const map = new Map();
  normalized.forEach((item) => {
    map.set(item.marketplace_credential_id, item);
  });

  return Array.from(map.values());
}

const UserMarketplaceCredentialRepository = {
  async findByUserAndCompany(userId, companyId, transaction = null) {
    const records = await UserMarketplaceCredential.findAll({
      where: {
        user_id: userId,
        company_id: companyId
      },
      include: [
        {
          model: MarketplaceCredential,
          as: 'marketplaceCredential',
          include: [
            {
              model: Marketplace,
              as: 'marketplace',
              include: [
                {
                  model: ProductFieldMapping,
                  as: 'fieldMappings',
                  attributes: ['id', 'internal_field', 'external_field', 'required', 'data_type', 'direction', 'default_value', 'validation_rules']
                }
              ]
            },
            { model: Company, as: 'company', attributes: ['id', 'name'] },
            { model: User, as: 'user', attributes: ['id', 'name', 'email', 'image'] }
          ]
        },
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'image'] },
        { model: Company, as: 'company', attributes: ['id', 'name'] }
      ],
      order: [['createdAt', 'DESC']],
      transaction
    });

    return records.map(record => record.get({ plain: true }));
  },

  async findActiveCredentialsByUserAndCompany(userId, companyId, transaction = null) {
    const records = await UserMarketplaceCredential.findAll({
      where: {
        user_id: userId,
        company_id: companyId,
        status: 1
      },
      include: [
        {
          model: MarketplaceCredential,
          as: 'marketplaceCredential',
          where: { active: true },
          required: true,
          include: [
            {
              model: Marketplace,
              as: 'marketplace',
              include: [
                {
                  model: ProductFieldMapping,
                  as: 'fieldMappings',
                  attributes: ['id', 'internal_field', 'external_field', 'required', 'data_type', 'direction', 'default_value', 'validation_rules']
                }
              ]
            },
            { model: Company, as: 'company', attributes: ['id', 'name'] },
            { model: User, as: 'user', attributes: ['id', 'name', 'email', 'image'] }
          ]
        },
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'image'] },
        { model: Company, as: 'company', attributes: ['id', 'name'] }
      ],
      order: [['createdAt', 'DESC']],
      transaction
    });

    return records.map((record) => {
      const plain = record.get({ plain: true });
      const credential = plain.marketplaceCredential || {};
      return {
        ...credential,
        user_id: plain.user_id,
        company_id: plain.company_id,
        relation_id: plain.id,
        relation_status: plain.status,
        marketplace: credential.marketplace || null,
        company: credential.company || plain.company || null,
        user: credential.user || plain.user || null
      };
    });
  },

  async syncUserMarketplaceCredentials({ userId, companyId, items = [], transaction = null }) {
    const normalizedItems = normalizeCredentialItems(items);
    const incomingIds = normalizedItems.map(item => item.marketplace_credential_id);

    const validCredentials = incomingIds.length > 0
      ? await MarketplaceCredential.findAll({
          where: {
            id: { [Op.in]: incomingIds },
            company_id: companyId
          },
          attributes: ['id', 'company_id'],
          transaction
        })
      : [];

    const validIdSet = new Set(validCredentials.map(cred => Number(cred.id)));
    const invalidIds = incomingIds.filter(id => !validIdSet.has(Number(id)));

    if (invalidIds.length > 0) {
      throw new Error(`Las credenciales ${invalidIds.join(', ')} no pertenecen a la empresa indicada o no existen`);
    }

    const existing = await UserMarketplaceCredential.findAll({
      where: {
        user_id: userId,
        company_id: companyId
      },
      transaction
    });

    const existingMap = new Map(existing.map(record => [Number(record.marketplace_credential_id), record]));
    const incomingMap = new Map(normalizedItems.map(item => [Number(item.marketplace_credential_id), item]));

    for (const item of normalizedItems) {
      const existingRecord = existingMap.get(Number(item.marketplace_credential_id));
      if (existingRecord) {
        if (Number(existingRecord.status) !== Number(item.status)) {
          await existingRecord.update({ status: item.status }, { transaction });
        }
      } else {
        await UserMarketplaceCredential.create({
          user_id: userId,
          company_id: companyId,
          marketplace_credential_id: item.marketplace_credential_id,
          status: item.status ?? 1
        }, { transaction });
      }
    }

    for (const record of existing) {
      if (!incomingMap.has(Number(record.marketplace_credential_id))) {
        await record.destroy({ transaction });
      }
    }

    const updated = await UserMarketplaceCredential.findAll({
      where: {
        user_id: userId,
        company_id: companyId
      },
      include: [
        {
          model: MarketplaceCredential,
          as: 'marketplaceCredential',
          include: [
            { model: Marketplace, as: 'marketplace' },
            { model: Company, as: 'company', attributes: ['id', 'name'] },
            { model: User, as: 'user', attributes: ['id', 'name', 'email', 'image'] }
          ]
        },
        { model: User, as: 'user', attributes: ['id', 'name', 'email', 'image'] },
        { model: Company, as: 'company', attributes: ['id', 'name'] }
      ],
      order: [['createdAt', 'ASC']],
      transaction
    });

    logger.info(`[UserMarketplaceCredentialRepository] Sincronizadas ${updated.length} relaciones para user=${userId}, company=${companyId}`);
    return updated.map(record => record.get({ plain: true }));
  }
};

module.exports = UserMarketplaceCredentialRepository;
