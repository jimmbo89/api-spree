// app/controllers/UserCompanyController.js
const logger = require('../../config/logger');
const { UserRepository, CompanyRepository, RoleRepository } = require('../repositories');
const UserCompanyRepository = require('../repositories/UserCompanyRepository');

const UserCompanyController = {
  async create(req, res) {
    const { user_id, company_id, role_id, status, invited_by, invitation_token, expires_at } = req.body;

    // Validación de existencia
    const user = await UserRepository.findById(user_id);
    if (!user) return res.status(400).json({ success: false, message: 'Usuario no encontrado' });

    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(400).json({ success: false, message: 'Empresa no encontrada' });

    const role = await RoleRepository.findById(role_id);
    if (!role) return res.status(400).json({ success: false, message: 'Rol no encontrado' });

    try {
      const membership = await UserCompanyRepository.create({
        user_id,
        company_id,
        role_id,
        status,
        invited_by: invited_by || null,
        invitation_token: invitation_token || null,
        expires_at: expires_at || null
      });
      return res.status(201).json({ success: true, membership, message: "Membresía creada correctamente" });
    } catch (error) {
      logger.error("UserCompanyController->create:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async updateStatus(req, res) {
    const { id, status } = req.body;
    const record = await UserCompanyRepository.findByPk(id);
    if (!record) return res.status(400).json({ success: false, message: 'Membresía no encontrada' });

    try {
      const updated = await UserCompanyRepository.updateStatus(record, status);
      return res.status(200).json({ success: true, membership: updated, message: "Estado de membresía actualizado" });
    } catch (error) {
      logger.error("UserCompanyController->updateStatus:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async destroy(req, res) {
    const { id } = req.body;
    const record = await UserCompanyRepository.findByPk(id);
    if (!record) return res.status(400).json({ success: false, message: 'Membresía no encontrada' });

    try {
      await UserCompanyRepository.delete(record);
      return res.status(200).json({ success: true, message: "Membresía eliminada" });
    } catch (error) {
      logger.error("UserCompanyController->destroy:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async findByUserAndCompany(req, res) {
    const { user_id, company_id } = req.body;
    try {
      const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user_id, company_id);
      if (!membership) {
        return res.status(404).json({ success: false, message: 'Membresía no encontrada' });
      }
      const populated = await UserCompany.findByPk(membership.id, {
        include: [
          { model: User, as: 'user' },
          { model: Company, as: 'company' },
          { model: Role, as: 'role' }
        ]
      });
      return res.status(200).json({ success: true, membership: mapUserCompany(populated) });
    } catch (error) {
      logger.error("UserCompanyController->findByUserAndCompany:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async findByToken(req, res) {
    const { invitation_token } = req.body;
    try {
      const membership = await UserCompanyRepository.findByInvitationToken(invitation_token);
      if (!membership) {
        return res.status(404).json({ success: false, message: 'Invitación no válida o expirada' });
      }
      const populated = await UserCompany.findByPk(membership.id, {
        include: [
          { model: Company, as: 'company' },
          { model: Role, as: 'role' }
        ]
      });
      return res.status(200).json({ success: true, membership: mapUserCompany(populated) });
    } catch (error) {
      logger.error("UserCompanyController->findByToken:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async listByCompany(req, res) {
    const { company_id, status } = req.body;
    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(400).json({ success: false, message: 'Empresa no encontrada' });

    try {
      const memberships = await UserCompanyRepository.getMembershipsByCompanyId(
        parseInt(company_id, 10),
        status !== undefined ? parseInt(status, 10) : null
      );
      return res.status(200).json({ success: true, memberships });
    } catch (error) {
      logger.error("UserCompanyController->listByCompany:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },
  async list(req, res) {
  const { user_id, company_id, status } = req.body;

  // Validaciones de existencia solo si se pasan los IDs
  if (user_id) {
    const user = await UserRepository.findById(user_id);
    if (!user) return res.status(400).json({ success: false, message: 'Usuario no encontrado' });
  }

  if (company_id) {
    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(400).json({ success: false, message: 'Empresa no encontrada' });
  }

  try {
    const memberships = await UserCompanyRepository.getMemberships({
      user_id: user_id ? parseInt(user_id, 10) : undefined,
      company_id: company_id ? parseInt(company_id, 10) : undefined,
      status: status !== undefined ? parseInt(status, 10) : null
    });

    return res.status(200).json({ success: true, memberships });
  } catch (error) {
    logger.error("UserCompanyController->list:", error.message);
    return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
  }
}
};

// Reutilizamos la función de mapeo del repositorio
function mapUserCompany(record) {
  if (!record) return null;
  return {
    id: record.id,
    user_id: record.user_id,
    company_id: record.company_id,
    role_id: record.role_id,
    status: record.status,
    joined_at: record.joined_at,
    invited_by: record.invited_by,
    invitation_token: record.invitation_token,
    expires_at: record.expires_at,
    user: record.user ? { id: record.user.id, name: record.user.name, email: record.user.email } : null,
    company: record.company ? { id: record.company.id, name: record.company.name } : null,
    role: record.role ? { id: record.role.id, name: record.role.name } : null
  };
}

module.exports = UserCompanyController;