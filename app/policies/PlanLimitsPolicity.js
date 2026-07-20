
const logger = require('../../config/logger');
const { WarehouseRepository, MarketplaceCredentialRepository, CompanyRepository, BranchRepository, PoolRepository, WarehouseProductRepository } = require('../repositories');
const { getUserId } = require('../../config/context');

const normalizePlanLimit = (value) => {
  if (value === null || value === undefined || value === '') {
    return -1;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : -1;
};

/**
 * Política para verificar límites de plan antes de crear un recurso
 * @param {string} resourceType - 'branch', 'store', 'pool', 'publication'
 */
const checkPlanLimit = (resourceType) => {
  return async (req, res, next) => {
    try {
      const companyId = req.headers['x-company-id'] || req.body.company_id;
      const user_id = getUserId();
      
      if (!companyId) {
        return res.status(400).json({
          success: false,
          message: "Se requiere company_id para verificar límites de plan"
        });
      }

      // 1. Obtener empresa y plan vía repositorio
      const company = await CompanyRepository.findById(companyId);
      if (!company || !company.plan) {
        return res.status(404).json({
          success: false,
          message: "Empresa o plan no encontrado"
        });
      }

      const plan = company.plan;
      let currentCount = 0;
      let maxLimit = -1;
      let resourceName = '';

      // 2. Contar recursos usando REPOSITORIOS
      switch (resourceType) {
        case 'branch':
          currentCount = await BranchRepository.countByCompanyId(companyId, { where: { status: true } });
          maxLimit = normalizePlanLimit(plan.max_branches);
          resourceName = 'sucursales';
          break;
          
        case 'warehouse':
          currentCount = await WarehouseRepository.countByCompanyId(companyId);
          maxLimit = normalizePlanLimit(plan.max_stores);
          resourceName = 'almacenes';
          break;
        
        case 'product':
          currentCount = await WarehouseProductRepository.countUniqueProductsByCompanyId(companyId);
          maxLimit = plan.max_products; // 👈 Asegúrate de que tu modelo Plan tenga este campo
          resourceName = 'productos';
          break;
          
        case 'pools':
          currentCount = await PoolRepository.countByCompanyId(companyId);
          maxLimit = plan.max_pools;
          resourceName = 'pools';
          break;
          
        case 'marketplaces':
          currentCount = await MarketplaceCredentialRepository.countActiveByMarketplace(companyId); // excluye borradores
          maxLimit = plan.max_integrations;
          resourceName = 'marketplaces';
          break;
          
        default:
          return res.status(400).json({
            success: false,
            message: "Tipo de recurso no soportado"
          });
      }

      // 3. Verificar límite
      logger.info(`[checkPlanLimit:${resourceType}] company=${companyId} current=${currentCount} limit=${maxLimit}`);

      if (maxLimit !== -1 && currentCount >= maxLimit) {
        return res.status(403).json({
          success: false,
          code: 'PLAN_LIMIT_REACHED',
          message: `Has alcanzado el límite máximo de ${resourceName} permitidas por tu plan actual. Para agregar más, debes actualizar tu plan.`,
          limit: maxLimit,
          current: currentCount
        });
      }

      next();
    } catch (error) {
      logger.error(`Error en política checkPlanLimit (${resourceType}):`, error);
      return res.status(500).json({
        success: false,
        message: "Error al verificar límites de plan"
      });
    }
  };
};

module.exports = { checkPlanLimit };
