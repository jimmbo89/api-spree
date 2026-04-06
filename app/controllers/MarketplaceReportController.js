const MarketplaceReportingService = require('../services/MarketplaceReportingService');
const { CompanyRepository, UserRepository, MarketplaceCredentialRepository } = require('../repositories');
const logger = require('../../config/logger');

const MarketplaceReportController = {
  /**
   * POST /api/reports/sales
   * Reporte de ventas
   */
  async sales(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita reporte de ventas`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const {
        from,
        to,
        marketplace,
        status,
        company_id,
        user_id,
        limit,
        offset
      } = req.body || {};

      // ✅ VALIDAR company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.warn(`${req.user?.user || 'Unknown'} - company_id ${company_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `La empresa con ID ${company_id} no existe`
          });
        }
      }

      // ✅ VALIDAR user_id si se proporciona
      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.warn(`${req.user?.user || 'Unknown'} - user_id ${user_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `El usuario con ID ${user_id} no existe`
          });
        }
      }

      // ✅ Obtener marketplaces disponibles para el usuario
      const credentials = await MarketplaceCredentialRepository.findByUser(req.user.id);
      const availableMarketplaces = credentials.map(cred => ({
        id: cred.id,
        name: cred.name,
        domain: cred.marketplace?.domain
      }));

      const filters = {
        from,
        to,
        marketplace,
        status,
        company_id: company_id ? parseInt(company_id) : null,
        user_id: user_id ? parseInt(user_id) : null,
        limit: limit ? parseInt(limit) : 50,
        offset: offset ? parseInt(offset) : 0
      };

      const report = await MarketplaceReportingService.getSalesReport(filters);

      logger.info(`${req.user?.user || 'Unknown'} - Reporte de ventas generado exitosamente`);
      res.json({
        success: true,
        data: report,
        availableMarketplaces
      });
    } catch (error) {
      logger.error('[MarketplaceReportController] Error en sales: ' + error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * POST /api/reports/commissions
   * Reporte de comisiones
   */
  async commissions(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita reporte de comisiones`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const {
        from,
        to,
        marketplace,
        status,
        company_id,
        fee_type,
        limit,
        offset
      } = req.body || {};

      // ✅ VALIDAR company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.warn(`${req.user?.user || 'Unknown'} - company_id ${company_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `La empresa con ID ${company_id} no existe`
          });
        }
      }

      // ✅ Obtener marketplaces disponibles para el usuario
      const credentials = await MarketplaceCredentialRepository.findByUser(req.user.id);
      const availableMarketplaces = credentials.map(cred => ({
        id: cred.id,
        name: cred.name,
        domain: cred.marketplace?.domain
      }));

      const filters = {
        from,
        to,
        marketplace,
        status,
        company_id: company_id ? parseInt(company_id) : null,
        fee_type: fee_type || 'commission',
        limit: limit ? parseInt(limit) : 50,
        offset: offset ? parseInt(offset) : 0
      };

      const report = await MarketplaceReportingService.getCommissionReport(filters);

      logger.info(`${req.user?.user || 'Unknown'} - Reporte de comisiones generado exitosamente`);
      res.json({
        success: true,
        data: report,
        availableMarketplaces
      });
    } catch (error) {
      logger.error('[MarketplaceReportController] Error en commissions: ' + error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * POST /api/reports/profits
   * Reporte de ganancias
   */
  async profits(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita reporte de ganancias`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const {
        from,
        to,
        marketplace,
        company_id,
        user_id
      } = req.body || {};

      // ✅ VALIDAR company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.warn(`${req.user?.user || 'Unknown'} - company_id ${company_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `La empresa con ID ${company_id} no existe`
          });
        }
      }

      // ✅ VALIDAR user_id si se proporciona
      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.warn(`${req.user?.user || 'Unknown'} - user_id ${user_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `El usuario con ID ${user_id} no existe`
          });
        }
      }

      // ✅ Obtener marketplaces disponibles para el usuario
      const credentials = await MarketplaceCredentialRepository.findByUser(req.user.id);
      const availableMarketplaces = credentials.map(cred => ({
        id: cred.id,
        name: cred.name,
        domain: cred.marketplace?.domain
      }));

      const filters = {
        from,
        to,
        marketplace,
        company_id: company_id ? parseInt(company_id) : null,
        user_id: user_id ? parseInt(user_id) : null
      };

      const groupBy = req.body?.group_by || 'marketplace';

      const report = await MarketplaceReportingService.getProfitReport(filters, groupBy);

      logger.info(`${req.user?.user || 'Unknown'} - Reporte de ganancias generado exitosamente`);
      res.json({
        success: true,
        data: report,
        availableMarketplaces
      });
    } catch (error) {
      logger.error('[MarketplaceReportController] Error en profits: ' + error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * POST /api/reports/sales/stats
   * Estadísticas de ventas
   */
  async salesStats(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita estadísticas de ventas`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const {
        from,
        to,
        marketplace,
        company_id,
        user_id
      } = req.body || {};

      // ✅ VALIDAR company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.warn(`${req.user?.user || 'Unknown'} - company_id ${company_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `La empresa con ID ${company_id} no existe`
          });
        }
      }

      // ✅ VALIDAR user_id si se proporciona
      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.warn(`${req.user?.user || 'Unknown'} - user_id ${user_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `El usuario con ID ${user_id} no existe`
          });
        }
      }

      const filters = {
        from,
        to,
        marketplace,
        company_id: company_id ? parseInt(company_id) : null,
        user_id: user_id ? parseInt(user_id) : null
      };

      const stats = await MarketplaceReportingService.getSalesStats(filters);

      logger.info(`${req.user?.user || 'Unknown'} - Estadísticas de ventas generadas exitosamente`);
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('[MarketplaceReportController] Error en salesStats: ' + error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * POST /api/reports/commissions/stats
   * Estadísticas de comisiones
   */
  async commissionStats(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita estadísticas de comisiones`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const {
        from,
        to,
        marketplace,
        company_id,
        fee_type
      } = req.body || {};

      // ✅ VALIDAR company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.warn(`${req.user?.user || 'Unknown'} - company_id ${company_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `La empresa con ID ${company_id} no existe`
          });
        }
      }

      const filters = {
        from,
        to,
        marketplace,
        company_id: company_id ? parseInt(company_id) : null,
        fee_type: fee_type || 'commission'
      };

      const stats = await MarketplaceReportingService.getCommissionStats(filters);

      logger.info(`${req.user?.user || 'Unknown'} - Estadísticas de comisiones generadas exitosamente`);
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('[MarketplaceReportController] Error en commissionStats: ' + error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * POST /api/reports/profits/stats
   * Estadísticas de ganancias
   */
  async profitStats(req, res) {
    try {
      logger.info(`${req.user?.user || 'Unknown'} - Solicita estadísticas de ganancias`);
      logger.info(`Datos recibidos:\n ${JSON.stringify(req.body)}`);

      const {
        from,
        to,
        marketplace,
        company_id,
        user_id
      } = req.body || {};

      // ✅ VALIDAR company_id si se proporciona
      if (company_id) {
        const company = await CompanyRepository.findById(company_id);
        if (!company) {
          logger.warn(`${req.user?.user || 'Unknown'} - company_id ${company_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `La empresa con ID ${company_id} no existe`
          });
        }
      }

      // ✅ VALIDAR user_id si se proporciona
      if (user_id) {
        const user = await UserRepository.findById(user_id);
        if (!user) {
          logger.warn(`${req.user?.user || 'Unknown'} - user_id ${user_id} no encontrado`);
          return res.status(404).json({
            success: false,
            error: `El usuario con ID ${user_id} no existe`
          });
        }
      }

      const filters = {
        from,
        to,
        marketplace,
        company_id: company_id ? parseInt(company_id) : null,
        user_id: user_id ? parseInt(user_id) : null
      };

      const stats = await MarketplaceReportingService.getProfitStats(filters);

      logger.info(`${req.user?.user || 'Unknown'} - Estadísticas de ganancias generadas exitosamente`);
      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('[MarketplaceReportController] Error en profitStats: ' + error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
};

module.exports = MarketplaceReportController;
