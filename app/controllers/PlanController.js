// app/controllers/PlanController.js
const logger = require("../../config/logger");
const { PlanRepository, WarehouseRepository, WarehouseProductRepository, PoolRepository, CompanyRepository } = require("../repositories");
const { Plan } = require("../models"); // ← necesario para findByPk

const PlanController = {
  /*async index(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Solicita listado de planes`);

    try {
      const plans = await PlanRepository.findAll();
      return plans.length === 0
        ? res.status(204).json({ success: false, message: "NoPlansFound", plans: [] })
        : res.status(200).json({ success: true, plans: plans });
    } catch (err) {
      logger.error("PlanController->index: " + err.message);
      return res.status(500).json({ success: true, message: "Error interno del servidor", details: err.message });
    }
  },*/

  async index(req, res) {
  const userName = req.user?.name || 'Anonymous';
  logger.info(`${userName} - Solicita listado de planes`);
  logger.info(JSON.stringify(req.body))

  const { company_id, branch_id, include_stats = false } = req.body;

  try {
    const plans = await PlanRepository.findAll();

    if (plans.length === 0) {
      return res.status(204).json({ 
        success: false, 
        message: "NoPlansFound", 
        plans: [] 
      });
    }
    let company = null;
    let stats = null;

    // Si se solicitan estadísticas y se proporciona company_id
    if (include_stats && company_id) {
  try {
    const companyId = Number(company_id);
    const branchId = branch_id ? Number(branch_id) : undefined;

    if (!isNaN(companyId)) {
      // 1. Obtener compañía con su plan
      company = await CompanyRepository.findById(companyId);
      if (!company || !company.id) {
        return res.status(404).json({ 
          success: false, 
          message: "Compañía no encontrada", 
          plans: [] 
        });
      }

      if (!company.plan) {
        return res.status(400).json({ 
          success: false, 
          message: "La compañía no tiene un plan asignado", 
          plans: [] 
        });
      }

      // 2. Obtener almacenes
      const warehouses = await WarehouseRepository.findWarehousesByCompanyOrBranch(companyId, branchId);
      const warehouseCount = warehouses.length;

      // 3. Obtener productos (usando TU método)
      let productCount = 0;
      if (warehouseCount > 0) {
        const warehouseIds = warehouses.map(w => w.id);
        const countsByWarehouse = await WarehouseProductRepository.getCountsByWarehouse(warehouseIds);
        productCount = Object.values(countsByWarehouse)
          .reduce((sum, item) => sum + (item.productCount || 0), 0);
      }

      // 4. Obtener pools
      const pools = await PoolRepository.findByCompany(companyId);
      const poolCount = pools.length;

      // 5. Extraer límites del plan
      const getLimit = (value) => value === -1 ? -1 : (value || 0);

      const limits = {
        products: getLimit(company.plan.max_products),
        warehouses: getLimit(company.plan.max_stores),
        pools: getLimit(company.plan.max_pools),
        publications: getLimit(company.plan.max_global_publications)
      };

      // 6. Armar stats con used y limit
      stats = {
        products: { used: productCount, limit: limits.products },
        warehouses: { used: warehouseCount, limit: limits.warehouses },
        pools: { used: poolCount, limit: limits.pools },
        publications: { used: 0, limit: limits.publications}
      };
    }
  } catch (statsError) {
    logger.warn(`No se pudieron cargar estadísticas: ${statsError.message}`);
    // No fallamos la petición principal, solo omitimos stats
  }
}

    return res.status(200).json({ 
      success: true, 
      plans: plans,
      ...(stats ? { stats } : {}) // Solo incluye stats si existe
    });

  } catch (err) {
    logger.error("PlanController->index: " + err.message);
    return res.status(500).json({ 
      success: false, 
      message: "Error interno del servidor", 
      details: err.message 
    });
  }
},

  async store(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Crea nuevo plan`);
    logger.info("Datos recibidos al crear plan");
    logger.info(JSON.stringify(req.body));

    // 👇 Desglose explícito de atributos
    const {
      name,
      description,
      is_active,
      max_products,
      max_branches,
      max_stores,
      max_integrations,
      max_global_publications,
      max_pools,
      has_tenant_marketplace,
      has_custom_domain,
      has_multi_seller,
      has_headless_api,
      ia_level,
      global_commission_rate,
      sort_order,
      monthly_price,
      annual_price,
      monthly_discount,
      annual_discount
    } = req.body;

    const planData = {
      name,
      description,
      is_active,
      max_products,
      max_branches,
      max_stores,
      max_integrations,
      max_global_publications,
      max_pools,
      has_tenant_marketplace,
      has_custom_domain,
      has_multi_seller,
      has_headless_api,
      ia_level,
      global_commission_rate,
      sort_order,
      monthly_price,
      annual_price,
      monthly_discount,
      annual_discount
    };

    try {
      await PlanRepository.create(planData);
      const plans = await PlanRepository.findAll();
      return res.status(201).json({ success: true, plans: plans, message: "Plan creado correctamente" });
    } catch (err) {
      logger.error("PlanController->store: " + err.message);
      return res.status(500).json({ success: false, message: "Error nterno del servidor", details: err.message });
    }
  },

  async update(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Actualiza plan`);
    logger.info("Datos recibidos al actualizar plan");
    logger.info(JSON.stringify(req.body));

    // 👇 Desglose explícito
    const {
      id,
      name,
      description,
      is_active,
      max_products,
      max_branches,
      max_stores,
      max_integrations,
      max_global_publications,
      max_pools,
      has_tenant_marketplace,
      has_custom_domain,
      has_multi_seller,
      has_headless_api,
      ia_level,
      global_commission_rate,
      sort_order,
      monthly_price,
      annual_price,
      monthly_discount,
      annual_discount
    } = req.body;

    const bodyData = {
      name,
      description,
      is_active,
      max_products,
      max_branches,
      max_stores,
      max_integrations,
      max_global_publications,
      max_pools,
      has_tenant_marketplace,
      has_custom_domain,
      has_multi_seller,
      has_headless_api,
      ia_level,
      global_commission_rate,
      sort_order,
      monthly_price,
      annual_price,
      monthly_discount,
      annual_discount
    };

    try {
      // 👇 Obtenemos la instancia real de Sequelize
      const planInstance = await PlanRepository.findById(id);
      if (!planInstance) {
        return res.status(404).json({ success: true, plans:[], message: "PlanNotFound" });
      }

      await PlanRepository.update(planInstance, bodyData);
      const plans = await PlanRepository.findAll();
      return res.status(200).json({success: true, plans: plans, message: "Plan editado correctamente" });
    } catch (err) {
      logger.error("PlanController->update: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async destroy(req, res) {
    const userName = req.user?.name || 'Anonymous';
    logger.info(`${userName} - Elimina plan`);
    logger.info("Datos recibidos al eliminar plan");
    logger.info(JSON.stringify(req.body));
    const { id } = req.body;
    try {
      const planInstance = await PlanRepository.findById(id);
      if (!planInstance) {
        return res.status(404).json({success: false, message: "Plan no encontrado", plans: [] });
      }

      await PlanRepository.delete(planInstance);
      const plans = await PlanRepository.findAll();
      return res.status(200).json({success: true, message: "Plan eliminado correctamente", plans: plans });
    } catch (err) {
      logger.error("PlanController->destroy: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async show(req, res) {
    const userName = req.user?.name || 'Anonymous';
    const {id} = req.body;
    logger.info(`${userName} - Consulta plan ID ${id}`);
    logger.info("Datos recibidos al consultar plan");
    logger.info(JSON.stringify(req.body));

    try {
      const plan = await PlanRepository.findById(id);
      if (!plan) return res.status(404).json({success: false, message: "Plan no encontrado", plans: plan });
      return res.status(200).json({success: true, plans: plan });
    } catch (err) {
      logger.error("PlanController->show: " + err.message);
      return res.status(500).json({success: false, message: "Error interno del servido", details: err.message });
    }
  }
};

module.exports = PlanController;