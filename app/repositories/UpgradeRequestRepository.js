const { UpgradeRequest, Plan, User, sequelize } = require("../models");
const { Op } = require("sequelize");
const logger = require("../../config/logger");

const UpgradeRequestRepository = {
  async findFiltered({ company_id, status, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;
  const where = {};
  if (company_id !== undefined) where.company_id = company_id;
  if (status !== undefined) where.status = status;

  const { count, rows } = await UpgradeRequest.findAndCountAll({
    where,
    include: [
      {
        model: User,
        as: 'user',
        attributes: ['name', 'image'],
        required: false
      },
      {
        model: Plan,
        as: 'currentPlan',
        attributes: ['name'],
        required: false
      },
      {
        model: Plan,
        as: 'targetPlan',
        attributes: ['name'],
        required: false
      }
    ],
    attributes: ['id', 'company_id', 'user_id', 'current_plan_id', 'target_plan_id', 'billing_cycle', 'message', 'status', 'createdAt'],
    order: [['createdAt', 'DESC']],
    limit,
    offset
  });

  return {
    upgradeRequests: rows.map(req => ({
      id: req.id,
      company_id: req.company_id,
      requested_by_user_id: req.requested_by_user_id,
      current_plan_id: req.current_plan_id,
      target_plan_id: req.target_plan_id,
      billing_cycle: req.billing_cycle,
      message: req.message,
      status: req.status,
      createdAt: req.createdAt,
      // Datos del usuario
      user_name: req.user?.name || 'Usuario desconocido',
      user_image: req.user?.image || null,
      // Nombres de planes
      current_plan_name: req.currentPlan?.name || `Plan ${req.current_plan_id}`,
      target_plan_name: req.targetPlan?.name || `Plan ${req.target_plan_id}`
    })),
    total: count,
    page,
    totalPages: Math.ceil(count / limit)
  };
},

  async findById(id) {
    return await UpgradeRequest.findByPk(id);
  },

  async create(body, options = {}) {
    try {
      const request = await UpgradeRequest.create(body, options);
      logger.info(`Solicitud de upgrade creada (ID: ${request.id})`);
      return request;
    } catch (error) {
      logger.error("Error en UpgradeRequestRepository->create:", error);
      throw new Error(`Error al crear solicitud de upgrade: ${error.message}`);
    }
  },

  async update(upgradeRequest, body, options = {}) {
    try {
      const { status } = body;
      await upgradeRequest.update({ status }, options);
      logger.info(`Solicitud de upgrade actualizada (ID: ${upgradeRequest.id})`);
      return upgradeRequest;
    } catch (error) {
      logger.error(`Error en UpgradeRequestRepository->update (ID: ${upgradeRequest.id}):`, error);
      throw new Error(`Error al actualizar solicitud de upgrade: ${error.message}`);
    }
  },

  async delete(upgradeRequest, options = {}) {
    await upgradeRequest.destroy(options);
    logger.info(`Solicitud de upgrade eliminada (ID: ${upgradeRequest.id})`);
    return true;
  }
};

module.exports = UpgradeRequestRepository;