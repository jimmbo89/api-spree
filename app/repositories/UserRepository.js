// app/repositories/UserRepository.js
const { Op } = require('sequelize');
const { User, Role, Company, UserCompany } = require('../models'); // 👈 Añadido Role
const logger = require('../../config/logger');

const UserRepository = {
  async findAll() {
  try {
    const users = await User.findAll({
      attributes: ['id', 'name', 'email', 'status', 'image', 'user'],
      // Incluir membresías para mostrar roles por empresa
      include: [{
        model: UserCompany,
        as: 'memberships',
        attributes: ['id', 'company_id', 'role_id', 'status'],
        include: [
          { model: Company, as: 'company', attributes: ['id', 'name'] },
          { model: Role, as: 'role', attributes: ['id', 'name'] }
        ]
      }]
    });

    const plainUsers = users.map(user => ({
      id: user.id,
      name: user.name,
      email: user.email,
      user: user.user,
      image: user.image,
      status: user.status,
      memberships: user.memberships.map(m => ({
        company_id: m.company_id,
        company_name: m.company?.name || '—',
        role_id: m.role_id,
        role_name: m.role?.name || '—',
        membership_status: m.status
      }))
    }));

    return plainUsers;
  } catch (error) {
    logger.error('Error en UserRepository->findAll:', error);
    throw new Error(`Error al obtener la lista de usuarios: ${error.message}`);
  }
},

  async findById(id) {
  try {
    const user = await User.findByPk(id, {
      attributes: [
        'id', 'name', 'email', 'status', 'image',
        'email_verified_at', 'remember_token', 'external_id', 'external_auth', 'registration_date', 'user'
      ],
      include: [{
        model: UserCompany,
        as: 'memberships',
        attributes: ['id', 'company_id', 'role_id', 'status', 'joined_at'],
        include: [
          { model: Company, as: 'company', attributes: ['id', 'name'] },
          { model: Role, as: 'role', attributes: ['id', 'name', 'status', 'description'] }
        ]
      }]
    });
    return user;
  } catch (error) {
    logger.error(`Error al buscar usuario por ID ${id}:`, error);
    throw new Error(`Error al obtener usuario: ${error.message}`);
  }
},

  async existsByEmail(email, excludeId = null) {
    try {
      const where = excludeId ? { email, id: { [Op.ne]: excludeId } } : { email };
      const user = await User.findOne({ where });
      return user;
    } catch (error) {
      logger.error(`Error al verificar email ${email}:`, error);
      throw new Error(`Error al verificar email: ${error.message}`);
    }
  },

  async findByEmailOrName(identifier) {
  try {
    const user = await User.findOne({
      where: {
        [Op.or]: [{ email: identifier }, { user: identifier }]
      },
      attributes: [
        'id', 'name', 'email', 'status', 'image', 'password', 'remember_token', 'registration_date', 'user'
      ],
      include: [{
        model: UserCompany,
        as: 'memberships',
        attributes: ['id', 'company_id', 'role_id', 'status'],
        include: [
          { model: Company, as: 'company', attributes: ['id', 'name'] },
          { model: Role, as: 'role', attributes: ['id', 'name'] }
        ]
      }]
    });
    return user;
  } catch (error) {
    logger.error(`Error al buscar usuario por email o nombre (${identifier}):`, error);
    throw new Error(`Error al buscar usuario: ${error.message}`);
  }
},

  async create(userData) {
    try {
      // Asegúrate de incluir status y role_id si vienen
      const user = await User.create({
        name: userData.name,
        email: userData.email,
        password: userData.password,
        status: userData.status !== undefined ? userData.status : true,
        email_verified_at: userData.email_verified_at,
        remember_token: userData.remember_token,
        external_id: userData.external_id,
        external_auth: userData.external_auth,
        image: userData.image,
        registration_date: userData.registration_date,
        user: userData.user
      });
      return user;
    } catch (error) {
      logger.error('Error al crear usuario:', error);
      throw new Error(`Error al crear usuario: ${error.message}`);
    }
  },

  async update(user, updateData) {
    try {
      const allowedFields = [
        'name', 'email', 'status', 'image',
        'email_verified_at', 'password', 'remember_token',
        'external_id', 'external_auth', 'registration_date', 'user'
      ];
      const filteredData = {};
      for (const key of allowedFields) {
        if (updateData[key] !== undefined) {
          filteredData[key] = updateData[key];
        }
      }
      if (Object.keys(filteredData).length === 0) {
        throw new Error('No hay campos válidos para actualizar');
      }
      await user.update(filteredData);
      return user;
    } catch (error) {
      logger.error(`Error al actualizar usuario (ID: ${user.id}):`, error);
      throw new Error(`Error al actualizar usuario: ${error.message}`);
    }
  },

  async delete(user) {
  try {
    // Recargar membresías
    await user.reload({
      include: [{
        model: UserCompany,
        as: 'memberships',
        include: [{ model: Role, as: 'role' }]
      }]
    });

    // Verificar si es el último Admin en ALGUNA empresa
    for (const membership of user.memberships) {
      if (membership.role && membership.role.name === 'Admin') {
        const otherAdmins = await UserCompany.count({
          where: {
            company_id: membership.company_id,
            role_id: membership.role_id,
            status: 1 // activo
          },
          include: [{ model: User, as: 'user', where: { status: true } }]
        });

        if (otherAdmins <= 1) {
          throw new Error(`No se puede eliminar el último administrador de la empresa ${membership.company_id}`);
        }
      }
    }

    // Si pasa, eliminar
    await user.destroy();
    return { success: true, message: 'Usuario eliminado' };
  } catch (error) {
    logger.error(`Error al eliminar usuario (ID: ${user.id}):`, error);
    throw new Error(`Error al eliminar usuario: ${error.message}`);
  }
},

    // Método para buscar usuario por email con transacción
  async findByEmailWithTransaction(email, transaction = null) {
  try {
    const options = { 
      where: { email },
      attributes: [
        'id', 'name', 'email', 'status', 'image',
        'email_verified_at', 'remember_token', 'external_id', 'external_auth', 'registration_date', 'user'
      ]
    };
    
    if (transaction) {
      options.transaction = transaction;
    }
    
    const user = await User.findOne(options);
    return user;
  } catch (error) {
    logger.error(`Error al buscar usuario por email (${email}):`, error);
    throw new Error(`Error al buscar usuario: ${error.message}`);
  }
},

  // Método para actualizar token de recuperación con transacción
  async updateResetTokenWithTransaction(id, resetData, transaction = null) {
    try {
      const options = { where: { id } };
      
      if (transaction) {
        options.transaction = transaction;
      }
      
      const result = await User.update(resetData, options);
      return result;
    } catch (error) {
      logger.error(`Error al actualizar reset token para usuario (ID: ${id}):`, error);
      throw new Error(`Error al actualizar token de recuperación: ${error.message}`);
    }
  },

  // Método para buscar usuario por token de recuperación (para verificar código)
  async findByResetToken(resetToken) {
    try {
      const user = await User.findOne({
        where: {
          reset_token: resetToken
        },
        attributes: ['id', 'email', 'reset_expire']
      });
      return user;
    } catch (error) {
      logger.error('Error al buscar usuario por reset token:', error);
      throw new Error(`Error al buscar token de recuperación: ${error.message}`);
    }
  },

  // Método para limpiar token de recuperación
  async clearResetToken(id, transaction = null) {
    try {
      const options = { 
        where: { id },
        fields: ['reset_token', 'reset_expire']
      };
      
      if (transaction) {
        options.transaction = transaction;
      }
      
      const result = await User.update({
        reset_token: null,
        reset_expire: null
      }, options);
      
      return result;
    } catch (error) {
      logger.error(`Error al limpiar reset token para usuario (ID: ${id}):`, error);
      throw new Error(`Error al limpiar token de recuperación: ${error.message}`);
    }
  },
};

module.exports = UserRepository;