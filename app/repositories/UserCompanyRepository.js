// app/repositories/UserCompanyRepository.js
const { UserCompany, User, Company, Role } = require('../models');
const logger = require('../../config/logger');

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

const UserCompanyRepository = {
  async findByPk(id) {
    try {
      return await UserCompany.findByPk(id);
    } catch (error) {
      logger.error(`Error al buscar membresía por ID ${id}:`, error);
      throw new Error(`Error al buscar membresía: ${error.message}`);
    }
  },

  async findByUserIdAndCompanyId(user_id, company_id) {
    try {
      return await UserCompany.findOne({ where: { user_id, company_id } });
    } catch (error) {
      logger.error(`Error al buscar membresía por usuario ${user_id} y empresa ${company_id}:`, error);
      throw new Error(`Error al buscar membresía: ${error.message}`);
    }
  },

  async findByInvitationToken(token) {
    try {
      return await UserCompany.findOne({ where: { invitation_token: token } });
    } catch (error) {
      logger.error(`Error al buscar membresía por token:`, error);
      throw new Error(`Error al buscar membresía por token: ${error.message}`);
    }
  },

  async create(data) {
    try {
      const record = await UserCompany.create(data);
      const populated = await UserCompany.findByPk(record.id, {
        include: [
          { model: User, as: 'user' },
          { model: Company, as: 'company' },
          { model: Role, as: 'role' }
        ]
      });
      return mapUserCompany(populated);
    } catch (error) {
      logger.error('Error al crear membresía usuario-empresa:', error);
      throw new Error(`Error al crear membresía: ${error.message}`);
    }
  },

  async updateStatus(record, status) {
    try {
      const updated = await record.update({ status });
      const populated = await UserCompany.findByPk(updated.id, {
        include: [
          { model: User, as: 'user' },
          { model: Company, as: 'company' },
          { model: Role, as: 'role' }
        ]
      });
      return mapUserCompany(populated);
    } catch (error) {
      logger.error(`Error al actualizar estado de membresía ID ${record.id}:`, error);
      throw new Error(`Error al actualizar membresía: ${error.message}`);
    }
  },

  async delete(record) {
    try {
      return await record.destroy();
    } catch (error) {
      logger.error(`Error al eliminar membresía ID ${record.id}:`, error);
      throw new Error(`Error al eliminar membresía: ${error.message}`);
    }
  },

  async getMemberships({ user_id, company_id, status = null }) {
  const where = {};
  if (user_id !== undefined) where.user_id = user_id;
  if (company_id !== undefined) where.company_id = company_id;
  if (status !== null) where.status = status;

  try {
    const records = await UserCompany.findAll({
      where,
      include: [
        { model: User, as: 'user' },
        { model: Company, as: 'company' },
        { model: Role, as: 'role' }
      ],
      order: [['id', 'ASC']]
    });
    return records.map(mapUserCompany);
  } catch (error) {
    logger.error(`Error al obtener membresías con filtros: user=${user_id}, company=${company_id}`, error);
    throw new Error(`Error al obtener membresías: ${error.message}`);
  }
}
};

module.exports = UserCompanyRepository;