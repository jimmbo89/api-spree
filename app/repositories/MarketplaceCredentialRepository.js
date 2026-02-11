// repositories/MarketplaceCredentialRepository.js
const { MarketplaceCredential, Marketplace, User } = require('../models');
const EncryptionService = require('../services/EncryptionService');
const logger = require('../../config/logger');
const { Op } = require('sequelize');

const MarketplaceCredentialRepository = {
  /**
   * Obtiene la credencial (token) de un usuario para un marketplace específico
   */
  /*async findByMarketplaceAndUser(marketplaceId, userId) {
  const record = await MarketplaceCredential.findOne({
    where: { marketplace_id: marketplaceId, user_id: userId },
    include: [
      {
        model: Marketplace,
        as: 'marketplace',
        required: true
      }
    ]
  });

  if (!record) return null;

  // Descifrar tokens del usuario
  let access_token = record.access_token;
  let refresh_token = record.refresh_token;
  if (access_token) access_token = EncryptionService.decrypt(access_token);
  if (refresh_token) refresh_token = EncryptionService.decrypt(refresh_token);

  // Descifrar credenciales OAuth del marketplace
  let client_secret = record.marketplace.client_secret;
  if (client_secret) client_secret = EncryptionService.decrypt(client_secret);

  // Construir objeto plano explícito (sin spread ni riesgo de colisión)
  const combined = {
    // Campos de MarketplaceCredential
    id: record.id,
    user_id: record.user_id,
    marketplace_id: record.marketplace_id,
    access_token,
    refresh_token,
    expires_at: record.expires_at,
    active: record.active,

    // Campos de Marketplace (credenciales OAuth)
    client_id: record.marketplace.client_id,
    client_secret,
    redirect_uri: record.marketplace.redirect_uri,
    scopes: record.marketplace.scopes,
    domain: record.marketplace.domain?.trim() || null,

    // (Opcional) otros campos de marketplace si los necesitas
    name: record.marketplace.name,
    type: record.marketplace.type,
    description: record.marketplace.description
  };

  return combined;
},*/

async findByMarketplaceAndUser(marketplaceId, userId) {
  // Buscar el marketplace + credencial del usuario (si existe)
  const marketplace = await Marketplace.findOne({
    where: { id: marketplaceId },
    include: [{
      model: MarketplaceCredential,
      as: 'credentials', // debe coincidir con la asociación Marketplace.hasMany(Credential)
      where: { user_id: userId },
      required: false // ← clave: LEFT JOIN
    }]
  });

  if (!marketplace) {
    return null; // marketplace no existe
  }

  // Extraer credencial (puede ser undefined)
  const credential = marketplace.credentials?.[0]; // hasMany → array

  // Descifrar client_secret del marketplace
  let client_secret = marketplace.client_secret;
  if (client_secret) {
    client_secret = EncryptionService.decrypt(client_secret);
  }

  // Descifrar tokens del usuario (si existen)
  let access_token = credential?.access_token;
  let refresh_token = credential?.refresh_token;
  let api_key = credential?.api_key;
  if (access_token) access_token = EncryptionService.decrypt(access_token);
  if (refresh_token) refresh_token = EncryptionService.decrypt(refresh_token);
  if (api_key) api_key = EncryptionService.decrypt(api_key);

  // Construir objeto plano
  const combined = {
    // Campos de MarketplaceCredential (pueden ser null)
    id: credential?.id || null,
    user_id: userId,
    marketplace_id: marketplace.id,
    access_token: access_token || null,
    refresh_token: refresh_token || null,
    expires_at: credential?.expires_at || null,
    active: credential?.active || false,
    seller_email: credential?.seller_email || null,
    seller_id: credential?.seller_id,
    api_key: api_key || null,
    additional_data: credential?.additional_data,

    // Campos de Marketplace (siempre presentes)
    client_id: marketplace.client_id,
    client_secret,
    redirect_uri: marketplace.redirect_uri,
    scopes: marketplace.scopes,
    domain: marketplace.domain?.trim() || null,
    name: marketplace.name,
    type: marketplace.type,
    description: marketplace.description
  };

  return combined;
},
  /**
   * Obtiene todas las credenciales de un usuario (opcionalmente filtradas por marketplace)
   */
  async findByUser(userId, marketplaceId = null) {
    const where = { user_id: userId };
    if (marketplaceId) where.marketplace_id = marketplaceId;

    const records = await MarketplaceCredential.findAll({
      where,
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    // No desciframos en listas (solo al usar tokens)
    return records.map(record => record.get({ plain: true }));
  },

      async countActiveByMarketplace (user_id, options = {}){
        const where = { user_id: user_id, ...options.where };
        return MarketplaceCredential.count({ where });
      },

  async findById(id) {
    const record = await MarketplaceCredential.findByPk(id);
    if (!record) return null;

    const plain = record.get({ plain: true });
    if (plain.access_token) plain.access_token = EncryptionService.decrypt(plain.access_token);
    if (plain.refresh_token) plain.refresh_token = EncryptionService.decrypt(plain.refresh_token);
    if (plain.api_key) plain.api_key = EncryptionService.decrypt(plain.api_key);
    return plain;
  },

  async findByDelete(id) {
    return await MarketplaceCredential.findByPk(id, {
    include: [
      {
        model: Marketplace, // Asegúrate de que el nombre del modelo sea correcto
        as: 'marketplace', // Usa el alias correcto definido en tu asociación
        attributes: ['name'] // Solo traemos lo necesario
      }
    ]
  });
  },

  /**
   * Crea o actualiza una credencial de token (por usuario + marketplace)
   */
  async createOrUpdate(credentialData, options = {}) {
    try {
      const { user_id, marketplace_id, seller_email, seller_id, api_key, additional_data } = credentialData;

      if (!user_id || !marketplace_id) {
        throw new Error('user_id y marketplace_id son obligatorios');
      }

      let existing = null;
      if (credentialData.id) {
        existing = await MarketplaceCredential.findByPk(credentialData.id);
        if (!existing) {
          throw new Error('credentialNotFound');
        }
      }

      // Verificar duplicado: (marketplace_id, user_id)
      const conflictWhere = {
        marketplace_id,
        user_id,
        id: { [Op.ne]: credentialData.id || null }
      };
      if (credentialData.id) conflictWhere.id = { [Op.ne]: credentialData.id };

      const conflict = await MarketplaceCredential.findOne({ where: conflictWhere });
      if (conflict) {
        throw new Error('Ya existe una credencial para este usuario y marketplace');
      }

      // Preparar datos para guardar
      const dataToSave = {
        marketplace_id,
        user_id,
        active: credentialData.active ?? (existing?.active ?? true),
        expires_at: credentialData.expires_at ?? existing?.expires_at,
        seller_email: credentialData.seller_email,
        seller_id: credentialData.seller_id,
        additional_data: credentialData.additional_data
      };

      // Solo actualizar tokens si se proporcionan explícitamente
      if (credentialData.access_token !== undefined) {
        dataToSave.access_token = credentialData.access_token
          ? EncryptionService.encrypt(credentialData.access_token)
          : null;
      }

      if (credentialData.refresh_token !== undefined) {
        dataToSave.refresh_token = credentialData.refresh_token
          ? EncryptionService.encrypt(credentialData.refresh_token)
          : null;
      }

      if (credentialData.api_key !== undefined) {
        dataToSave.api_key = credentialData.api_key
          ? EncryptionService.encrypt(credentialData.api_key)
          : null;
      }

      let record;
      if (credentialData.id) {
        await MarketplaceCredential.update(dataToSave, {
          where: { id: credentialData.id },
          ...options
        });
        record = await MarketplaceCredential.findByPk(credentialData.id);
      } else {
        record = await MarketplaceCredential.create(dataToSave, options);
      }

      return record.get({ plain: true });
    } catch (error) {
      logger.error(`[REPO] ERROR al guardar credenciales de token:`, error.message);
      throw error;
    }
  },

    async delete(record) {
    return await record.destroy();
  },
};

module.exports = MarketplaceCredentialRepository;