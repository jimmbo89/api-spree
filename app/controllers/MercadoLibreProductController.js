'use strict';

const logger = require('../../config/logger');
const MercadoLibreProductService = require('../services/MercadoLibreProductService');

function resolveCompanyId(req) {
  const value = req.companyId
    || req.headers['x-company-id']
    || req.user?.company_id
    || req.body?.company_id;

  const companyId = Number(value);
  return Number.isInteger(companyId) && companyId > 0 ? companyId : null;
}

const MercadoLibreProductController = {
  async getProduct(req, res) {
    const companyId = resolveCompanyId(req);
    const productId = String(req.body?.product_id || '').trim();

    logger.info('[MercadoLibreProduct] Consulta de producto de catálogo', {
      user_id: req.user?.id || null,
      company_id: companyId,
      product_id: productId,
      credential_id: req.body?.credential_id || null
    });

    try {
      const result = await MercadoLibreProductService.getProduct({
        productId,
        resource: req.body?.resource,
        credentialId: req.body?.credential_id,
        companyId,
        user: req.user
      });

      return res.status(200).json({
        success: true,
        data: result
      });
    } catch (error) {
      const statusCode = Number(error.statusCode) || 500;
      const response = {
        success: false,
        code: error.code || 'mercadolibre_product_error',
        message: error.message || 'No se pudo consultar el producto en Mercado Libre'
      };

      if (error.details) response.details = error.details;

      logger.error('[MercadoLibreProduct] Error en consulta', {
        user_id: req.user?.id || null,
        company_id: companyId,
        product_id: productId,
        status_code: statusCode,
        code: response.code,
        message: response.message
      });

      return res.status(statusCode).json(response);
    }
  }
};

module.exports = MercadoLibreProductController;
