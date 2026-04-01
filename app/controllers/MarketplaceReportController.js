const MarketplaceReportingService = require('../services/MarketplaceReportingService');
const logger = require('../../config/logger');

const MarketplaceReportController = {
  /**
   * GET /api/reports/sales
   * Reporte de ventas
   */
  async sales(req, res) {
    try {
      const filters = {
        from: req.query.from,
        to: req.query.to,
        marketplace: req.query.marketplace,
        status: req.query.status,
        company_id: req.query.company_id ? parseInt(req.query.company_id) : null,
        user_id: req.query.user_id ? parseInt(req.query.user_id) : null,
        limit: req.query.limit ? parseInt(req.query.limit) : 50,
        offset: req.query.offset ? parseInt(req.query.offset) : 0
      };

      const report = await MarketplaceReportingService.getSalesReport(filters);

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('[ReportController] Error en sales:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /api/reports/commissions
   * Reporte de comisiones
   */
  async commissions(req, res) {
    try {
      const filters = {
        from: req.query.from,
        to: req.query.to,
        marketplace: req.query.marketplace,
        status: req.query.status,
        company_id: req.query.company_id ? parseInt(req.query.company_id) : null,
        fee_type: req.query.fee_type || 'commission',
        limit: req.query.limit ? parseInt(req.query.limit) : 50,
        offset: req.query.offset ? parseInt(req.query.offset) : 0
      };

      const report = await MarketplaceReportingService.getCommissionReport(filters);

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('[ReportController] Error en commissions:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /api/reports/profits
   * Reporte de ganancias
   */
  async profits(req, res) {
    try {
      const filters = {
        from: req.query.from,
        to: req.query.to,
        marketplace: req.query.marketplace,
        company_id: req.query.company_id ? parseInt(req.query.company_id) : null,
        user_id: req.query.user_id ? parseInt(req.query.user_id) : null
      };

      const groupBy = req.query.group_by || 'marketplace';

      const report = await MarketplaceReportingService.getProfitReport(filters, groupBy);

      res.json({
        success: true,
        data: report
      });
    } catch (error) {
      logger.error('[ReportController] Error en profits:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /api/reports/sales/stats
   * Estadísticas de ventas
   */
  async salesStats(req, res) {
    try {
      const filters = {
        from: req.query.from,
        to: req.query.to,
        marketplace: req.query.marketplace,
        company_id: req.query.company_id ? parseInt(req.query.company_id) : null,
        user_id: req.query.user_id ? parseInt(req.query.user_id) : null
      };

      const stats = await MarketplaceReportingService.getSalesStats(filters);

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('[ReportController] Error en salesStats:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /api/reports/commissions/stats
   * Estadísticas de comisiones
   */
  async commissionStats(req, res) {
    try {
      const filters = {
        from: req.query.from,
        to: req.query.to,
        marketplace: req.query.marketplace,
        company_id: req.query.company_id ? parseInt(req.query.company_id) : null,
        fee_type: req.query.fee_type || 'commission'
      };

      const stats = await MarketplaceReportingService.getCommissionStats(filters);

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('[ReportController] Error en commissionStats:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  },

  /**
   * GET /api/reports/profits/stats
   * Estadísticas de ganancias
   */
  async profitStats(req, res) {
    try {
      const filters = {
        from: req.query.from,
        to: req.query.to,
        marketplace: req.query.marketplace,
        company_id: req.query.company_id ? parseInt(req.query.company_id) : null,
        user_id: req.query.user_id ? parseInt(req.query.user_id) : null
      };

      const stats = await MarketplaceReportingService.getProfitStats(filters);

      res.json({
        success: true,
        data: stats
      });
    } catch (error) {
      logger.error('[ReportController] Error en profitStats:', error.message);
      res.status(500).json({
        success: false,
        error: error.message
      });
    }
  }
};

module.exports = MarketplaceReportController;
