// repositories/MarketplaceCredentialRepository.js
const { MarketplaceCredential, Marketplace, Company, Branch } = require('../models');
const EncryptionService = require('../services/EncryptionService');
const logger = require('../../config/logger');
const { Op } = require('sequelize');

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
  async findByContext(companyId = null, branchId = null, marketplaceId = null) {
  const where = {};
  
  // Solo agregar company_id si no es null
  if (companyId !== null && companyId !== undefined) {
    where.company_id = companyId;
  }
  
  // Solo agregar branch_id si no es null  
  if (branchId !== null && branchId !== undefined) {
    where.branch_id = branchId;
  }
  
  // Solo agregar marketplace_id si no es null
  if (marketplaceId !== null && marketplaceId !== undefined) {
    where.marketplace_id = marketplaceId;
  }

  // Debe tener al menos company_id o branch_id
  if (!where.company_id && !where.branch_id) {
    throw new Error('Debe proporcionar al menos company_id o branch_id');
  }

  const records = await MarketplaceCredential.findAll({
    where,
    include: [
      {
        model: Marketplace,
        as: 'marketplace',
        attributes: ['id', 'name', 'description', 'type', 'domain', 'active']
      },
      {
        model: Company,
        as: 'company',
        attributes: ['id', 'name', 'rut', 'city', 'country', 'image']
      },
      {
        model: Branch,
        as: 'branch',
        attributes: ['id', 'name', 'city', 'address', 'image']
      }
    ],
    order: [['createdAt', 'DESC']]
  });

  // Transformar resultados (sin desencriptar para lista)
  return records.map(record => record.get({ plain: true }));
},
  async findById(id) {
    return await MarketplaceCredential.findByPk(id);
  },

  async createOrUpdate(credentialData, options = {}) {
    try {
      // Validar contexto: debe tener exactamente company_id o branch_id
      const finalCompanyId = credentialData.company_id ?? null;
      const finalBranchId = credentialData.branch_id ?? null;
      if (
        (finalCompanyId && finalBranchId) ||
        (!finalCompanyId && !finalBranchId)
      ) {
        throw new Error('Debe proporcionar exactamente company_id O branch_id');
      }

      // Buscar registro existente si se proporciona ID
      let existing = null;
      if (credentialData.id) {
        existing = await MarketplaceCredential.findByPk(credentialData.id);
        if (!existing) {
          throw new Error('credentialNotFound');
        }

        // Validar duplicado de contexto (solo si se cambia el contexto o es edición)
        const conflict = await MarketplaceCredential.findOne({
          where: {
            id: { [Op.ne]: credentialData.id },
            marketplace_id: credentialData.marketplace_id ?? existing.marketplace_id,
            company_id: finalCompanyId,
            branch_id: finalBranchId,
          },
        });
        if (conflict) {
          throw new Error('Ya existe una credencial con este contexto (marketplace + company/branch)');
        }
      } else {
        // Creación: verificar duplicado
        const conflict = await MarketplaceCredential.findOne({
          where: {
            marketplace_id: credentialData.marketplace_id,
            company_id: finalCompanyId,
            branch_id: finalBranchId,
          },
        });
        if (conflict) {
          throw new Error('Ya existe una credencial para este contexto (marketplace + company/branch)');
        }
      }

      // ✅ Construir solo los campos que se deben guardar
      const dataToSave = {
        // Campos no sensibles: siempre incluir si están definidos
        marketplace_id: credentialData.marketplace_id ?? existing?.marketplace_id,
        company_id: finalCompanyId,
        branch_id: finalBranchId,
        client_id: credentialData.client_id ?? existing?.client_id,
        redirect_uri: credentialData.redirect_uri ?? existing?.redirect_uri,
        scopes: credentialData.scopes ?? existing?.scopes,
        active: credentialData.active ?? existing?.active,
        expires_at: credentialData.expires_at ?? existing?.expires_at,
      };

      // Campos sensibles: solo actualizar si fueron explícitamente enviados
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

      if (credentialData.client_secret !== undefined) {
        dataToSave.client_secret = credentialData.client_secret
          ? EncryptionService.encrypt(credentialData.client_secret)
          : null;
      }

      if (credentialData.api_secret !== undefined) {
        dataToSave.api_secret = credentialData.api_secret
          ? EncryptionService.encrypt(credentialData.api_secret)
          : null;
      }

      let record;
      if (credentialData.id) {
        // Actualización
        await MarketplaceCredential.update(dataToSave, {
          where: { id: credentialData.id },
          ...options,
        });
        record = await MarketplaceCredential.findByPk(credentialData.id);
      } else {
        // Creación
        dataToSave.id = credentialData.id; // en caso de que venga (poco común)
        record = await MarketplaceCredential.create(dataToSave, options);
      }

      return record;
    } catch (error) {
      logger.error(`[REPO] ERROR al guardar credenciales:`, error.message);
      throw error;
    }
  }
};

module.exports = MarketplaceCredentialRepository;