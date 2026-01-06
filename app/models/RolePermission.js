'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class RolePermission extends Model {
    static associate(models) {
      RolePermission.belongsTo(models.Role, { foreignKey: 'role_id', as: 'role' });
      RolePermission.belongsTo(models.Permission, { foreignKey: 'permission_id', as: 'permission' });
    }
  }

  RolePermission.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },
    role_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    permission_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1
    }
  }, {
    sequelize,
    modelName: 'RolePermission',
    tableName: 'role_permissions',
    timestamps: true
  });

  return RolePermission;
};