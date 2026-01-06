// app/controllers/PlanController.js
const logger = require("../../config/logger");
const { PlanRepository } = require("../repositories");
const { Plan } = require("../models"); // ← necesario para findByPk

const PlanController = {
  async index(req, res) {
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
      sort_order
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
      sort_order
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
      sort_order
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
      sort_order
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