// app/repositories/UserCompanyRepository.js
const { UserCompany, User, Company, Role, UserAclScope, Warehouse, Pool, Plan, Permission } = require('../models');
const logger = require('../../config/logger');
const { Op } = require('sequelize');
const bcrypt = require("bcrypt");

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

  async findPendingByUserId(userId, transaction = null) {
  return UserCompany.findOne({
    where: {
      user_id: userId,
      status: -1,
      invitation_token: { [Op.not]: null },
      expires_at: { [Op.gt]: new Date() }, // opcional: pre-filtrar vigentes
    },
    transaction,
  });
},

  // ✅ Buscar todas las membresías con filtros (para verificInvitation)
  async findAll(filters = {}) {
    const { company_id, status, user_id } = filters;
    const where = {};
    
    if (company_id) where.company_id = company_id;
    if (status !== undefined) where.status = status;
    if (user_id) where.user_id = user_id;
    
    return await UserCompany.findAll({
      where,
      include: [
        { model: User, as: 'user', attributes: ['id', 'name', 'email'] },
        { model: Company, as: 'company', attributes: ['id', 'name'] },
        { model: Role, as: 'role', attributes: ['id', 'name'] }
      ]
    });
  },

async findPendingByTokenAndCompany(plainToken, companyId, transaction = null, userId) {
  // Construir condición where
 const whereCondition = {
    status: -1,
    invitation_token: { [Op.not]: null },
    ...(companyId != null && { company_id: companyId }),
    ...(userId != null && { user_id: userId })
  };

  // Obtener todas las membresías pendientes con las relaciones necesarias
  const candidates = await UserCompany.findAll({
    where: whereCondition,
    include: [
      {
        model: Company,
        as: 'company',
        include: [{
          model: Plan,
          as: 'plan'
        }]
      },
      {
        model: Role,
        as: 'role'
      }
      // Nota: No incluimos 'user' ni 'inviter' si no los necesitas para este caso específico
    ],
    transaction,
  });

  // Luego comparamos cada token hasheado con el token plano recibido
  for (const membership of candidates) {
    const isMatch = await bcrypt.compare(plainToken, membership.invitation_token);
    if (isMatch) {
      return membership;
    }
  }

  return null; // No se encontró coincidencia
},

async activateMembership({ user_id, company_id }, transaction = null) {
  return UserCompany.update(
    {
      status: 1,
      joined_at: new Date(),
      invitation_token: null,     // ✅ buena práctica: limpiar token tras uso
      expires_at: null,
    },
    {
      where: {
        user_id,
        company_id,
        status: -1, // asegura que solo actualice si aún está pendiente
      },
      transaction,
    }
  );
},

  async findByInvitationToken(token) {
    try {
      return await UserCompany.findOne({ where: { invitation_token: token } });
    } catch (error) {
      logger.error(`Error al buscar membresía por token:`, error);
      throw new Error(`Error al buscar membresía por token: ${error.message}`);
    }
  },

  async create(data, transaction = null) {
  try {
    const record = await UserCompany.create(data, { transaction });
    return record;
  } catch (error) {
    logger.error('Error al crear membresía:', error);
    throw new Error(`Error al crear membresía: ${error.message}`);
  }
},

  async updateStatus(record, status) {
    try {
      return await record.update({ status });

    } catch (error) {
      logger.error(`Error al actualizar estado de membresía ID ${record.id}:`, error);
      throw new Error(`Error al actualizar membresía: ${error.message}`);
    }
  },

  // ✅ Actualizar membresía con soporte para transaction
  async update(record, data, transaction = null) {
    try {
      const updateData = {};
      if (data.role_id !== undefined) updateData.role_id = data.role_id;
      if (data.status !== undefined) updateData.status = data.status;
      if (data.invited_by !== undefined) updateData.invited_by = data.invited_by;
      if (data.invitation_token !== undefined) updateData.invitation_token = data.invitation_token;
      if (data.expires_at !== undefined) updateData.expires_at = data.expires_at;
      if (data.joined_at !== undefined) updateData.joined_at = data.joined_at;
      
      await record.update(updateData, { transaction });
      return record;
    } catch (error) {
      logger.error(`Error al actualizar membresía ID ${record.id}:`, error);
      throw new Error(`Error al actualizar membresía: ${error.message}`);
    }
  },

  async updateRole(record, role_id, transaction = null) {
    try {
      await record.update({ role_id }, { transaction});
       const updated = await record.reload({
      include: [
        {
          model: Role,
          as: 'role',
          attributes: ['id', 'name']
        }
      ],
      transaction
    });

    return updated;
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
},

  async getUsersByCompanyId(company_id) {
  try {
    // ✅ Filtrar usuarios excluyendo status 0 (desasociado)
    // status: -1 = pendiente (se incluye)
    // status: 0 = desasociado (NO se incluye)
    // status: 1 = activo (se incluye)
    // status: 2 = desactivado (se incluye)
    const memberships = await UserCompany.findAll({
      where: { 
        company_id, 
        status: { [Op.ne]: 0 } // ✅ Excluir solo desasociados
      },
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email', 'status', 'image', 'user'],
          // 👇 Incluir aclScopes DENTRO del User
          include: [
            {
              model: UserAclScope,
              as: 'aclScopes',
              attributes: [], // solo usamos para joins
              where: { company_id }, // ⚠️ muy importante: filtrar por empresa
              required: false,
              include: [
                {
                  model: Warehouse,
                  as: 'warehouse',
                  attributes: ['id', 'name', 'code', 'address', 'city', 'country', 'status'],
                  required: false
                },
                {
                  model: Pool,
                  as: 'pool',
                  attributes: ['id', 'name', 'description', 'is_active'],
                  required: false
                }
              ]
            }
          ]
        },
        {
          model: Role,
          as: 'role',
          attributes: ['id', 'name']
        }
      ],
      order: [['id', 'ASC']]
    });

    return memberships.map(m => {
      const user = m.user;
      const warehouses = user.aclScopes
        .map(s => s.warehouse)
        .filter(w => w !== null);

      const pools = user.aclScopes
        .map(s => s.pool)
        .filter(p => p !== null);

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        user: user.user,
        image: user.image,
        user_status: user.status,
        membership_id: m.id,
        membership_status: m.status,
        role_id: m.role.id,
        role_name: m.role.name,
        company_id: m.company_id,
        warehouses,
        pools,
        has_full_access: warehouses.length === 0 && pools.length === 0
      };
    });
  } catch (error) {
    logger.error(`Error al obtener usuarios de la empresa ${company_id}:`, error);
    throw new Error(`Error al obtener usuarios: ${error.message}`);
  }
},

async getAvailableCompaniesForUser(user_id) {
  try {
    // Paso 1: Obtener IDs de empresas ya asociadas al usuario (con cualquier status)
    const associatedCompanyIds = (
      await UserCompany.findAll({
        where: { user_id: parseInt(user_id, 10) },
        attributes: ['company_id'],
        raw: true
      })
    ).map(record => record.company_id);

    // Paso 2: Consultar empresas activas (status = 1) que NO estén en esa lista
    const where = { }; // Solo empresas activas
    if (associatedCompanyIds.length > 0) {
      where.id = { [Op.notIn]: associatedCompanyIds };
    }

    const companies = await Company.findAll({
      where,
      attributes: ['id', 'name', 'description', 'image'], // Solo los campos que necesitas en el frontend
      order: [['name', 'ASC']]
    });

    return companies.map(company => company.toJSON());
  } catch (error) {
    logger.error(`Error al obtener empresas disponibles para user_id=${user_id}`, error);
    throw new Error(`Error al obtener empresas disponibles: ${error.message}`);
  }
},
async findActiveByCompanyIdAndRoleName(company_id, roleName) {
 try {
    return await UserCompany.findAll({
      where: {
        company_id: company_id,
        status: 1 // solo membresías activas
      },
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email']
        },
        {
          model: Role,
          as: 'role',
          where: {
            name: roleName.toLowerCase() // normalizar a minúsculas por seguridad
          },
          attributes: ['id', 'name']
        }
      ]
    });
  } catch (error) {
    logger.error('UserCompanyRepository->findActiveByCompanyIdAndRoleName:', error.message);
    throw error;
  }
},

async findActiveMembershipsByUserId(userId) {
  try {
    const memberships = await UserCompany.findAll({
      where: {
        user_id: userId,
        status: 1 // solo membresías activas
      },
      include: [
        {
          model: Company,
          as: 'company',
          attributes: ['id', 'name', 'plan_id', 'image'],
          include: [
            {
              model: Plan,
              as: 'plan',
            }
          ]
        },
        {
          model: Role,
          as: 'role',
          attributes: ['id', 'name'],
          include: [
            {
              model: Permission,
              as: 'permissions',
              attributes: ['id', 'name', 'description'],
              through: { attributes: [] }
            }
          ]
        }
      ],
      attributes: ['id', 'company_id', 'role_id', 'status']
    });

    return memberships;
  } catch (error) {
    logger.error(`Error al obtener membresías activas del usuario ${userId}:`, error);
    throw new Error(`Error al cargar membresías: ${error.message}`);
  }
},

async findActiveAdminsByCompanyId(company_id) {
  try {
    const memberships = await UserCompany.findAll({
      where: {
        company_id,
        status: 1, // activo
      },
      include: [
        {
          model: User,
          as: "user",
          attributes: ["id", "name", "email"],
          where: {
            email: { [Op.not]: null }, // opcional: solo usuarios con email
          },
        },
        {
          model: Role,
          as: "role",
          where: {
            name: "Admin", // asumimos que el rol se llama exactamente "admin"
          },
          attributes: ["id", "name"],
        },
      ],
    });

    return memberships.map(m => m.user); // retorna solo los objetos User
  } catch (error) {
    logger.error("UserCompanyRepository->findActiveAdminsByCompanyId:", + error.message);
    throw error;
  }
}
};

module.exports = UserCompanyRepository;