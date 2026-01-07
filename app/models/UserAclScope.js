'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class UserAclScope extends Model {
    static associate(models) {
      UserAclScope.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      UserAclScope.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
      UserAclScope.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' });
      UserAclScope.belongsTo(models.Pool, { foreignKey: 'pool_id', as: 'pool' });
    }
  }

  UserAclScope.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    pool_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'UserAclScope',
    tableName: 'user_acl_scopes',
    timestamps: true
  });

  return UserAclScope;
};