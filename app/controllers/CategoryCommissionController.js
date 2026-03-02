// app/controllers/CategoryCommissionController.js
const logger = require("../../config/logger");
const { CategoryCommissionRepository } = require("../repositories");

const CategoryCommissionController = {
  /**
   * Listar comisiones con filtros opcionales
   * GET /api/category-commissions?marketplace_id=5&is_active=1&category_level_4=tintas
   */
  async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const { marketplace_id, is_active, source, category_level_4, category_id, include_marketplace } = req.query;
    
    logger.info(`${userName} - Solicita listado de comisiones`);
    logger.info(`Filtros aplicados: ${JSON.stringify(req.query)}`);

    try {
      const filters = {};
      if (marketplace_id) filters.marketplace_id = parseInt(marketplace_id);
      if (is_active !== undefined) filters.is_active = parseInt(is_active);
      if (source) filters.source = source;
      if (category_level_4) filters.category_level_4 = category_level_4;
      if (category_id) filters.category_id = category_id;

      const includeMarketplace = include_marketplace === 'true';
      const commissions = await CategoryCommissionRepository.findAll(filters, includeMarketplace);

      return commissions.length === 0
        ? res.status(204).json({ msg: "NoCommissionsFound", commissions: [] })
        : res.status(200).json({ 
            success: true, 
            count: commissions.length, 
            commissions 
          });
    } catch (err) {
      logger.error("CategoryCommissionController->index: " + err.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: err.message 
      });
    }
  },

  /**
   * Obtener una comisión por ID
   * GET /api/category-commissions/:id
   */
  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const commissionId = req.params.id;
    
    logger.info(`${userName} - Consulta comisión ID ${commissionId}`);

    try {
      const commission = await CategoryCommissionRepository.findById(commissionId);
      if (!commission) {
        return res.status(404).json({ success: false, msg: "CommissionNotFound" });
      }
      return res.status(200).json({ success: true, commission });
    } catch (err) {
      logger.error("CategoryCommissionController->show: " + err.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: err.message 
      });
    }
  },

  /**
   * Crear nueva comisión
   * POST /api/category-commissions
   */
  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nueva comisión`);
    logger.info("Datos recibidos (body):");
    logger.info(JSON.stringify(req.body));

    const {
      marketplace_id, credential_id, category_id, global_identifier, category_name_api,
      category_level_1, category_level_2, category_level_3, category_level_4,
      commission_percentage, min_fee_amount, max_fee_amount, fixed_fee_amount,
      currency, source, notes
    } = req.body;

    // Validaciones básicas
    if (!marketplace_id || !category_level_1 || !category_level_4 || commission_percentage === undefined) {
      return res.status(400).json({ 
        success: false, 
        error: "ValidationError", 
        details: "Faltan campos requeridos: marketplace_id, category_level_1, category_level_4, commission_percentage" 
      });
    }

    if (commission_percentage < 0 || commission_percentage > 100) {
      return res.status(400).json({ 
        success: false, 
        error: "ValidationError", 
        details: "commission_percentage debe estar entre 0 y 100" 
      });
    }

    try {
      // Verificar que no exista duplicado por ruta única
      const existing = await CategoryCommissionRepository.findByCategoryPath(
        marketplace_id, 
        category_level_1, 
        category_level_4, 
        credential_id || null
      );
      
      if (existing) {
        return res.status(409).json({ 
          success: false, 
          error: "CommissionAlreadyExists", 
          details: `Ya existe una comisión para esta ruta de categoría`,
          existing_id: existing.id 
        });
      }

      const commissionData = {
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
        source: source || 'manual',
        notes: notes || null
      };

      const newCommission = await CategoryCommissionRepository.create(commissionData);
      return res.status(201).json({ 
        success: true, 
        msg: "Comisión creada correctamente", 
        commission: newCommission 
      });
    } catch (err) {
      logger.error("CategoryCommissionController->store: " + err.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: err.message 
      });
    }
  },

  /**
   * Actualizar comisión existente
   * PUT /api/category-commissions/:id
   */
  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const commissionId = req.params.id;
    
    logger.info(`${userName} - Actualiza comisión ID ${commissionId}`);
    logger.info("Datos recibidos (params + body):");
    logger.info(JSON.stringify({ params: req.params, body: req.body }));

    const {
      category_id, global_identifier, category_name_api,
      category_level_1, category_level_2, category_level_3, category_level_4,
      commission_percentage, min_fee_amount, max_fee_amount, fixed_fee_amount,
      currency, is_active, source, notes
    } = req.body;

    try {
      const commission = await CategoryCommissionRepository.findById(commissionId);
      if (!commission) {
        return res.status(404).json({ success: false, msg: "CommissionNotFound" });
      }

      // Validar comisión si se modifica
      if (commission_percentage !== undefined && (commission_percentage < 0 || commission_percentage > 100)) {
        return res.status(400).json({ 
          success: false, 
          error: "ValidationError", 
          details: "commission_percentage debe estar entre 0 y 100" 
        });
      }

      const updateData = {
        category_id: category_id !== undefined ? category_id : undefined,
        global_identifier: global_identifier !== undefined ? global_identifier : undefined,
        category_name_api: category_name_api !== undefined ? category_name_api : undefined,
        category_level_1: category_level_1 !== undefined ? category_level_1 : undefined,
        category_level_2: category_level_2 !== undefined ? category_level_2 : undefined,
        category_level_3: category_level_3 !== undefined ? category_level_3 : undefined,
        category_level_4: category_level_4 !== undefined ? category_level_4 : undefined,
        commission_percentage: commission_percentage !== undefined ? commission_percentage : undefined,
        min_fee_amount: min_fee_amount !== undefined ? min_fee_amount : undefined,
        max_fee_amount: max_fee_amount !== undefined ? max_fee_amount : undefined,
        fixed_fee_amount: fixed_fee_amount !== undefined ? fixed_fee_amount : undefined,
        currency: currency !== undefined ? currency : undefined,
        is_active: is_active !== undefined ? is_active : undefined,
        source: source !== undefined ? source : undefined,
        notes: notes !== undefined ? notes : undefined
      };

      const updatedCommission = await CategoryCommissionRepository.update(commission, updateData);
      return res.status(200).json({ 
        success: true, 
        msg: "Comisión actualizada correctamente", 
        commission: updatedCommission 
      });
    } catch (err) {
      logger.error("CategoryCommissionController->update: " + err.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: err.message 
      });
    }
  },

  /**
   * Eliminar comisión (soft delete)
   * DELETE /api/category-commissions/:id
   */
  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const commissionId = req.params.id;
    
    logger.info(`${userName} - Elimina comisión ID ${commissionId}`);

    try {
      const commission = await CategoryCommissionRepository.findById(commissionId);
      if (!commission) {
        return res.status(404).json({ success: false, msg: "CommissionNotFound" });
      }

      await CategoryCommissionRepository.delete(commission);
      return res.status(200).json({ 
        success: true, 
        msg: "Comisión desactivada correctamente" 
      });
    } catch (err) {
      logger.error("CategoryCommissionController->destroy: " + err.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: err.message 
      });
    }
  },

  /**
   * Endpoint para calcular pricing en tiempo real (uso interno o para testing)
   * POST /api/category-commissions/calculate-pricing
   */
  async calculatePricing(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const { marketplace_id, category_id, category_name, price, credential_id } = req.body;
    
    logger.info(`${userName} - Calcula pricing para categoría`);
    logger.info(`Datos: marketplace_id=${marketplace_id}, category_id=${category_id}, price=${price}`);

    if (!marketplace_id || !price || (!category_id && !category_name)) {
      return res.status(400).json({ 
        success: false, 
        error: "ValidationError", 
        details: "Se requiere marketplace_id, price y category_id o category_name" 
      });
    }

    if (isNaN(price) || price <= 0) {
      return res.status(400).json({ 
        success: false, 
        error: "ValidationError", 
        details: "price debe ser un número mayor a 0" 
      });
    }

    try {
      const commission = await CategoryCommissionRepository.findByCategory(
        marketplace_id,
        { categoryId: category_id, categoryName: category_name },
        credential_id || null
      );

      if (!commission) {
        return res.status(404).json({ 
          success: false, 
          msg: "CommissionNotFound", 
          pricing: CategoryCommissionRepository.calculatePricing(null, price) 
        });
      }

      const pricing = CategoryCommissionRepository.calculatePricing(commission, parseFloat(price));
      return res.status(200).json({ 
        success: true, 
        pricing, 
        commission_info: {
          id: commission.id,
          source: commission.source,
          updated_at: commission.updated_at
        }
      });
    } catch (err) {
      logger.error("CategoryCommissionController->calculatePricing: " + err.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: err.message 
      });
    }
  },

  /**
   * Endpoint para importación masiva desde CSV (solo administradores)
   * POST /api/category-commissions/import
   */
  async importCSV(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const { marketplace_id, currency, source, rows } = req.body;
    
    logger.info(`${userName} - Importa comisiones desde CSV`);
    logger.info(`Marketplace ID: ${marketplace_id}, filas recibidas: ${rows?.length || 0}`);

    if (!marketplace_id || !Array.isArray(rows) || rows.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: "ValidationError", 
        details: "Se requiere marketplace_id y un array no vacío de filas" 
      });
    }

    try {
      const result = await CategoryCommissionRepository.bulkImport(rows, marketplace_id, {
        currency: currency || 'CLP',
        source: source || 'csv_import'
      });

      return res.status(200).json({ 
        success: true, 
        msg: "Importación completada", 
        stats: result 
      });
    } catch (err) {
      logger.error("CategoryCommissionController->importCSV: " + err.message);
      return res.status(500).json({ 
        success: false, 
        error: "ServerError", 
        details: err.message 
      });
    }
  }
};

module.exports = CategoryCommissionController;