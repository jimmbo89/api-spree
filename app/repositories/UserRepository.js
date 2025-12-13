// app/repositories/UserRepository.js
const { Op } = require('sequelize');
const { User, Role, Company } = require('../models'); // 👈 Añadido Role
const logger = require('../../config/logger');

const UserRepository = {
  async findAll() {
  try {
    // Realizamos la consulta con JOIN implícito mediante include
    const users = await User.findAll({
      attributes: ['id', 'name', 'email', 'status', 'role_id', 'image', 'user'], // Solo los campos que necesitamos del usuario
      include: [{
        model: Role,
        as: 'role',
        attributes: ['name'] // Solo el nombre del rol
      }]
    });

    // Mapeamos a un objeto plano
    const plainUsers = users.map(user => ({
      id: user.id,
      role_id: user.role_id,
      name: user.name,
      email: user.email,
      user: user.user,
      image: user.image,
      role: user.role ? user.role.name : 'Invited'
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
          'id', 'name', 'email', 'status', 'role_id', 'image',
          'email_verified_at', 'remember_token', 'external_id', 'external_auth', 'registration_date', 'user'
        ],
        include: [
          { model: Role, as: 'role', attributes: ['id', 'name', 'status', 'description'] }
        ]
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
          'id', 'name', 'email', 'status', 'role_id', 'image', 'password', 'remember_token', 'registration_date', 'user'
        ],
        include: [
          { model: Role, as: 'role', attributes: ['id', 'name', 'status', 'description'] },
          { model: Company, as: 'companies', attributes: ['id', 'name'] },
        ]
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
        role_id: userData.role_id,
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
        'name', 'email', 'status', 'role_id', 'image',
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
      // Asegurarnos de que el usuario tiene su rol cargado
      if (!user.role) {
        await user.reload({ include: [{ association: 'role' }] });
      }

      // Verificar si el usuario es Admin
      if (user.role && user.role.name === 'Admin') {
        // Contar cuántos usuarios tienen rol "Admin"
        const adminCount = await User.count({
          include: [{
            model: Role,
            as: 'role', // debe coincidir con tu asociación `as: 'role'`
            where: { name: 'Admin' }
          }]
        });

        if (adminCount <= 1) {
          throw new Error('No se puede eliminar el último usuario administrador');
        }
      }

      // Si pasa las validaciones, eliminar
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
        include: [
          { model: Role, as: 'role', attributes: ['id', 'name', 'status', 'description'] }
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