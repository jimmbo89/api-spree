// app/repositories/PlanRepository.js
const { Plan } = require("../models");
const logger = require("../../config/logger");

// Función de mapeo reutilizable
function mapPlan(plan) {
  if (!plan) return null;
  return {
    id: plan.id,
    name: plan.name,
    description: plan.description,
    is_active: plan.is_active,
    max_products: plan.max_products,
    max_branches: plan.max_branches,
    max_stores: plan.max_stores,
    max_integrations: plan.max_integrations,
    max_global_publications: plan.max_global_publications,
    max_pools: plan.max_pools,
    has_tenant_marketplace: plan.has_tenant_marketplace,
    has_custom_domain: plan.has_custom_domain,
    has_multi_seller: plan.has_multi_seller,
    has_headless_api: plan.has_headless_api,
    ia_level: plan.ia_level,
    global_commission_rate: plan.global_commission_rate,
    sort_order: plan.sort_order
  };
}

const PlanRepository = {
  async findAll() {
    try {
      const plans = await Plan.findAll({
        order: [["sort_order", "ASC"], ["id", "ASC"]]
      });
      return plans.map(plan => mapPlan(plan));
    } catch (error) {
      logger.error("Error en PlanRepository->findAll:", error);
      throw new Error(`Error al obtener planes: ${error.message}`);
    }
  },

  async findById(id) {
    try {
      const plan = await Plan.findByPk(id);
      return plan;
    } catch (error) {
      logger.error(`Error en PlanRepository->findById (ID: ${id}):`, error);
      throw new Error(`Error al obtener el plan: ${error.message}`);
    }
  },

  async findByName(name) {
    try {
      if (!name) {
        throw new Error("El nombre del plan no puede estar vacío");
      }
      const plan = await Plan.findOne({ where: { name } });
      return mapPlan(plan);
    } catch (error) {
      logger.error(`Error en PlanRepository->findByName (Name: ${name}):`, error);
      throw new Error(`Error al obtener el plan por nombre: ${error.message}`);
    }
  },

  async create(data) {
    try {
      const plan = await Plan.create(data);
      logger.info(`Nuevo plan creado: ID ${plan.id}, nombre: ${plan.name}`);
      return mapPlan(plan);
    } catch (error) {
      logger.error("Error en PlanRepository->create:", error);
      throw new Error(`Error al crear plan: ${error.message}`);
    }
  },

  async update(plan, body) {
    const fieldsToUpdate = [
      'name',
      'description',
      'is_active',
      'max_products',
      'max_branches',
      'max_stores',
      'max_integrations',
      'max_global_publications',
      'max_pools',
      'has_tenant_marketplace',
      'has_custom_domain',
      'has_multi_seller',
      'has_headless_api',
      'ia_level',
      'global_commission_rate',
      'sort_order'
    ];

    const updatedData = {};
    for (const key of fieldsToUpdate) {
      if (body[key] !== undefined) {
        updatedData[key] = body[key];
      }
    }

    if (Object.keys(updatedData).length > 0) {
      await plan.update(updatedData);
      logger.info(`Plan actualizado (ID: ${plan.id})`);
    } else {
      logger.info(`Plan (ID: ${plan.id}) - No hay cambios para actualizar`);
    }

    return plan; // devuelve la instancia real de Sequelize
  },

  async delete(plan) {
    try {
      await plan.destroy();
      logger.info(`Plan eliminado (ID: ${plan.id})`);
      return { success: true, message: "Plan eliminado correctamente" };
    } catch (error) {
      logger.error(`Error en PlanRepository->delete (ID: ${plan.id}):`, error);
      throw new Error(`Error al eliminar plan: ${error.message}`);
    }
  }
};

module.exports = PlanRepository;