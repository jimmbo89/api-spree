// app/controllers/UserAclScopeController.js
const logger = require('../../config/logger');
const { UserRepository, CompanyRepository, WarehouseRepository, PoolRepository, UserCompanyRepository } = require('../repositories');
const UserAclScopeRepository = require('../repositories/UserAclScopeRepository');

const UserAclScopeController = {
  async create(req, res) {
    const { user_id, company_id, warehouse_id, pool_id } = req.body;

    // 🔑 Validación crítica: verificar que la membresía existe y es válida
    const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user_id, company_id);
    if (!membership || ![0, 1].includes(membership.status)) { // -1 = pendiente, no debe tener ACL
      return res.status(400).json({ success: false, message: 'El usuario no pertenece a esta empresa' });
    }

    // Validar recursos
    if (warehouse_id) {
      const warehouse = await WarehouseRepository.findById(warehouse_id);
      if (!warehouse) return res.status(400).json({ success: false, message: 'Almacén no encontrado' });
    }
    if (pool_id) {
      const pool = await PoolRepository.findById(pool_id);
      if (!pool) return res.status(400).json({ success: false, message: 'Pool no encontrado' });
    }

    try {
      const scope = await UserAclScopeRepository.create({ user_id, company_id, warehouse_id, pool_id });
      return res.status(201).json({ success: true, scope, message: "Alcance ACL asignado correctamente" });
    } catch (error) {
      logger.error("UserAclScopeController->create:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async destroy(req, res) {
    const { id } = req.body;
    const record = await UserAclScopeRepository.findByPk(id);
    if (!record) return res.status(400).json({ success: false, message: 'Alcance ACL no encontrado' });

    try {
      await UserAclScopeRepository.delete(record);
      return res.status(200).json({ success: true, message: "Alcance ACL eliminado" });
    } catch (error) {
      logger.error("UserAclScopeController->destroy:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async listByUserAndCompany(req, res) {
    const { user_id, company_id } = req.body;
    try {
      const scopes = await UserAclScopeRepository.findByUserAndCompany(user_id, company_id);
      return res.status(200).json({ success: true, scopes });
    } catch (error) {
      logger.error("UserAclScopeController->listByUserAndCompany:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async clearByUserAndCompany(req, res) {
    const { user_id, company_id } = req.body;
    try {
      await UserAclScopeRepository.deleteAllByUserAndCompany(user_id, company_id);
      return res.status(200).json({ success: true, message: "Alcances ACL eliminados" });
    } catch (error) {
      logger.error("UserAclScopeController->clearByUserAndCompany:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  }
};

module.exports = UserAclScopeController;