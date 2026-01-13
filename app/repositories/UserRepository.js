// app/repositories/UserRepository.js
const { Op } = require('sequelize');
const { User, Role, Company, UserCompany, UserAclScope, Warehouse, Pool, Plan } = require('../models'); // 👈 Añadido Role
const logger = require('../../config/logger');
const ImageService = require('../services/ImageService');

const UserRepository = {
  /*async findAll() {
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
},*/
   async findAll(filters = {}) {
    try {
      const { company_id, role_id, status } = filters;
      
      // PASO 1: Encontrar los IDs de usuarios que pertenecen a la compañía (si se especifica)
      let userIds = [];
      let membershipWhere = {};
      
      const users = await User.findAll({
      attributes: ['id', 'name', 'email', 'status', 'image', 'user'],
      include: [
        {
          model: UserCompany,
          as: 'memberships',
          attributes: ['id', 'company_id', 'role_id', 'status', 'invited_by'],
          where: { company_id }, // ✅ FILTRO POR COMPANY_ID
          required: true, // ✅ INNER JOIN - solo usuarios con membresía en esta compañía
          include: [
            { 
              model: Company, 
              as: 'company', 
              attributes: ['id', 'name'] 
            },
            { 
              model: Role, 
              as: 'role', 
              attributes: ['id', 'name', 'description'] 
            },
            {
              model: User,
              as: 'inviter',
              attributes: ['id', 'name', 'email']
            }
          ]
        },
        {
          model: UserAclScope,
          as: 'aclScopes',
          attributes: ['id', 'company_id', 'warehouse_id', 'pool_id'],
          where: { company_id }, // ✅ FILTRO POR COMPANY_ID
          required: false, // ✅ LEFT JOIN - puede no tener ACL
          include: [
            {
              model: Company,
              as: 'company',
              attributes: ['id', 'name']
            },
            {
              model: Warehouse,
              as: 'warehouse',
              attributes: ['id', 'name', 'code', 'type', 'branch_id']
            },
            {
              model: Pool,
              as: 'pool',
              attributes: ['id', 'name', 'description'],
              include: [{
                model: Warehouse,
                as: 'warehouses',
                attributes: ['id', 'name', 'code'],
                through: { attributes: [] }
              }]
            }
          ]
        }
      ],
      order: [['name', 'ASC']],
      // ✅ FILTROS ADICIONALES
      ...(role_id && {
        where: {
          '$memberships.role_id$': role_id
        }
      }),
      ...(status !== undefined && {
        where: {
          '$memberships.status$': status
        }
      })
    });

    // ✅ PROCESAMIENTO SIMPLIFICADO - Sabemos que hay UNA membresía
    const plainUsers = users.map(user => {
      // SABEMOS que user.memberships[0] existe por el INNER JOIN
      const membership = user.memberships[0];
      
      // Procesar warehouses y pools de ACL
      const warehouses = [];
      const pools = [];
      
      user.aclScopes.forEach(scope => {
        if (scope.warehouse_id && scope.warehouse) {
          warehouses.push({
            id: scope.warehouse_id,
            name: scope.warehouse.name,
            code: scope.warehouse.code,
            type: scope.warehouse.type,
            branch_id: scope.warehouse.branch_id
          });
        }
        
        if (scope.pool_id && scope.pool) {
          pools.push({
            id: scope.pool_id,
            name: scope.pool.name,
            description: scope.pool.description,
            warehouses: scope.pool.warehouses?.map(w => ({
              id: w.id,
              name: w.name,
              code: w.code
            })) || []
          });
        }
      });

      return {
        id: user.id,
        name: user.name,
        email: user.email,
        user: user.user,
        image: user.image,
        status: user.status,
        status_label: user.status ? 'Activo' : 'Inactivo',
        
        // ✅ MEMBRESÍA COMO OBJETO ÚNICO (no array)
        membership: {
          id: membership.id,
          company_id: membership.company_id,
          company_name: membership.company?.name || '—',
          role_id: membership.role_id,
          role_name: membership.role?.name || '—',
          role_description: membership.role?.description || '',
          membership_status: membership.status,
          invited_by: membership.invited_by,
          inviter_name: membership.inviter?.name || '—',
          inviter_email: membership.inviter?.email || '—'
        },
        
        // ✅ ACL SCOPES (ya filtrados por company_id)
        acl_scopes: user.aclScopes.map(scope => ({
          id: scope.id,
          company_id: scope.company_id,
          scope_type: scope.warehouse_id ? 'warehouse' : scope.pool_id ? 'pool' : 'company',
          warehouse_id: scope.warehouse_id,
          warehouse_name: scope.warehouse?.name,
          pool_id: scope.pool_id,
          pool_name: scope.pool?.name
        })),
        
        // ✅ ACL AGRUPADO (solo para esta compañía)
        acl_by_company: [{
          company_id: company_id,
          company_name: membership.company?.name || '—',
          warehouses: warehouses,
          pools: pools
        }]
      };
    });

    logger.info(`Encontrados ${plainUsers.length} usuarios para compañía ${company_id}`);
    return plainUsers;

  } catch (error) {
    logger.error('Error en UserRepository->findAll:', error);
    logger.error('Stack trace:', error.stack);
    throw new Error(`Error al obtener usuarios de la compañía: ${error.message}`);
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
          {
            model: Company,
            as: 'company',
            attributes: ['id', 'name', 'plan_id'],
            include: [
              {
                model: Plan,
                as: 'plan'
              }
            ]
          },
          {
            model: Role,
            as: 'role',
            attributes: ['id', 'name']
          }
        ]
      }]
    });
    return user;
  } catch (error) {
    logger.error(`Error al buscar usuario por email o nombre (${identifier}):`, error);
    throw new Error(`Error al buscar usuario: ${error.message}`);
  }
},

async create(userData, file, transaction = null) {
  logger.info('entrando el repository de crear usuario')
  try {
    const user = await User.create({
      name: userData.name,
      email: userData.email,
      password: userData.password,
      status: userData.status !== undefined ? userData.status : true,
      email_verified_at: userData.email_verified_at,
      remember_token: userData.remember_token,
      external_id: userData.external_id,
      external_auth: userData.external_auth,
      image: 'users/default.jpg',
      registration_date: userData.registration_date,
      user: userData.user
    }, { transaction });

     if (file) {
      const newFilename = ImageService.generateFilename('users', user.id, file.originalname);
      user.image = await ImageService.moveFile(file, newFilename);
      await user.update({ image: user.image }, { transaction });
    }
    return user;
  } catch (error) {
    logger.error('Error al crear usuario:', error);
    throw new Error(`Error al crear usuario: ${error.message}`);
  }
},

  async update(user, body, file) {
    try {
      const fieldsToUpdate = [
        'name', 'email', 'status', 'email_verified_at', 'password', 'remember_token',
        'external_id', 'external_auth', 'registration_date', 'user'
      ];
      const updatedData = Object.keys(body)
      .filter(key => fieldsToUpdate.includes(key) && body[key] !== undefined)
      .reduce((obj, key) => {
        obj[key] = body[key];
        return obj;
      }, {});

    if (file) {
      if (user.image && user.image !== 'useres/default.jpg') {
        await ImageService.deleteFile(user.image);
      }
      const newFilename = ImageService.generateFilename('users', user.id, file.originalname);
      updatedData.image = await ImageService.moveFile(file, newFilename);
    }

    if (Object.keys(updatedData).length > 0) {
      await user.update(updatedData);
      logger.info(`Usuario actualizado (ID: ${user.id})`);
    }
      return user;
    } catch (error) {
      logger.error(`Error al actualizar usuario (ID: ${user.id}):`, error);
      throw new Error(`Error al actualizar usuario: ${error.message}`);
    }
  },

  // UserRepository.js
async delete(user) {
  try {
    await user.reload({
      include: [{
        model: UserCompany,
        as: 'memberships',
        include: [{ model: Role, as: 'role' }]
      }]
    });

    // Verificar si es el último Admin en alguna empresa
    for (const membership of user.memberships) {
      if (membership.role && membership.role.name === 'Admin') {
        const otherAdmins = await UserCompany.count({
          where: {
            company_id: membership.company_id,
            role_id: membership.role_id,
            status: 1
          },
          include: [{ 
            model: User, 
            as: 'user', 
            where: { status: true } 
          }]
        });

        if (otherAdmins <= 1) {
          // 👇 NO lanzar error → devolver resultado estructurado
          return {
            success: false,
            message: `No se puede eliminar el último administrador de la empresa`,
            code: 'LAST_ADMIN'
          };
        }
      }
    }

    await user.destroy();
    return { success: true, message: 'Usuario eliminado' };

  } catch (error) {
    logger.error(`Error al eliminar usuario (ID: ${user.id}):`, error);
    return {
      success: false,
      message: 'Error interno al eliminar usuario',
      code: 'INTERNAL_ERROR'
    };
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