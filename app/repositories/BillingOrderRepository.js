const { BillingOrder, Plan, Company, sequelize } = require("../models");
const { Op } = require("sequelize");
const logger = require("../../config/logger");
const ImageService = require("../services/ImageService");
const FileService = require("../services/FileService");
const DEFAULT_PROOF_URL = 'billingorders/default.jpg';

const BillingOrderRepository = {
 async findFiltered({ company_id, status, type, page = 1, limit = 20 }) {
  const offset = (page - 1) * limit;
  const where = {};
  if (company_id !== undefined) where.company_id = company_id;
  if (status !== undefined) where.status = status;
  if (type !== undefined) where.type = type;

  const { count, rows } = await BillingOrder.findAndCountAll({
    where,
    include: [
      {
        model: Plan,
        as: 'currentPlan',
        required: false
      },
      {
        model: Plan,
        as: 'targetPlan',
        required: false
      },
      {
        model: Company,
        as: 'company',
        required: false
      },
    ],
    attributes: [
      'id', 'company_id', 'current_plan_id', 'target_plan_id', 'billing_cycle', 'type',
      'status', 'total_amount', 'currency', 'payment_method', 'payment_link_url',
      'proof_url', 'invoice_request', 'effective_date', 'paid_at', 'createdAt', 'updatedAt'
    ],
    order: [['createdAt', 'DESC']],
    limit,
    offset
  });

  return {
    billingOrders: rows.map(order => ({
      id: order.id,
      company_id: order.company_id,
      current_plan_id: order.current_plan_id,
      target_plan_id: order.target_plan_id,
      billing_cycle: order.billing_cycle,
      type: order.type,
      status: order.status,
      total_amount: order.total_amount,
      currency: order.currency,
      payment_method: order.payment_method,
      payment_link_url: order.payment_link_url,
      proof_url: order.proof_url,
      invoice_request: typeof order.invoice_request === 'string'
        ? JSON.parse(order.invoice_request || '{}')
        : order.invoice_request || {},
      effective_date: order.effective_date,
      paid_at: order.paid_at,
      createdAt: order.createdAt,
      updatedAt: order.updatedAt,
      // Nombres de planes
      current_plan_name: order.currentPlan?.name || `Plan ${order.current_plan_id}`,
      target_plan_name: order.targetPlan?.name || `Plan ${order.target_plan_id}`,
      company: order.company
    })),
    total: count,
    page,
    totalPages: Math.ceil(count / limit)
  };
},

  async findById(id) {
    const order = await BillingOrder.findByPk(id, {
      include: [{ model: Company, as: 'company' }, { model: Plan, as: 'targetPlan' }]
    });
    return order;
  },

  async create(body, file, options = {}) {
    try {
      body.proof_url = DEFAULT_PROOF_URL;
      const orderData = { ...body };
      if (typeof body.invoice_request === 'object') {
        orderData.invoice_request = body.invoice_request;
      }

      const order = await BillingOrder.create(orderData, options);
       if (file) {
        //const filename = `${company.id}${ext}`;
        const filename = FileService.generateFilename('billingorders', order.id, file.originalname);
        const relativePath = await FileService.moveFile(file, filename);
        await order.update({ proof_url: relativePath }, options);
      }
      logger.info(`Orden de facturación creada (ID: ${order.id})`);
      return order;
    } catch (error) {
      logger.error("Error en BillingOrderRepository->create:", error);
      throw new Error(`Error al crear orden de facturación: ${error.message}`);
    }
  },

  async update(billingOrder, body, options = {}) {
    try {
      const fieldsToUpdate = [
        "status", "paid_at", "proof_url", "payment_link_url", "invoice_request"
      ];
      const updatedData = {};

      for (const key of fieldsToUpdate) {
        if (body[key] !== undefined) {
          if (key === 'invoice_request' && typeof body[key] === 'object') {
            updatedData[key] = body[key];
          } else {
            updatedData[key] = body[key];
          }
        }
      }

      await billingOrder.update(updatedData, options);
      logger.info(`Orden de facturación actualizada (ID: ${billingOrder.id})`);
      return billingOrder;
    } catch (error) {
      logger.error(`Error en BillingOrderRepository->update (ID: ${billingOrder.id}):`, error);
      throw new Error(`Error al actualizar orden de facturación: ${error.message}`);
    }
  },

  async delete(billingOrder, options = {}) {
    await billingOrder.destroy(options);
    logger.info(`Orden de facturación eliminada (ID: ${billingOrder.id})`);
    return true;
  }
};

module.exports = BillingOrderRepository;