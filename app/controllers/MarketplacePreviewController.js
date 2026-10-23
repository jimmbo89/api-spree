'use strict';

const logger = require('../../config/logger');
const MarketplacePreviewService = require('../services/MarketplacePreviewService');
const { getRequestMetadata } = require('../util/requestUtil');

function resolveCompanyId(req, body = {}) {
  const value = req.companyId
    || (req.user?.role_id ? body.company_id : req.user?.company_id)
    || body.company_id;
  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

function sendError(res, error) {
  const status = Number(error.statusCode) || 500;
  return res.status(status).json({
    success: false,
    code: error.code || 'marketplace_preview_error',
    message: error.message || 'No se pudo procesar la operación'
  });
}

function logMarketplacePreviewRequest(req, endpoint) {
  const user = req.user || {};
  const userName = user.name || user.email || user.user || 'Anonymous';
  const companyId = req.companyId || req.body?.company_id || user.company_id || 'N/A';

  logger.info(`[MarketplacePreview] ${userName} (user_id=${user.id || 'N/A'}) - ${endpoint} - ${req.method} ${req.originalUrl} - company_id=${companyId}`);
  logger.info('[MarketplacePreview] Datos recibidos (body):');
  logger.info(JSON.stringify(req.body || {}));
}

const MarketplacePreviewController = {
  async start(req, res) {
    logMarketplacePreviewRequest(req, 'start');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId) {
        return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      }

      const operation = await MarketplacePreviewService.start({
        credentialId: req.body.credential_id,
        companyId,
        user: req.user,
        options: req.body.options || {},
        requestMetadata: getRequestMetadata(req)
      });
      return res.status(202).json({ success: true, data: operation });
    } catch (error) {
      return sendError(res, error);
    }
  },

  async status(req, res) {
    logMarketplacePreviewRequest(req, 'status');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId && !req.user?.role_id) {
        return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      }

      const operation = await MarketplacePreviewService.status({
        operationId: req.body.preview_id,
        companyId,
        user: req.user
      });
      return res.status(200).json({ success: true, data: operation });
    } catch (error) {
      return sendError(res, error);
    }
  },

  async items(req, res) {
    logMarketplacePreviewRequest(req, 'items');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId && !req.user?.role_id) {
        return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      }

      const result = await MarketplacePreviewService.items({
        operationId: req.body.preview_id,
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

  async detail(req, res) {
    logMarketplacePreviewRequest(req, 'detail');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId && !req.user?.role_id) {
        return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      }

      const item = await MarketplacePreviewService.detail({
        operationId: req.body.preview_id,
        itemId: req.body.item_id,
        companyId,
        user: req.user,
        refresh: req.body.refresh,
        requestMetadata: getRequestMetadata(req)
      });
      return res.status(200).json({ success: true, data: item });
    } catch (error) {
      return sendError(res, error);
    }
  },

  async cancel(req, res) {
    logMarketplacePreviewRequest(req, 'cancel');
    try {
      const companyId = resolveCompanyId(req, req.body);
      if (!companyId && !req.user?.role_id) {
        return res.status(400).json({ success: false, code: 'company_id_required', message: 'company_id es requerido' });
      }

      const operation = await MarketplacePreviewService.cancel({
        operationId: req.body.preview_id,
        companyId,
        user: req.user,
        requestMetadata: getRequestMetadata(req)
      });
      return res.status(200).json({ success: true, data: operation });
    } catch (error) {
      return sendError(res, error);
    }
  }
};

module.exports = MarketplacePreviewController;
