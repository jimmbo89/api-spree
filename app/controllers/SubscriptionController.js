const logger = require("../../config/logger");
const { SubscriptionRepository, CompanyRepository, PlanRepository } = require("../repositories");
const { sequelize } = require('../models');

const SubscriptionController = {
  async index(req, res) {
    try {
      const { company_id, plan_id, status, page, limit } = req.body;
      const result = await SubscriptionRepository.findFiltered({ company_id, plan_id, status, page, limit });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      logger.error("SubscriptionController->index: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async show(req, res) {
    try {
      const subscription = await SubscriptionRepository.findById(req.body.id);
      if (!subscription) return res.status(404).json({ success: false, message: "Suscripción no encontrada" });
      return res.status(200).json({ success: true, subscription });
    } catch (err) {
      logger.error("SubscriptionController->show: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Crea suscripción`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const { company_id, plan_id, status, start_date, end_date, renewal_date, billing_cycle } = req.body;

    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({ success: false, message: "Compañía no encontrada" });
    }

    const plan = await PlanRepository.findById(plan_id);
    if (!plan) {
      return res.status(404).json({ success: false, message: "Plan no encontrado" });
    }

    const t = await sequelize.transaction();
    try {
      const subscription = await SubscriptionRepository.create({
        company_id, plan_id, status, start_date, end_date, renewal_date, billing_cycle
      }, t);
      await t.commit();

      return res.status(201).json({
        success: true,
        subscription,
        message: "Suscripción creada correctamente"
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("SubscriptionController->store: " + err.message);
      return res.status(500).json({ success: false, message: "Error al crear suscripción", details: err.message });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Edita suscripción con ID ${req.body.id}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const { id, company_id, plan_id, status, start_date, end_date, renewal_date, billing_cycle } = req.body;

    const subscription = await SubscriptionRepository.findById(id);
    if (!subscription) return res.status(404).json({ success: false, message: "Suscripción no encontrada" });

    // Validar compañía y plan si se envían
    if (company_id !== undefined) {
      const company = await CompanyRepository.findById(company_id);
      if (!company) return res.status(404).json({ success: false, message: "Compañía no encontrada" });
    }
    if (plan_id !== undefined) {
      const plan = await PlanRepository.findById(plan_id);
      if (!plan) return res.status(404).json({ success: false, message: "Plan no encontrado" });
    }

    const t = await sequelize.transaction();
    try {
      const updatedSubscription = await SubscriptionRepository.update(subscription, {
        company_id, plan_id, status, start_date, end_date, renewal_date, billing_cycle
      }, t);
      await t.commit();

      return res.status(200).json({
        success: true,
        subscription: updatedSubscription,
        message: "Suscripción actualizada correctamente"
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("SubscriptionController->update: " + err.message);
      return res.status(500).json({ success: false, message: "Error al actualizar suscripción", details: err.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Elimina suscripción con ID ${req.body.id}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    try {
      const subscription = await SubscriptionRepository.findById(req.body.id);
      if (!subscription) return res.status(404).json({ success: false, message: "Suscripción no encontrada" });
      await SubscriptionRepository.delete(subscription);
      return res.status(200).json({ success: true, message: "Suscripción eliminada correctamente" });
    } catch (err) {
      logger.error("SubscriptionController->destroy: " + err.message);
      return res.status(500).json({ success: false, message: "Error al eliminar suscripción", details: err.message });
    }
  }
};

module.exports = SubscriptionController;