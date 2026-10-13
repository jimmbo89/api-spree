const { Op } = require('sequelize');
const { UserMarketplaceCredential, MarketplaceCredential, Marketplace, Company, User, UserCompany, ProductFieldMapping } = require('../models');
const EncryptionService = require('../services/EncryptionService');
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

function decryptMarketplaceCredential(record) {
  if (!record) return record;

  const plain = typeof record.get === 'function' ? record.get({ plain: true }) : { ...record };
  const credential = plain.marketplaceCredential || {};

  if (credential.access_token) {
    try {
      credential.access_token = EncryptionService.decrypt(credential.access_token);
    } catch (error) {
      credential.access_token = null;
    }
  }

  if (credential.refresh_token) {
    try {
      credential.refresh_token = EncryptionService.decrypt(credential.refresh_token);
    } catch (error) {
      credential.refresh_token = null;
    }
  }

  if (credential.api_key) {
    try {
      credential.api_key = EncryptionService.decrypt(credential.api_key);
    } catch (error) {
      credential.api_key = null;
    }
  }

  if (credential.marketplace?.client_secret) {
    try {
      credential.marketplace.client_secret = EncryptionService.decrypt(credential.marketplace.client_secret);
    } catch (error) {
      credential.marketplace.client_secret = null;
    }
  }

  plain.marketplaceCredential = credential;
  return plain;
}

const UserMarketplaceCredentialRepository = {
  async syncCredentialAccessUsers({ marketplaceCredentialId, companyId, userIds = [], transaction = null }) {
    const normalizedCredentialId = Number(marketplaceCredentialId);
    const normalizedCompanyId = Number(companyId);
    if (!Array.isArray(userIds)) {
      const error = new Error('access_user_ids debe ser un array');
      error.statusCode = 400;
      throw error;
    }

    const invalidUserIds = userIds.filter(id => {
      const normalizedId = Number(id);
      return !Number.isInteger(normalizedId) || normalizedId <= 0;
    });
    if (invalidUserIds.length > 0) {
      const error = new Error('access_user_ids contiene usuarios inválidos');
      error.statusCode = 400;
      throw error;
    }

    const normalizedUserIds = [...new Set(
      userIds.map(id => Number(id))
    )];

    if (!Number.isInteger(normalizedCredentialId) || normalizedCredentialId <= 0) {
      throw new Error('marketplaceCredentialId inválido para sincronizar accesos');
    }
    if (!Number.isInteger(normalizedCompanyId) || normalizedCompanyId <= 0) {
      throw new Error('companyId inválido para sincronizar accesos');
    }

    const credential = await MarketplaceCredential.findOne({
      where: {
        id: normalizedCredentialId,
        company_id: normalizedCompanyId
      },
      attributes: ['id'],
      transaction
    });

    if (!credential) {
      const error = new Error('La credencial no pertenece a la empresa indicada');
      error.statusCode = 400;
      throw error;
    }

    if (normalizedUserIds.length > 0) {
      const activeMemberships = await UserCompany.findAll({
        where: {
          company_id: normalizedCompanyId,
          status: 1,
          user_id: { [Op.in]: normalizedUserIds }
        },
        attributes: ['user_id'],
        include: [{
          model: User,
          as: 'user',
          required: true,
          where: { status: true },
          attributes: ['id']
        }],
        transaction
      });

      const validUserIds = new Set(activeMemberships.map(record => Number(record.user_id)));
      const invalidUserIds = normalizedUserIds.filter(userId => !validUserIds.has(userId));
      if (invalidUserIds.length > 0) {
        const error = new Error(
          `Los usuarios ${invalidUserIds.join(', ')} no pertenecen a la empresa o no están activos`
        );
        error.statusCode = 400;
        throw error;
      }
    }

    const existing = await UserMarketplaceCredential.findAll({
      where: {
        company_id: normalizedCompanyId,
        marketplace_credential_id: normalizedCredentialId
      },
      transaction
    });
    const existingByUserId = new Map(existing.map(record => [Number(record.user_id), record]));
    const requestedUserIds = new Set(normalizedUserIds);

    for (const userId of normalizedUserIds) {
      const existingRecord = existingByUserId.get(userId);
      if (existingRecord) {
        if (Number(existingRecord.status) !== 1) {
          await existingRecord.update({ status: 1 }, { transaction });
        }
      } else {
        await UserMarketplaceCredential.create({
          user_id: userId,
          company_id: normalizedCompanyId,
          marketplace_credential_id: normalizedCredentialId,
          status: 1
        }, { transaction });
      }
    }

    for (const existingRecord of existing) {
      if (!requestedUserIds.has(Number(existingRecord.user_id))) {
        await existingRecord.destroy({ transaction });
      }
    }

    return normalizedUserIds;
  },

  async findActiveUsersByCredentialIds(credentialIds = [], companyId, transaction = null) {
    const normalizedCredentialIds = [...new Set(
      (Array.isArray(credentialIds) ? credentialIds : [])
        .map(id => Number(id))
        .filter(id => Number.isInteger(id) && id > 0)
    )];

    const usersByCredentialId = new Map();
    if (normalizedCredentialIds.length === 0) return usersByCredentialId;

    const where = {
      marketplace_credential_id: { [Op.in]: normalizedCredentialIds },
      status: 1
    };

    if (companyId !== null && companyId !== undefined) {
      where.company_id = companyId;
    }

    const records = await UserMarketplaceCredential.findAll({
      where,
      attributes: ['marketplace_credential_id'],
      include: [
        {
          model: User,
          as: 'user',
          required: true,
          attributes: ['id', 'name', 'email', 'image']
        }
      ],
      order: [['createdAt', 'ASC']],
      transaction
    });

    for (const record of records) {
      const plain = record.get({ plain: true });
      const credentialId = Number(plain.marketplace_credential_id);
      const user = plain.user;
      if (!user || !Number.isInteger(credentialId)) continue;

      if (!usersByCredentialId.has(credentialId)) {
        usersByCredentialId.set(credentialId, []);
      }

      usersByCredentialId.get(credentialId).push({
        id: Number(user.id),
        name: user.name,
        email: user.email,
        image: user.image || null
      });
    }

    return usersByCredentialId;
  },

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
      const plain = decryptMarketplaceCredential(record);
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

  async hasActiveAccess({ userId, marketplaceCredentialId, companyId = null, transaction = null } = {}) {
    const normalizedUserId = Number(userId);
    const normalizedCredentialId = Number(marketplaceCredentialId);

    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return false;
    if (!Number.isInteger(normalizedCredentialId) || normalizedCredentialId <= 0) return false;

    const where = {
      user_id: normalizedUserId,
      marketplace_credential_id: normalizedCredentialId,
      status: 1
    };

    if (companyId !== null && companyId !== undefined && companyId !== '') {
      const normalizedCompanyId = Number(companyId);
      if (!Number.isInteger(normalizedCompanyId) || normalizedCompanyId <= 0) return false;
      where.company_id = normalizedCompanyId;
    }

    const access = await UserMarketplaceCredential.findOne({
      where,
      attributes: ['id'],
      raw: true,
      transaction
    });

    return Boolean(access);
  },

  async hasAnyActiveAccess({ marketplaceCredentialId, companyId, transaction = null } = {}) {
    const normalizedCredentialId = Number(marketplaceCredentialId);
    const normalizedCompanyId = Number(companyId);

    if (!Number.isInteger(normalizedCredentialId) || normalizedCredentialId <= 0) return false;
    if (!Number.isInteger(normalizedCompanyId) || normalizedCompanyId <= 0) return false;

    const access = await UserMarketplaceCredential.findOne({
      where: {
        marketplace_credential_id: normalizedCredentialId,
        company_id: normalizedCompanyId,
        status: 1
      },
      attributes: ['id'],
      raw: true,
      transaction
    });

    return Boolean(access);
  },

  async ensureActiveAccessIfNone({ userId, companyId, marketplaceCredentialId, transaction = null }) {
    const hasAccess = await this.hasAnyActiveAccess({
      marketplaceCredentialId,
      companyId,
      transaction
    });

    if (hasAccess) return null;

    return this.ensureActiveAccess({
      userId,
      companyId,
      marketplaceCredentialId,
      transaction
    });
  },

  async findActiveCredentialIdByMarketplace({ userId, marketplaceId, companyId = null, transaction = null } = {}) {
    const normalizedUserId = Number(userId);
    const normalizedMarketplaceId = Number(marketplaceId);

    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) return null;
    if (!Number.isInteger(normalizedMarketplaceId) || normalizedMarketplaceId <= 0) return null;

    const where = {
      user_id: normalizedUserId,
      status: 1
    };

    if (companyId !== null && companyId !== undefined && companyId !== '') {
      const normalizedCompanyId = Number(companyId);
      if (!Number.isInteger(normalizedCompanyId) || normalizedCompanyId <= 0) return null;
      where.company_id = normalizedCompanyId;
    }

    const access = await UserMarketplaceCredential.findOne({
      where,
      attributes: ['marketplace_credential_id'],
      include: [{
        model: MarketplaceCredential,
        as: 'marketplaceCredential',
        attributes: [],
        required: true,
        where: {
          marketplace_id: normalizedMarketplaceId,
          active: true
        }
      }],
      order: [['createdAt', 'DESC']],
      transaction
    });

    return access ? Number(access.marketplace_credential_id) : null;
  },

  async ensureActiveAccess({ userId, companyId, marketplaceCredentialId, transaction = null }) {
    const normalizedUserId = Number(userId);
    const normalizedCompanyId = Number(companyId);
    const normalizedCredentialId = Number(marketplaceCredentialId);

    if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0) {
      throw new Error('userId inválido para asociar credencial de marketplace');
    }
    if (!Number.isInteger(normalizedCompanyId) || normalizedCompanyId <= 0) {
      throw new Error('companyId inválido para asociar credencial de marketplace');
    }
    if (!Number.isInteger(normalizedCredentialId) || normalizedCredentialId <= 0) {
      throw new Error('marketplaceCredentialId inválido para asociar credencial de marketplace');
    }

    const credential = await MarketplaceCredential.findOne({
      where: {
        id: normalizedCredentialId,
        company_id: normalizedCompanyId
      },
      attributes: ['id'],
      transaction
    });

    if (!credential) {
      throw new Error('La credencial no pertenece a la empresa indicada');
    }

    const [access, created] = await UserMarketplaceCredential.findOrCreate({
      where: {
        user_id: normalizedUserId,
        company_id: normalizedCompanyId,
        marketplace_credential_id: normalizedCredentialId
      },
      defaults: { status: 1 },
      transaction
    });

    if (!created && Number(access.status) !== 1) {
      await access.update({ status: 1 }, { transaction });
    }

    logger.info(
      `[UserMarketplaceCredentialRepository] Acceso activo garantizado user=${normalizedUserId}, company=${normalizedCompanyId}, credential=${normalizedCredentialId}`
    );

    return access;
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
