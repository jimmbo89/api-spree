'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Role extends Model {
    static associate(models) {
      Role.hasMany(models.RolePermission, { foreignKey: 'role_id', as: 'rolePermissions' });
      Role.belongsToMany(models.Permission, { through: models.RolePermission, foreignKey: 'role_id', otherKey: 'permission_id', as: 'permissions' });
      Role.hasMany(models.UserCompany, { foreignKey: 'role_id', as: 'memberships' });
      // ✅ Relación con usuarios globales (BackOffice)
      Role.hasMany(models.User, { foreignKey: 'role_id', as: 'users' });
    }
  }

  Role.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del rol'
    },
    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'El nombre del rol no puede estar vacío'
        }
      },
      comment: 'Nombre único del rol (obligatorio)'
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true,
      comment: 'Estado del rol (activo/inactivo)'
    },
    visible_to_companies: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
      comment: '0 = no visible para empresas, 1 = visible para empresas'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción opcional del rol'
    }
  }, {
    sequelize,
    modelName: 'Role',
    tableName: 'roles',
    timestamps: true,
  });

  return Role;
};
