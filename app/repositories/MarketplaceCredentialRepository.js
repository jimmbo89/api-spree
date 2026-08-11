// repositories/MarketplaceCredentialRepository.js
const {
  MarketplaceCredential,
  Marketplace,
  Company,
  User,
  ProductFieldMapping,
  UserMarketplaceCredential,
  ProductPublishingTask,
  ProductMarketplaceLink,
  JobProduct,
  MarketplaceOrder,
  MarketplaceWebhookEvent
} = require('../models');
const EncryptionService = require('../services/EncryptionService');
const logger = require('../../config/logger');
const { Op } = require('sequelize');

function decryptCredentialRecord(record) {
  if (!record) return record;

  const plain = typeof record.get === 'function' ? record.get({ plain: true }) : { ...record };

  if (plain.access_token) {
    try {
      plain.access_token = EncryptionService.decrypt(plain.access_token);
    } catch (error) {
      plain.access_token = null;
    }
  }

  if (plain.refresh_token) {
    try {
      plain.refresh_token = EncryptionService.decrypt(plain.refresh_token);
    } catch (error) {
      plain.refresh_token = null;
    }
  }

  if (plain.api_key) {
    try {
      plain.api_key = EncryptionService.decrypt(plain.api_key);
    } catch (error) {
      plain.api_key = null;
    }
  }

  if (plain.marketplace?.client_secret) {
    try {
      plain.marketplace.client_secret = EncryptionService.decrypt(plain.marketplace.client_secret);
    } catch (error) {
      plain.marketplace.client_secret = null;
    }
  }

  return plain;
}

async function getAccessibleCredentialIdsByUser(userId, companyId = null) {
  const where = {
    user_id: userId,
    status: 1
  };

  if (companyId != null) {
    where.company_id = companyId;
  }

  const records = await UserMarketplaceCredential.findAll({
    where,
    attributes: ['marketplace_credential_id'],
    raw: true
  });

  return records
    .map(record => Number(record.marketplace_credential_id))
    .filter(id => Number.isInteger(id) && id > 0);
}

function dedupeById(records) {
  const map = new Map();
  for (const record of records) {
    if (!record) continue;
    const id = Number(record.id);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (!map.has(id)) {
      map.set(id, record);
    }
  }
  return Array.from(map.values());
}

function normalizeAdditionalData(additionalData) {
  if (!additionalData) return {};

  let normalized = additionalData;
  if (typeof normalized === 'string') {
    try {
      normalized = JSON.parse(normalized) || {};
    } catch (error) {
      return {};
    }
  }

  if (typeof normalized !== 'object' || Array.isArray(normalized)) {
    return {};
  }

  const entries = Object.entries(normalized);
  const numericEntries = entries
    .filter(([key]) => /^\d+$/.test(String(key)))
    .sort(([a], [b]) => Number(a) - Number(b));
  let parsedNumericPayload = {};

  if (numericEntries.length > 0) {
    const rawPayload = numericEntries.map(([, value]) => String(value)).join('');
    try {
      const parsed = JSON.parse(rawPayload);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        parsedNumericPayload = parsed;
      }
    } catch (error) {
      parsedNumericPayload = {};
    }
  }

  return entries.reduce((acc, [key, value]) => {
    if (!/^\d+$/.test(String(key))) {
      acc[key] = value;
    }
    return acc;
  }, { ...parsedNumericPayload });
}

function getMlUserIdFromAdditionalData(additionalData) {
  const normalized = normalizeAdditionalData(additionalData);
  return normalized.ml_user_id != null ? String(normalized.ml_user_id) : null;
}

function isInactiveCredential(credential) {
  return credential?.active === false || Number(credential?.active) === 0;
}

const MarketplaceCredentialRepository = {
  /**
   * Obtiene la credencial (token) de un usuario para un marketplace específico
   */
  async findByMarketplaceAndCompany(marketplaceId, companyId, name = null) {
    const where = {
      marketplace_id: marketplaceId,
      company_id: companyId
    };

    if (name) {
      where.name = name;
    }

    const marketplace = await Marketplace.findOne({
      where: { id: marketplaceId },
      include: [{
        model: MarketplaceCredential,
        as: 'credentials',
        where,
        required: false
      }]
    });

    if (!marketplace) {
      return null;
    }

    const credential = marketplace.credentials?.[0];

    let client_secret = marketplace.client_secret;
    if (client_secret) {
      client_secret = EncryptionService.decrypt(client_secret);
    }

    let access_token = credential?.access_token;
    let refresh_token = credential?.refresh_token;
    let api_key = credential?.api_key;
    if (access_token) access_token = EncryptionService.decrypt(access_token);
    if (refresh_token) refresh_token = EncryptionService.decrypt(refresh_token);
    if (api_key) api_key = EncryptionService.decrypt(api_key);

    return {
      id: credential?.id || null,
      company_id: companyId,
      user_id: credential?.user_id || null,
      marketplace_id: marketplace.id,
      name: credential?.name || null,
      country: credential?.country || null,
      access_token: access_token || null,
      refresh_token: refresh_token || null,
      expires_at: credential?.expires_at || null,
      active: credential?.active || false,
      seller_email: credential?.seller_email || null,
      seller_id: credential?.seller_id,
      api_key: api_key || null,
      additional_data: credential?.additional_data,
      client_id: marketplace.client_id,
      client_secret,
      redirect_uri: marketplace.redirect_uri,
      scopes: marketplace.scopes,
      domain: marketplace.domain?.trim() || null,
      marketplace_name: marketplace.name,
      type: marketplace.type,
      description: marketplace.description
    };
  },

  async findByMarketplaceAndUser(marketplaceId, userId, name = null) {
    const where = {
      marketplace_id: marketplaceId,
      user_id: userId
    };

    if (name) {
      where.name = name;
    }

    const marketplace = await Marketplace.findOne({
      where: { id: marketplaceId },
      include: [{
        model: MarketplaceCredential,
        as: 'credentials',
        where,
        required: false
      }]
    });

    if (!marketplace) {
      return null;
    }

    const credential = marketplace.credentials?.[0];

    let client_secret = marketplace.client_secret;
    if (client_secret) {
      client_secret = EncryptionService.decrypt(client_secret);
    }

    let access_token = credential?.access_token;
    let refresh_token = credential?.refresh_token;
    let api_key = credential?.api_key;
    if (access_token) access_token = EncryptionService.decrypt(access_token);
    if (refresh_token) refresh_token = EncryptionService.decrypt(refresh_token);
    if (api_key) api_key = EncryptionService.decrypt(api_key);

    const combined = {
      id: credential?.id || null,
      user_id: userId,
      marketplace_id: marketplace.id,
      name: credential?.name || null,
      country: credential?.country || null,
      access_token: access_token || null,
      refresh_token: refresh_token || null,
      expires_at: credential?.expires_at || null,
      active: credential?.active || false,
      seller_email: credential?.seller_email || null,
      seller_id: credential?.seller_id,
      api_key: api_key || null,
      additional_data: credential?.additional_data,
      client_id: marketplace.client_id,
      client_secret,
      redirect_uri: marketplace.redirect_uri,
      scopes: marketplace.scopes,
      domain: marketplace.domain?.trim() || null,
      marketplace_name: marketplace.name,
      type: marketplace.type,
      description: marketplace.description
    };

    return combined;
  },

  /**
   * Obtiene credenciales filtradas por usuario; si no se pasa userId devuelve todas.
   */
  async findByUser(userId, marketplaceId = null, companyId = null) {
    const directWhere = {};
    if (userId) directWhere.user_id = userId;
    if (marketplaceId) directWhere.marketplace_id = marketplaceId;
    if (companyId) directWhere.company_id = companyId;

    const accessibleIds = await getAccessibleCredentialIdsByUser(userId, companyId);

    const directRecords = await MarketplaceCredential.findAll({
      where: directWhere,
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
        },
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name']
        },
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email', 'image']
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    const accessWhere = {
      id: { [Op.in]: accessibleIds.length > 0 ? accessibleIds : [0] }
    };
    if (marketplaceId) accessWhere.marketplace_id = marketplaceId;
    if (companyId) accessWhere.company_id = companyId;

    const accessRecords = accessibleIds.length > 0
      ? await MarketplaceCredential.findAll({
          where: accessWhere,
          include: [
            {
              model: Marketplace,
              as: 'marketplace',
            },
            {
              model: Company,
              as: 'company',
              attributes: ['id', 'name']
            },
            {
              model: User,
              as: 'user',
              attributes: ['id', 'name', 'email', 'image']
            }
          ],
          order: [['createdAt', 'DESC']]
        })
      : [];

    const merged = dedupeById([
      ...directRecords.map(record => record.get({ plain: true })),
      ...accessRecords.map(record => record.get({ plain: true }))
    ]);

    return merged;
  },

  async findByUsers(userIds = [], marketplaceId = null) {
    const ids = Array.isArray(userIds)
      ? userIds.map(id => Number(id)).filter(id => Number.isInteger(id) && id > 0)
      : [];

    if (ids.length === 0) {
      return [];
    }

    const where = {
      user_id: { [Op.in]: ids }
    };

    if (marketplaceId) where.marketplace_id = marketplaceId;

    const records = await MarketplaceCredential.findAll({
      where,
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
        },
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name']
        },
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email', 'image']
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    return records.map(record => decryptCredentialRecord(record));
  },

  async findByCompany(companyId, marketplaceId = null) {
    const where = {};
    if (companyId) where.company_id = companyId;
    if (marketplaceId) where.marketplace_id = marketplaceId;

    const records = await MarketplaceCredential.findAll({
      where,
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
        },
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name']
        },
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email', 'image']
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    return records.map(record => decryptCredentialRecord(record));
  },

  /**
 * Obtiene todas las credenciales de un usuario (opcionalmente filtradas por marketplace)
 * ✅ CAMBIO: Devuelve credenciales con campos sensibles decifrados
 */
async findByUserDecifrado(userId, marketplaceId = null, companyId = null) {
  const directWhere = { user_id: userId };
  if (marketplaceId) directWhere.marketplace_id = marketplaceId;
  if (companyId) directWhere.company_id = companyId;

  const accessibleIds = await getAccessibleCredentialIdsByUser(userId, companyId);

  const records = await MarketplaceCredential.findAll({
    where: {
      [Op.or]: [
        directWhere,
        ...(accessibleIds.length > 0 ? [{
          id: { [Op.in]: accessibleIds },
          ...(marketplaceId ? { marketplace_id: marketplaceId } : {}),
          ...(companyId ? { company_id: companyId } : {})
        }] : [])
      ]
    },
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
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'name']
      }
    ],
    order: [['createdAt', 'DESC']]
  });

  // ✅ Transformar cada registro decifrando campos sensibles
  return records.map(record => {
    const credential = record.get({ plain: true });
    const mp = credential.marketplace || {};
    const fieldMappings = mp.fieldMappings || [];

    // === 🔐 DECIFRAR CAMPOS DEL MARKETPLACE ===
    let mp_client_secret = mp.client_secret;
    if (mp_client_secret) {
      try {
        mp_client_secret = EncryptionService.decrypt(mp_client_secret);
      } catch (err) {
        console.warn(`[findByUser] Error al decifrar marketplace.client_secret: ${err.message}`);
        mp_client_secret = null;
      }
    }

    // === 🔐 DECIFRAR CAMPOS DE LA CREDENCIAL ===
    let access_token = credential.access_token;
    let refresh_token = credential.refresh_token;
    let api_key = credential.api_key;

    if (access_token) {
      try {
        access_token = EncryptionService.decrypt(access_token);
      } catch (err) {
        console.warn(`[findByUser] Error al decifrar access_token: ${err.message}`);
        access_token = null;
      }
    }
    if (refresh_token) {
      try {
        refresh_token = EncryptionService.decrypt(refresh_token);
      } catch (err) {
        console.warn(`[findByUser] Error al decifrar refresh_token: ${err.message}`);
        refresh_token = null;
      }
    }
    if (api_key) {
      try {
        api_key = EncryptionService.decrypt(api_key);
      } catch (err) {
        console.warn(`[findByUser] Error al decifrar api_key: ${err.message}`);
        api_key = null;
      }
    }

    // ✅ Retornar objeto combinado CON AMBOS OBJETOS DECIFRADOS
    return {
      // Campos de la credencial (decifrados)
      id: credential.id || null,
      user_id: credential.user_id || userId,
      company_id: credential.company_id || null,
      marketplace_id: mp.id || null,
      name: credential.name || null,
      country: credential.country || null,
      access_token: access_token || null,
      refresh_token: refresh_token || null,
      expires_at: credential.expires_at || null,
      active: credential.active || false,
      seller_email: credential.seller_email || null,
      seller_id: credential.seller_id,
      api_key: api_key || null,
      additional_data: credential.additional_data,
      
      // Campos del marketplace (decifrados) ← ✅ ESTO FALTABA
      client_id: mp.client_id,
      client_secret: mp_client_secret || null,  // ✅ Decifrado
      redirect_uri: mp.redirect_uri,
      scopes: mp.scopes,
      domain: mp.domain?.trim() || null,
      marketplace_name: mp.name,
      type: mp.type,
      description: mp.description,
      config: mp.config,
      active: mp.active,
      createdAt: mp.createdAt,
      updatedAt: mp.updatedAt,
      
      // Mantener el include del marketplace para compatibilidad
      marketplace: {
        ...mp,
        client_secret: mp_client_secret || null  // ✅ Asegurar que también esté decifrado aquí
      },
      company: credential.company || null,
      fieldMappings
    };
  });
},

  async findByUserObject(userId, marketplaceId = null) {
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

    return records;
  },

  /**
 * Elimina una credencial por ID
 * @param {number} id - ID de la credencial a eliminar
 * @returns {Promise<object>} - Resultado de la eliminación
 */
async deleteById(id) {
  try {
    const credential = await MarketplaceCredential.findByPk(id);
    
    if (!credential) {
      throw new Error(`Credencial con ID ${id} no encontrada`);
    }
    
    await credential.destroy();
    
    logger.info(`[REPO] Credencial eliminada (ID: ${id})`);
    
    return { 
      success: true, 
      message: "Credencial eliminada correctamente",
      id: id
    };
  } catch (error) {
    logger.error(`[REPO] ERROR al eliminar credencial (ID: ${id}):`, error.message);
    throw error;
  }
},

  async countActiveByMarketplace(company_id, options = {}) {
    const where = { company_id: company_id, ...options.where };
    return MarketplaceCredential.count({ where });
  },

  async findById(id) {
  // Buscamos el registro por PK e incluimos la relación 'marketplace'
  const record = await MarketplaceCredential.findByPk(id, {
    include: [
      {
        model: Marketplace,
        as: 'marketplace',
      },
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'name']
      },
      {
        model: User,
        as: 'user',
        attributes: ['id', 'name', 'email', 'image']
      }
    ]
  });

  if (!record) return null;

  // Obtenemos los datos planos (objeto simple)
  const plain = record.get({ plain: true });

  // Desencriptamos los campos sensibles de la CREDENCIAL si existen
  if (plain.access_token) plain.access_token = EncryptionService.decrypt(plain.access_token);
  if (plain.refresh_token) plain.refresh_token = EncryptionService.decrypt(plain.refresh_token);
  if (plain.api_key) plain.api_key = EncryptionService.decrypt(plain.api_key);

  // ✅ NUEVO: Desencriptar client_secret del MARKETPLACE si existe
  if (plain.marketplace?.client_secret) {
    plain.marketplace.client_secret = EncryptionService.decrypt(plain.marketplace.client_secret);
  }

  return plain;
},

  /**
   * Obtiene múltiples credenciales por sus IDs
   * @param {Array} ids - Array de IDs de credenciales
   * @returns {Array} Lista de credenciales encontradas
   */
  async findByIds(ids) {
    if (!Array.isArray(ids) || ids.length === 0) {
      return [];
    }

    const records = await MarketplaceCredential.findAll({
      where: {
        id: { [Op.in]: ids }
      },
      include: [
        {
          model: Marketplace,
          as: 'marketplace'
        }
      ]
    });

    return records.map(record => {
      const plain = record.get({ plain: true });
      
      // Desencriptar campos sensibles
      if (plain.access_token) plain.access_token = EncryptionService.decrypt(plain.access_token);
      if (plain.refresh_token) plain.refresh_token = EncryptionService.decrypt(plain.refresh_token);
      if (plain.api_key) plain.api_key = EncryptionService.decrypt(plain.api_key);
      if (plain.marketplace?.client_secret) {
        plain.marketplace.client_secret = EncryptionService.decrypt(plain.marketplace.client_secret);
      }
      
      return plain;
    });
  },

  async findByDelete(id) {
    return await MarketplaceCredential.findByPk(id, {
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
          attributes: ['name']
        },
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name']
        },
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email', 'image']
        }
      ]
    });
  },

  async getHistoryUsageById(id) {
    const credential = await MarketplaceCredential.findByPk(id);
    if (!credential) {
      throw new Error('credentialNotFound');
    }

    const plain = credential.get({ plain: true });
    const mlUserId = getMlUserIdFromAdditionalData(plain.additional_data);

    const [
      publications,
      publishingTasks,
      jobProducts,
      orders,
      webhooks
    ] = await Promise.all([
      ProductMarketplaceLink.count({ where: { credential_id: id } }),
      ProductPublishingTask.count({ where: { credential_id: id } }),
      JobProduct.count({ where: { credential_id: id } }),
      MarketplaceOrder.count({ where: { marketplace_credential_id: id } }),
      mlUserId
        ? MarketplaceWebhookEvent.count({ where: { marketplace_user_id: mlUserId } })
        : Promise.resolve(0)
    ]);

    const usage = {
      publications,
      publishingTasks,
      jobProducts,
      orders,
      webhooks
    };

    return {
      ...usage,
      hasHistory: Object.values(usage).some((count) => Number(count) > 0)
    };
  },

  async disconnectPreservingHistory(id, data = {}) {
    const existing = await MarketplaceCredential.findByPk(id);
    if (!existing) {
      throw new Error('credentialNotFound');
    }

    const additionalData = normalizeAdditionalData(existing.additional_data);
    await existing.update({
      active: false,
      additional_data: {
        ...additionalData,
        original_name: additionalData.original_name || existing.name,
        connection_status: 'disconnected',
        disconnected_at: data.disconnected_at || new Date().toISOString(),
        disconnected_reason: data.reason || 'user_requested'
      }
    });

    return existing.get({ plain: true });
  },

  /**
   * Crea o actualiza una credencial de token (por usuario + marketplace + name)
   */
  async createOrUpdate(credentialData, options = {}) {
    try {
      const { 
        id, 
        user_id, 
        company_id,
        marketplace_id, 
        name, 
        country,
        access_token, 
        refresh_token, 
        api_key,
        seller_email, 
        seller_id, 
        additional_data,
        active,
        expires_at 
      } = credentialData;

      if (!user_id || !company_id || !marketplace_id) {
        throw new Error('user_id, company_id y marketplace_id son obligatorios');
      }

      // Name por defecto si no se proporciona
      const credentialName = name?.trim() || null;

      // Verificar duplicado: (marketplace_id, company_id, name)
      const conflictWhere = {
        marketplace_id,
        company_id,
        name: credentialName,
        active: true
      };

      if (id) {
        conflictWhere.id = { [Op.ne]: id };
      }

      const conflict = await MarketplaceCredential.findOne({ where: conflictWhere });
      if (conflict) {
        throw new Error('Ya existe una credencial con este nombre para este usuario y marketplace');
      }

      const dataToSave = {
        marketplace_id,
        user_id,
        company_id,
        name: credentialName,
        country: country || null,
        active: active ?? true,
        expires_at: expires_at || null,
        seller_email: seller_email || null,
        seller_id: seller_id || null,
        additional_data: additional_data ? normalizeAdditionalData(additional_data) : null
      };

      if (access_token !== undefined) {
        dataToSave.access_token = access_token
          ? EncryptionService.encrypt(access_token)
          : null;
      }

      if (refresh_token !== undefined) {
        dataToSave.refresh_token = refresh_token
          ? EncryptionService.encrypt(refresh_token)
          : null;
      }

      if (api_key !== undefined) {
        dataToSave.api_key = api_key
          ? EncryptionService.encrypt(api_key)
          : null;
      }

      let record;
      if (id) {
        await MarketplaceCredential.update(dataToSave, {
          where: { id },
          ...options
        });
        record = await MarketplaceCredential.findByPk(id);
      } else {
        record = await MarketplaceCredential.create(dataToSave, options);
      }

      return record.get({ plain: true });
    } catch (error) {
      logger.error(`[REPO] ERROR al guardar credenciales de token:`, error.message);
      throw error;
    }
  },

    /**
   * Actualiza SOLO los campos enviados (partial update)
   * @param {number} id - ID de la credencial a actualizar
   * @param {object} data - Campos a actualizar (solo los que se envían)
   * @returns {Promise<object>} - Registro actualizado en plano
   */
  async updatePartial(id, data) {
    try {
      // 1. Verificar que el registro existe
      const existing = await MarketplaceCredential.findByPk(id);
      if (!existing) {
        throw new Error('credentialNotFound');
      }

      // 2. Construir objeto solo con campos definidos
      const updateData = {};

      // Campos simples
      if (data.name !== undefined) {
        updateData.name = data.name?.trim() || existing.name;
      }
      if (data.country !== undefined) {
        updateData.country = data.country || null;
      }
      if (data.active !== undefined) {
        updateData.active = data.active;
      }
      if (data.expires_at !== undefined) {
        updateData.expires_at = data.expires_at || null;
      }
      if (data.seller_email !== undefined) {
        updateData.seller_email = data.seller_email || null;
      }
      if (data.seller_id !== undefined) {
        updateData.seller_id = data.seller_id || null;
      }
      if (data.additional_data !== undefined) {
        updateData.additional_data = data.additional_data
          ? normalizeAdditionalData(data.additional_data)
          : null;
      }

      // Campos encriptados
      if (data.access_token !== undefined) {
        updateData.access_token = data.access_token
          ? EncryptionService.encrypt(data.access_token)
          : null;
      }
      if (data.refresh_token !== undefined) {
        updateData.refresh_token = data.refresh_token
          ? EncryptionService.encrypt(data.refresh_token)
          : null;
      }
      if (data.api_key !== undefined) {
        updateData.api_key = data.api_key
          ? EncryptionService.encrypt(data.api_key)
          : null;
      }

      // Si no hay nada para actualizar, retornar el registro actual
      if (Object.keys(updateData).length === 0) {
        return existing.get({ plain: true });
      }

      // 3. Ejecutar actualización (SIN returning: true para MySQL)
      await MarketplaceCredential.update(updateData, {
        where: { id }
        // ⚠️ NO usar returning: true en MySQL
        // ⚠️ NO usar individualHooks: true (no soportado en update masivo)
      });

      // 4. Obtener y retornar el registro actualizado
      const updated = await MarketplaceCredential.findByPk(id);
      return updated.get({ plain: true });

    } catch (error) {
      logger.error(`[REPO] ERROR en updatePartial (ID: ${id}):`, error.message);
      throw error;
    }
  },

  /**
 * Busca una credencial por ml_user_id almacenado en additional_data
 * @param {number} marketplaceId - ID del marketplace
 * @param {number} userId - ID del usuario del sistema
 * @param {number} mlUserId - ID del usuario de MercadoLibre
 * @param {number|null} excludeId - ID de credencial a excluir (para updates)
 * @returns {Promise<object|null>} - Credencial encontrada o null
 */
async findByMLUserId(marketplaceId, userId, mlUserId, excludeId = null) {
  // Buscar todas las credenciales del usuario para este marketplace
  const credentials = await MarketplaceCredential.findAll({
    where: {
      marketplace_id: marketplaceId,
      user_id: userId
    }
  });

  // Filtrar en memoria por ml_user_id en additional_data
  const matched = credentials.find(cred => {
    // Excluir si es la misma credencial (para updates)
    if (excludeId && cred.id === excludeId) return false;
    
    return getMlUserIdFromAdditionalData(cred.additional_data) === String(mlUserId);
  });

  if (!matched) return null;
  return matched.get({ plain: true });
},

  async findByCompanyAndMLUserId(marketplaceId, companyId, mlUserId, excludeId = null) {
    const credentials = await MarketplaceCredential.findAll({
      where: {
        marketplace_id: marketplaceId,
        company_id: companyId
      }
    });

    const matched = credentials.find(cred => {
      if (excludeId && cred.id === excludeId) return false;
      return getMlUserIdFromAdditionalData(cred.additional_data) === String(mlUserId);
    });

    if (!matched) return null;
    return matched.get({ plain: true });
  },

  /**
   * Busca credencial activa por ml_user_id (global), con tokens descifrados.
   * @param {number|string} mlUserId - ID de usuario en MercadoLibre
   * @returns {Promise<object|null>} - Credencial combinada o null
   */
  async findByMLUserIdGlobal(mlUserId, options = {}) {
    const { includeInactive = false } = options;
    const credentials = await MarketplaceCredential.findAll({
      where: includeInactive ? {} : { active: true },
      include: [
        {
          model: Marketplace,
          as: 'marketplace'
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    const targetId = mlUserId != null ? String(mlUserId) : null;
    if (!targetId) return null;

    let match = null;
    for (const cred of credentials) {
      const plain = cred.get({ plain: true });
      const domain = plain.marketplace?.domain || '';
      if (!domain.includes('mercadolibre')) continue;

      const stored = getMlUserIdFromAdditionalData(plain.additional_data);
      if (stored != null && String(stored) === targetId) {
        match = plain;
        break;
      }
    }

    if (!match) return null;

    if (match.access_token) {
      match.access_token = EncryptionService.decrypt(match.access_token);
    }
    if (match.refresh_token) {
      match.refresh_token = EncryptionService.decrypt(match.refresh_token);
    }
    if (match.api_key) {
      match.api_key = EncryptionService.decrypt(match.api_key);
    }
    if (match.marketplace?.client_secret) {
      match.marketplace.client_secret = EncryptionService.decrypt(match.marketplace.client_secret);
    }

    return match;
  },

  /**
   * Busca credencial activa de Falabella por seller_id o seller_email.
   * @param {object} params
   * @param {string|null} params.sellerId
   * @param {string|null} params.sellerEmail
   * @returns {Promise<object|null>}
   */
  async findActiveFalabellaBySellerIdOrEmail({ sellerId = null, sellerEmail = null }) {
    if (!sellerId && !sellerEmail) return null;

    const where = { active: true };
    if (sellerId && sellerEmail) {
      where[Op.or] = [
        { seller_id: sellerId },
        { seller_email: sellerEmail }
      ];
    } else if (sellerId) {
      where.seller_id = sellerId;
    } else if (sellerEmail) {
      where.seller_email = sellerEmail;
    }

    const record = await MarketplaceCredential.findOne({
      where,
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
          where: { domain: { [Op.like]: '%falabella%' } },
          required: true
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    if (!record) return null;

    const plain = record.get({ plain: true });
    if (plain.api_key) {
      plain.api_key = EncryptionService.decrypt(plain.api_key);
    }
    if (plain.marketplace?.client_secret) {
      plain.marketplace.client_secret = EncryptionService.decrypt(plain.marketplace.client_secret);
    }

    return plain;
  },

  /**
   * Busca una credencial activa de Falabella si hay una sola disponible.
   * @returns {Promise<object|null>}
   */
  async findSingleActiveFalabella() {
    const record = await MarketplaceCredential.findOne({
      where: { active: true },
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
          where: { domain: { [Op.like]: '%falabella%' } },
          required: true
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    if (!record) return null;

    const plain = record.get({ plain: true });
    if (plain.api_key) {
      plain.api_key = EncryptionService.decrypt(plain.api_key);
    }
    if (plain.marketplace?.client_secret) {
      plain.marketplace.client_secret = EncryptionService.decrypt(plain.marketplace.client_secret);
    }

    return plain;
  },

  async findAllActiveFalabella() {
    const records = await MarketplaceCredential.findAll({
      where: { active: true },
      include: [
        {
          model: Marketplace,
          as: 'marketplace',
          where: { domain: { [Op.like]: '%falabella%' } },
          required: true
        }
      ],
      order: [['createdAt', 'DESC']]
    });

    return records.map((record) => {
      const plain = record.get({ plain: true });
      if (plain.api_key) {
        plain.api_key = EncryptionService.decrypt(plain.api_key);
      }
      if (plain.marketplace?.client_secret) {
        plain.marketplace.client_secret = EncryptionService.decrypt(plain.marketplace.client_secret);
      }
      return plain;
    });
  },

  async delete(record) {
    return await record.destroy();
  },

    async existsByName(marketplaceId, companyId, name, excludeId = null) {
    const where = {
      marketplace_id: marketplaceId,
      company_id: companyId,
      name: name?.trim(),
      active: true
    };

    if (excludeId) {
      where.id = { [Op.ne]: excludeId };
    }

    const existing = await MarketplaceCredential.findOne({ where });
    return !!existing;
  },

    async existsByCredentials(marketplaceId, companyId, credentials, excludeId = null) {
    const where = {
      marketplace_id: marketplaceId,
      company_id: companyId,
      active: true
    };

    if (excludeId) {
      where.id = { [Op.ne]: excludeId };
    }

    const orConditions = [];

    if (credentials.seller_email) {
      orConditions.push({ seller_email: credentials.seller_email });
    }

    if (credentials.seller_id) {
      orConditions.push({ seller_id: credentials.seller_id });
    }

    if (credentials.api_key) {
      const encryptedApiKey = EncryptionService.encrypt(credentials.api_key);
      orConditions.push({ api_key: encryptedApiKey });
    }

    // ===== OPCIONAL: Validar country también =====
    if (credentials.country) {
      orConditions.push({ country: credentials.country });
    }
    // ===========================================

    if (orConditions.length === 0) {
      return false;
    }

    where[Op.or] = orConditions;

    const existing = await MarketplaceCredential.findOne({ where });
    return !!existing;
  },

};

module.exports = MarketplaceCredentialRepository;
