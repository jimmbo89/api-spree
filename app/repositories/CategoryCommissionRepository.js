// app/repositories/CategoryCommissionRepository.js
const { CategoryCommission, Marketplace } = require("../models");
const { Op } = require("sequelize");
const logger = require("../../config/logger");

// Función para normalizar nombres de categoría
const normalizeDelimiter = (value, options = {}) => {
  if (!value || typeof value !== 'string') return value;
  
  const { 
    from = '|', 
    to = '/', 
    trim = true,
    removeEmpty = true 
  } = options;
  
  let result = value.split(from);
  
  if (trim) {
    result = result.map(item => item.trim());
  }
  
  if (removeEmpty) {
    result = result.filter(item => item.length > 0);
  }
  
  return result.join(to);
};

const CategoryCommissionRepository = {
  /**
   * Obtiene todas las comisiones con filtros opcionales
   */
  async findAll(filters = {}, includeMarketplace = false) {
    try {
      const { marketplace_id, is_active, source, category_level_4, category_id } = filters;
      
      const where = {};
      if (marketplace_id) where.marketplace_id = marketplace_id;
      if (is_active !== undefined) where.is_active = is_active;
      if (source) where.source = source;
      if (category_level_4) where.category_level_4 = { [Op.like]: `%${category_level_4}%` };
      if (category_id) where.category_id = category_id;

      const includeOptions = includeMarketplace
        ? [{ model: Marketplace, as: 'marketplace', attributes: ['id', 'name', 'domain'] }]
        : [];

      const commissions = await CategoryCommission.findAll({
        where,
        attributes: [
          'id', 'marketplace_id', 'credential_id', 'category_id', 'global_identifier',
          'category_name_api', 'category_level_1', 'category_level_2', 'category_level_3',
          'category_level_4', 'commission_percentage', 'min_fee_amount', 'max_fee_amount',
          'fixed_fee_amount', 'currency', 'is_active', 'source', 'last_synced_at', 'notes'
        ],
        include: includeOptions,
        order: [['category_level_1', 'ASC'], ['category_level_2', 'ASC'], ['category_level_3', 'ASC'], ['category_level_4', 'ASC']]
      });

      return commissions;
    } catch (error) {
      logger.error("Error en CategoryCommissionRepository->findAll:", error);
      throw new Error(`Error al obtener comisiones: ${error.message}`);
    }
  },

  /**
   * Busca comisión por identificadores de categoría (método principal para uso en tiempo real)
   */
  async findByCategory(marketplaceId, identifiers, credentialId = null) {
    try {
      const { categoryId, categoryName, globalIdentifier } = identifiers;
      const baseWhere = {
        marketplace_id: marketplaceId,
        is_active: 1,
        credential_id: credentialId || { [Op.eq]: null }
      };

      // 🔹 Prioridad 1: Búsqueda por category_id
      if (categoryId) {
        const byId = await CategoryCommission.findOne({
          where: { ...baseWhere, category_id: categoryId.toString() },
          attributes: ['id', 'category_id', 'category_level_4', 'commission_percentage', 'currency', 'source'],
          order: [['updatedAt', 'DESC']]
        });
        if (byId) return byId;
      }

      // 🔹 Prioridad 2: Búsqueda por global_identifier
      if (globalIdentifier) {
        const byGlobal = await CategoryCommission.findOne({
          where: { ...baseWhere, global_identifier: globalIdentifier },
          attributes: ['id', 'global_identifier', 'category_level_4', 'commission_percentage', 'currency', 'source'],
          order: [['updatedAt', 'DESC']]
        });
        if (byGlobal) return byGlobal;
      }

      // 🔹 Prioridad 3: Fallback por nombre de categoría
      if (categoryName) {
        const normalizedName = categoryName.trim();
        const byName = await CategoryCommission.findOne({
          where: {
            ...baseWhere,
            [Op.or]: [
              { category_level_4: normalizedName },
              { category_name_api: normalizedName },
              { category_level_4: { [Op.like]: `${normalizedName}%` } }
            ]
          },
          attributes: ['id', 'category_level_4', 'category_name_api', 'commission_percentage', 'currency', 'source'],
          order: [['updatedAt', 'DESC']]
        });
        if (byName) return byName;
      }

      return null;
    } catch (error) {
      logger.error(`Error en CategoryCommissionRepository->findByCategory:`, error);
      throw new Error(`Error al buscar comisión: ${error.message}`);
    }
  },

  /**
   * 🔹 NUEVO: Búsqueda con fallback inteligente cuando no hay category_level_4
   * Útil para categorías donde el CSV no tiene nivel 4 definido
   */
  async findByCategoryWithFallback(marketplaceId, identifiers, credentialId = null) {
    try {
      const { categoryId, categoryName, globalIdentifier, level1, level2, level3 } = identifiers;
      const baseWhere = {
        marketplace_id: marketplaceId,
        is_active: 1,
        credential_id: credentialId || { [Op.eq]: null }
      };

      // 1. Intentar por category_id primero (más preciso)
      if (categoryId) {
        const byId = await CategoryCommission.findOne({
          where: { ...baseWhere, category_id: categoryId.toString() },
          attributes: ['id', 'category_id', 'category_level_4', 'commission_percentage', 'currency', 'source']
        });
        if (byId) return byId;
      }

      // 2. Intentar por global_identifier
      if (globalIdentifier) {
        const byGlobal = await CategoryCommission.findOne({
          where: { ...baseWhere, global_identifier: globalIdentifier },
          attributes: ['id', 'global_identifier', 'category_level_4', 'commission_percentage', 'currency', 'source']
        });
        if (byGlobal) return byGlobal;
      }

      // 3. Intentar por categoryName (level4 o category_name_api)
      if (categoryName) {
        const normalizedName = categoryName.trim();
        const byName = await CategoryCommission.findOne({
          where: {
            ...baseWhere,
            [Op.or]: [
              { category_level_4: normalizedName },
              { category_name_api: normalizedName }
            ]
          },
          attributes: ['id', 'category_level_4', 'category_name_api', 'commission_percentage', 'currency', 'source']
        });
        if (byName) return byName;
      }

      // 4. 🔹 FALLBACK: Buscar por ruta parcial (level1 + level2 + level3) cuando no hay level4
      if (level1 && (!categoryName || categoryName === 'null')) {
        const wherePartial = { ...baseWhere, category_level_1: level1 };
        if (level2) wherePartial.category_level_2 = level2;
        if (level3) wherePartial.category_level_3 = level3;

        const byPath = await CategoryCommission.findOne({
          where: wherePartial,
          attributes: ['id', 'category_level_4', 'commission_percentage', 'currency', 'source'],
          order: [['category_level_4', 'ASC']] // Priorizar el primero disponible
        });
        if (byPath) {
          logger.debug(`[FALLBACK] Comisión encontrada por ruta parcial para "${level1}"`);
          return byPath;
        }
      }

      return null;
    } catch (error) {
      logger.error(`Error en CategoryCommissionRepository->findByCategoryWithFallback:`, error);
      throw new Error(`Error al buscar comisión con fallback: ${error.message}`);
    }
  },

  /**
   * 🔹 NUEVO: Actualizar category_id y global_identifier por ruta de categoría
   * Útil después de consultar GetCategoryTree para mapear category_id
   */
  async updateCategoryIdByPath(marketplaceId, level1, level4, updates, credentialId = null) {
    try {
      const where = {
        marketplace_id: marketplaceId,
        category_level_1: level1,
        category_level_4: level4,
        credential_id: credentialId || { [Op.eq]: null }
      };

      const commission = await CategoryCommission.findOne({ where });
      if (!commission) {
        logger.warn(`No se encontró comisión para actualizar: marketplace=${marketplaceId}, level1="${level1}", level4="${level4}"`);
        return null;
      }

      const updateData = {};
      if (updates.category_id) updateData.category_id = updates.category_id.toString();
      if (updates.global_identifier) updateData.global_identifier = updates.global_identifier;
      if (updates.category_name_api) updateData.category_name_api = updates.category_name_api;
      if (Object.keys(updateData).length > 0) {
        updateData.last_synced_at = new Date();
      }

      await commission.update(updateData);
      logger.info(`Comisión actualizada: ID=${commission.id}, category_id=${updateData.category_id || commission.category_id}`);
      return commission;
    } catch (error) {
      logger.error(`Error en CategoryCommissionRepository->updateCategoryIdByPath:`, error);
      throw new Error(`Error al actualizar category_id: ${error.message}`);
    }
  },

/**
 * Busca comisión por ruta completa de niveles (fallback cuando no hay category_id)
 */
async findByCategoryPathWithLevels(marketplaceId, { level1, level2, level3, level4 }) {
  try {
    // Normalizar todos los niveles recibidos
    const normalizedLevels = {
      level1: normalizeDelimiter(level1),
      level2: normalizeDelimiter(level2),
      level3: normalizeDelimiter(level3),
      level4: normalizeDelimiter(level4)
    };
    
    logger.debug(`[BD-SEARCH] Buscando con niveles normalizados: ${normalizedLevels}`);
    
    // Construir búsqueda jerárquica - priorizar level4 si existe
    let whereConditions = { 
      marketplace_id: marketplaceId, 
      is_active: 1 
    };
    
    // Si tenemos level4, buscar exacto por los 4 niveles
    if (normalizedLevels.level4) {
      whereConditions = {
        ...whereConditions,
        category_level_1: { [Op.like]: `%${normalizedLevels.level1}%` },
        category_level_2: { [Op.like]: `%${normalizedLevels.level2}%` },
        category_level_3: { [Op.like]: `%${normalizedLevels.level3}%` },
        category_level_4: { [Op.like]: `%${normalizedLevels.level4}%` }
      };
    } 
    // Si no hay level4, buscar por level3
    else if (normalizedLevels.level3) {
      whereConditions = {
        ...whereConditions,
        category_level_1: { [Op.like]: `%${normalizedLevels.level1}%` },
        category_level_2: { [Op.like]: `%${normalizedLevels.level2}%` },
        category_level_3: { [Op.like]: `%${normalizedLevels.level3}%` },
        category_level_4: { [Op.or]: [null, '', { [Op.eq]: sequelize.literal('category_level_4') }] }
      };
    }
    // Si no hay level3, buscar por level2
    else if (normalizedLevels.level2) {
      whereConditions = {
        ...whereConditions,
        category_level_1: { [Op.like]: `%${normalizedLevels.level1}%` },
        category_level_2: { [Op.like]: `%${normalizedLevels.level2}%` },
        category_level_3: { [Op.or]: [null, ''] },
        category_level_4: { [Op.or]: [null, ''] }
      };
    }
    // Solo level1
    else if (normalizedLevels.level1) {
      whereConditions = {
        ...whereConditions,
        category_level_1: { [Op.like]: `%${normalizedLevels.level1}%` },
        category_level_2: { [Op.or]: [null, ''] },
        category_level_3: { [Op.or]: [null, ''] },
        category_level_4: { [Op.or]: [null, ''] }
      };
    }
    
    logger.debug(`[BD-SEARCH] Where conditions:`, JSON.stringify(whereConditions, null, 2));
    
    // Orden compatible con MySQL: priorizar registros con más niveles completos
    // En MySQL, NULL en DESC ya aparece al final por defecto
    const orderClause = [
      ['category_level_4', 'DESC'],
      ['category_level_3', 'DESC'],
      ['category_level_2', 'DESC'],
      ['updatedAt', 'DESC']
    ];
    
    // Alternativa más robusta si necesitas forzar NULLs al final en MySQL:
    // const orderClause = [
    //   [sequelize.literal('category_level_4 IS NOT NULL'), 'DESC'],
    //   ['category_level_4', 'DESC'],
    //   [sequelize.literal('category_level_3 IS NOT NULL'), 'DESC'],
    //   ['category_level_3', 'DESC'],
    //   [sequelize.literal('category_level_2 IS NOT NULL'), 'DESC'],
    //   ['category_level_2', 'DESC'],
    //   ['updatedAt', 'DESC']
    // ];
    
    const commission = await CategoryCommission.findOne({
      where: whereConditions,
      attributes: ['id', 'category_id', 'category_level_1', 'category_level_2', 'category_level_3', 'category_level_4', 'commission_percentage', 'currency', 'source'],
      order: orderClause
    });
    
    if (commission) {
      logger.info(`[BD-SEARCH] ✅ Comisión encontrada: ID=${commission.id}, Level4="${commission.category_level_4}"`);
    } else {
      logger.warn(`[BD-SEARCH] ❌ No se encontró comisión para los niveles proporcionados`);
    }
    
    return commission;
  } catch (error) {
    logger.error("Error en CategoryCommissionRepository->findByCategoryPathWithLevels:", error);
    throw new Error(`Error al buscar por ruta de niveles: ${error.message}`);
  }
},

/**
 * Actualiza solo los identificadores de API de una comisión existente
 */
async updateCommissionIdentifiers(commissionId, { category_id, global_identifier, category_name_api }) {
  try {
    const commission = await CategoryCommission.findByPk(commissionId);
    if (!commission) {
      logger.warn(`Comisión no encontrada para actualizar: ID=${commissionId}`);
      return null;
    }

    const updateData = {};
    if (category_id) updateData.category_id = category_id.toString();
    if (global_identifier) updateData.global_identifier = global_identifier;
    if (category_name_api) updateData.category_name_api = category_name_api;
    
    if (Object.keys(updateData).length > 0) {
      updateData.last_synced_at = new Date();
      await commission.update(updateData);
      logger.info(`Comisión actualizada: ID=${commissionId}, identifiers=${JSON.stringify(updateData)}`);
    }
    
    return commission;
  } catch (error) {
    logger.error(`Error en CategoryCommissionRepository->updateCommissionIdentifiers (ID: ${commissionId}):`, error);
    throw new Error(`Error al actualizar identificadores: ${error.message}`);
  }
},

  /**
   * Obtiene una comisión por su ID
   */
  async findById(id) {
    try {
      const commission = await CategoryCommission.findByPk(id, {
        attributes: [
          'id', 'marketplace_id', 'credential_id', 'category_id', 'global_identifier',
          'category_name_api', 'category_level_1', 'category_level_2', 'category_level_3',
          'category_level_4', 'commission_percentage', 'min_fee_amount', 'max_fee_amount',
          'fixed_fee_amount', 'currency', 'is_active', 'source', 'last_synced_at', 'notes'
        ]
      });
      return commission;
    } catch (error) {
      logger.error(`Error en CategoryCommissionRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener la comisión: ${error.message}`);
    }
  },

  /**
   * Busca por ruta completa de categoría (para validación antes de crear)
   */
  async findByCategoryPath(marketplaceId, level1, level4, credentialId = null) {
    try {
      const where = {
        marketplace_id: marketplaceId,
        category_level_1: level1,
        category_level_4: level4,
        credential_id: credentialId || { [Op.eq]: null }
      };

      const commission = await CategoryCommission.findOne({
        where,
        attributes: ['id', 'category_id', 'commission_percentage', 'currency']
      });
      return commission;
    } catch (error) {
      logger.error("Error en CategoryCommissionRepository->findByCategoryPath:", error);
      throw new Error(`Error al buscar por ruta de categoría: ${error.message}`);
    }
  },

  /**
   * Crea una nueva comisión
   */
  async create(data) {
    try {
      const {
        marketplace_id, credential_id, category_id, global_identifier, category_name_api,
        category_level_1, category_level_2, category_level_3, category_level_4,
        commission_percentage, min_fee_amount, max_fee_amount, fixed_fee_amount,
        currency, source, notes
      } = data;

      const commission = await CategoryCommission.create({
        marketplace_id,
        credential_id: credential_id || null,
        category_id: category_id || null,
        global_identifier: global_identifier || null,
        category_name_api: category_name_api || null,
        category_level_1,
        category_level_2: category_level_2 || null,
        category_level_3: category_level_3 || null,
        category_level_4,
        commission_percentage,
        min_fee_amount: min_fee_amount || 0,
        max_fee_amount: max_fee_amount || null,
        fixed_fee_amount: fixed_fee_amount || 0,
        currency: currency || 'CLP',
        is_active: 1,
        source: source || 'manual',
        notes: notes || null,
        last_synced_at: new Date()
      });

      logger.info(`Nueva comisión creada: ID ${commission.id}, categoría: ${commission.category_level_4}`);
      return commission;
    } catch (error) {
      logger.error("Error en CategoryCommissionRepository->create:", error);
      throw new Error(`Error al crear comisión: ${error.message}`);
    }
  },

  /**
   * Actualiza una comisión existente
   */
  async update(commission, data) {
    try {
      const {
        category_id, global_identifier, category_name_api,
        category_level_1, category_level_2, category_level_3, category_level_4,
        commission_percentage, min_fee_amount, max_fee_amount, fixed_fee_amount,
        currency, is_active, source, notes
      } = data;

      const updateData = {};
      if (category_id !== undefined) updateData.category_id = category_id;
      if (global_identifier !== undefined) updateData.global_identifier = global_identifier;
      if (category_name_api !== undefined) updateData.category_name_api = category_name_api;
      if (category_level_1 !== undefined) updateData.category_level_1 = category_level_1;
      if (category_level_2 !== undefined) updateData.category_level_2 = category_level_2;
      if (category_level_3 !== undefined) updateData.category_level_3 = category_level_3;
      if (category_level_4 !== undefined) updateData.category_level_4 = category_level_4;
      if (commission_percentage !== undefined) updateData.commission_percentage = commission_percentage;
      if (min_fee_amount !== undefined) updateData.min_fee_amount = min_fee_amount;
      if (max_fee_amount !== undefined) updateData.max_fee_amount = max_fee_amount;
      if (fixed_fee_amount !== undefined) updateData.fixed_fee_amount = fixed_fee_amount;
      if (currency !== undefined) updateData.currency = currency;
      if (is_active !== undefined) updateData.is_active = is_active;
      if (source !== undefined) updateData.source = source;
      if (notes !== undefined) updateData.notes = notes;
      if (Object.keys(updateData).length > 0) {
        updateData.last_synced_at = new Date();
      }

      await commission.update(updateData);
      logger.info(`Comisión actualizada (ID: ${commission.id})`);
      return commission;
    } catch (error) {
      logger.error(`Error en CategoryCommissionRepository->update (ID: ${commission.id}):`, error);
      throw new Error(`Error al actualizar comisión: ${error.message}`);
    }
  },

  /**
   * Elimina una comisión (soft delete: cambia is_active a 0)
   */
  async delete(commission) {
    try {
      await commission.update({ is_active: 0, last_synced_at: new Date() });
      logger.info(`Comisión desactivada (soft delete) - ID: ${commission.id}`);
      return { success: true, message: "Comisión desactivada correctamente" };
    } catch (error) {
      logger.error(`Error en CategoryCommissionRepository->delete (ID: ${commission.id}):`, error);
      throw new Error(`Error al desactivar comisión: ${error.message}`);
    }
  },

  /**
   * Calcula pricing estructurado compatible con Mercado Libre/Falabella
   */
  calculatePricing(commission, price) {
    if (!commission || !price || price <= 0 || !commission.commission_percentage) {
      return {
        sale_fee_amount: null,
        listing_fee_amount: 0,
        total_fee_amount: null,
        fee_percentage: null,
        net_amount: null,
        currency: commission?.currency || 'CLP',
        warning: 'Comisión no disponible para esta categoría',
        source: 'tabla_local'
      };
    }

    let calculatedFee = parseFloat((price * (commission.commission_percentage / 100)).toFixed(0));
    
    if (commission.min_fee_amount && calculatedFee < commission.min_fee_amount) {
      calculatedFee = parseFloat(commission.min_fee_amount);
    }
    if (commission.max_fee_amount && calculatedFee > commission.max_fee_amount) {
      calculatedFee = parseFloat(commission.max_fee_amount);
    }
    
    const totalFee = calculatedFee + (parseFloat(commission.fixed_fee_amount) || 0);
    const netAmount = parseFloat((price - totalFee).toFixed(0));
    
    return {
      sale_fee_amount: calculatedFee,
      listing_fee_amount: parseFloat(commission.fixed_fee_amount) || 0,
      total_fee_amount: totalFee,
      category_id: commission.category_id,
      category_name: commission.category_name_api || commission.category_level_4,
      category_path: commission.category_level_2 
        ? `${commission.category_level_1} > ${commission.category_level_2}${commission.category_level_3 ? ` > ${commission.category_level_3}` : ''} > ${commission.category_level_4}`
        : commission.category_level_1,
      input_price: price,
      net_amount: netAmount,
      fee_percentage: parseFloat(commission.commission_percentage),
      currency: commission.currency,
      source: commission.source || 'tabla_local',
      updatedAt: commission.updatedAt?.toISOString?.() || commission.updatedAt
    };
  },

  /**
   * Importación masiva desde CSV/XLSX (upsert por ruta única)
   */
  async bulkImport(rows, marketplaceId, options = {}) {
    const { credential_id = null, currency = 'CLP', source = 'csv_import' } = options;
    const results = { success: 0, failed: 0, warnings: [] };

    for (const row of rows) {
      try {
        // 🔹 FALLBACK: Si level4 es null/empty, usar level3 > level2 > level1
        let level4 = row.category_level_4?.trim();
        if (!level4 && row.category_level_3) level4 = row.category_level_3.trim();
        if (!level4 && row.category_level_2) level4 = row.category_level_2.trim();
        if (!level4) level4 = row.category_level_1?.trim();
        
        if (!row.category_level_1 || !level4 || row.commission_percentage === undefined) {
          results.warnings.push(`Fila incompleta: ${JSON.stringify(row)}`);
          continue;
        }

        const commission = parseFloat(row.commission_percentage);
        if (isNaN(commission) || commission < 0 || commission > 100) {
          results.warnings.push(`Comisión inválida para "${level4}": ${row.commission_percentage}`);
          continue;
        }

        const [_, created] = await CategoryCommission.upsert({
          marketplace_id: marketplaceId,
          credential_id,
          category_id: row.category_id || null,
          global_identifier: row.global_identifier || null,
          category_name_api: row.category_name_api || null,
          category_level_1: row.category_level_1.trim(),
          category_level_2: row.category_level_2?.trim() || null,
          category_level_3: row.category_level_3?.trim() || null,
          category_level_4: level4, // Usar fallback si es necesario
          commission_percentage: commission,
          min_fee_amount: row.min_fee_amount || 0,
          max_fee_amount: row.max_fee_amount || null,
          fixed_fee_amount: row.fixed_fee_amount || 0,
          currency,
          source,
          is_active: 1,
          notes: row.notes || null,
          last_synced_at: new Date()
        }, {
          conflictFields: ['marketplace_id', 'category_level_1', 'category_level_2', 'category_level_3', 'category_level_4', 'credential_id']
        });

        results.success++;
      } catch (error) {
        results.failed++;
        results.warnings.push(`Error en "${row.category_level_4 || row.category_level_3 || row.category_level_2 || row.category_level_1}": ${error.message}`);
        logger.warn(`Error importando comisión:`, error);
      }
    }

    return results;
  }
};

module.exports = CategoryCommissionRepository;
