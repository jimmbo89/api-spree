'use strict';

const logger = require('../../config/logger');
const MarketplaceImportService = require('../services/MarketplaceImportService');
const { getRequestMetadata } = require('../util/requestUtil');

function resolveCompanyId(req, body = {}) {
  const value = req.companyId
    || (req.user?.role_id ? body.company_id : req.user?.company_id)
    || body.company_id;
  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function sendError(res, error) {
  return res.status(Number(error.statusCode) || 500).json({
    success: false,
    code: error.code || 'marketplace_import_error',
    message: error.message || 'No se pudo procesar la importación'
  });
}

function logMarketplaceImportRequest(req, endpoint) {
  const user = req.user || {};
  const userName = user.name || user.email || user.user || 'Anonymous';
  const companyId = req.companyId || req.body?.company_id || user.company_id || 'N/A';

  logger.info(`[MarketplaceImport] ${userName} (user_id=${user.id || 'N/A'}) - ${endpoint} - ${req.method} ${req.originalUrl} - company_id=${companyId}`);
  logger.info('[MarketplaceImport] Datos recibidos (body):');
  logger.info(JSON.stringify(req.body || {}));
}

const MarketplaceImportController = {
  async start(req, res) {
    logMarketplaceImportRequest(req, 'start');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId) return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });

      const operation = await MarketplaceImportService.start({
        previewId: req.body.preview_id,
        companyId,
        user: req.user,
        items: req.body.items,
        requestMetadata: getRequestMetadata(req)
      });
      return res.status(202).json({ success: true, data: operation });
    } catch (error) {
      return sendError(res, error);
    }
  },

  async status(req, res) {
    logMarketplaceImportRequest(req, 'status');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId && !req.user?.role_id) return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      const operation = await MarketplaceImportService.status({
        operationId: req.body.import_id,
        companyId,
        user: req.user
      });
      return res.status(200).json({ success: true, data: operation });
    } catch (error) {
      return sendError(res, error);
    }
  },

  async items(req, res) {
    logMarketplaceImportRequest(req, 'items');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId && !req.user?.role_id) return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      const result = await MarketplaceImportService.items({
        operationId: req.body.import_id,
        companyId,
        user: req.user,
        cursor: req.body.cursor,
        limit: req.body.limit
      });
      return res.status(200).json({ success: true, data: result });
    } catch (error) {
      return sendError(res, error);
    }
  },

  async cancel(req, res) {
    logMarketplaceImportRequest(req, 'cancel');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId && !req.user?.role_id) return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      const operation = await MarketplaceImportService.cancel({
        operationId: req.body.import_id,
        companyId,
        user: req.user
      });
      return res.status(200).json({ success: true, data: operation });
    } catch (error) {
      return sendError(res, error);
    }
  }
};

module.exports = MarketplaceImportController;
