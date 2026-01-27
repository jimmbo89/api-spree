const logger = require("../../config/logger");
const { BillingOrderRepository, CompanyRepository, PlanRepository } = require("../repositories");
const { sequelize } = require('../models');

const BillingOrderController = {
  async index(req, res) {
    try {
      const { company_id, status, type, page, limit } = req.body;
      const result = await BillingOrderRepository.findFiltered({ company_id, status, type, page, limit });
      return res.status(200).json({ success: true, ...result });
    } catch (err) {
      logger.error("BillingOrderController->index: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async show(req, res) {
    try {
      const order = await BillingOrderRepository.findById(req.body.id);
      if (!order) return res.status(404).json({ success: false, message: "Orden de facturación no encontrada" });
      return res.status(200).json({ success: true, billingOrder: order });
    } catch (err) {
      logger.error("BillingOrderController->show: " + err.message);
      return res.status(500).json({ success: false, message: "Error interno del servidor", details: err.message });
    }
  },

  async store(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Crea orden de facturación`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const {
      company_id, current_plan_id, target_plan_id, billing_cycle, type,
      total_amount, currency, payment_method, payment_link_url, proof_url,
      invoice_request, effective_date
    } = req.body;

    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(404).json({ success: false, message: "Compañía no encontrada" });
    }

    const currentPlan = await PlanRepository.findById(current_plan_id);
    if (!currentPlan) {
      return res.status(404).json({ success: false, message: "Plan actual no encontrado" });
    }

    const targetPlan = await PlanRepository.findById(target_plan_id);
    if (!targetPlan) {
      return res.status(404).json({ success: false, message: "Plan objetivo no encontrado" });
    }

    // Validar que ya no exista una orden pendiente equivalente
    // (MVP: omitido por simplicidad, pero puedes agregarlo)

    const t = await sequelize.transaction();
    try {
      const order = await BillingOrderRepository.create({
        company_id, current_plan_id, target_plan_id, billing_cycle, type,
        total_amount, currency, payment_method, payment_link_url, proof_url,
        invoice_request, effective_date
      }, t);
      await t.commit();

      return res.status(201).json({
        success: true,
        billingOrder: order,
        message: "Orden de facturación creada correctamente"
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("BillingOrderController->store: " + err.message);
      return res.status(500).json({ success: false, message: "Error al crear orden de facturación", details: err.message });
    }
  },

  async update(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Actualiza orden de facturación con ID ${req.body.id}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    const { id, status, paid_at, proof_url } = req.body;

    const order = await BillingOrderRepository.findById(id);
    if (!order) return res.status(404).json({ success: false, message: "Orden de facturación no encontrada" });

    const t = await sequelize.transaction();
    try {
      const updatedOrder = await BillingOrderRepository.update(order, { status, paid_at, proof_url }, t);
      await t.commit();

      return res.status(200).json({
        success: true,
        billingOrder: updatedOrder,
        message: "Orden de facturación actualizada correctamente"
      });
    } catch (err) {
      if (t && !t.finished) await t.rollback();
      logger.error("BillingOrderController->update: " + err.message);
      return res.status(500).json({ success: false, message: "Error al actualizar orden de facturación", details: err.message });
    }
  },

  async destroy(req, res) {
    logger.info(`${req.user?.user || 'Anonymous'} - Elimina orden de facturación con ID ${req.body.id}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));

    try {
      const order = await BillingOrderRepository.findById(req.body.id);
      if (!order) return res.status(404).json({ success: false, message: "Orden de facturación no encontrada" });
      await BillingOrderRepository.delete(order);
      return res.status(200).json({ success: true, message: "Orden de facturación eliminada correctamente" });
    } catch (err) {
      logger.error("BillingOrderController->destroy: " + err.message);
      return res.status(500).json({ success: false, message: "Error al eliminar orden de facturación", details: err.message });
    }
  }
};

module.exports = BillingOrderController;