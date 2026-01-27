const { Subscription, sequelize } = require("../models");
const { Op } = require("sequelize");
const logger = require("../../config/logger");

const SubscriptionRepository = {
  async findFiltered({ company_id, plan_id, status, page = 1, limit = 20 }) {
    const offset = (page - 1) * limit;
    const where = {};
    if (company_id !== undefined) where.company_id = company_id;
    if (plan_id !== undefined) where.plan_id = plan_id;
    if (status !== constexpr) where.status = status;

    const { count, rows } = await Subscription.findAndCountAll({
      where,
      attributes: ['id', 'company_id', 'plan_id', 'status', 'start_date', 'end_date', 'renewal_date', 'billing_cycle', 'createdAt', 'updatedAt'],
      order: [['createdAt', 'DESC']],
      limit,
      offset
    });

    return {
      subscriptions: rows,
      total: count,
      page,
      totalPages: Math.ceil(count / limit)
    };
  },

  async findById(id) {
    return await Subscription.findByPk(id);
  },

  async create(body, options = {}) {
    try {
      const subscription = await Subscription.create(body, options);
      logger.info(`Suscripción creada para compañía ${body.company_id} (ID: ${subscription.id})`);
      return subscription;
    } catch (error) {
      logger.error("Error en SubscriptionRepository->create:", error);
      throw new Error(`Error al crear suscripción: ${error.message}`);
    }
  },

  async update(subscription, body, options = {}) {
    try {
      const fieldsToUpdate = ["company_id", "plan_id", "status", "start_date", "end_date", "renewal_date", "billing_cycle"];
      const updatedData = {};

      for (const key of fieldsToUpdate) {
        if (body[key] !== undefined) updatedData[key] = body[key];
      }

      await subscription.update(updatedData, options);
      logger.info(`Suscripción actualizada (ID: ${subscription.id})`);
      return subscription;
    } catch (error) {
      logger.error(`Error en SubscriptionRepository->update (ID: ${subscription.id}):`, error);
      throw new Error(`Error al actualizar suscripción: ${error.message}`);
    }
  },

  async delete(subscription, options = {}) {
    await subscription.destroy(options);
    logger.info(`Suscripción eliminada (ID: ${subscription.id})`);
    return true;
  }
};

module.exports = SubscriptionRepository;