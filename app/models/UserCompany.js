'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class UserCompany extends Model {
    static associate(models) {
      // Relaciones entrantes
      UserCompany.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      UserCompany.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
      UserCompany.belongsTo(models.Role, { foreignKey: 'role_id', as: 'role' });
      UserCompany.belongsTo(models.User, { foreignKey: 'invited_by', as: 'inviter' });

      // Relaciones salientes (opcional, para facilitar queries)
      // Puedes añadirlas si las necesitas en include
      // User.hasMany(models.UserCompany, { foreignKey: 'user_id', as: 'memberships' });
      // Company.hasMany(models.UserCompany, { foreignKey: 'company_id', as: 'memberships' });
    }
  }

  UserCompany.init({
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
    role_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: -1 // -1: pending, 0: inactive, 1: active
    },
    joined_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    invited_by: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    invitation_token: {
      type: DataTypes.STRING,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'UserCompany',
    tableName: 'user_companies',
    timestamps: true
  });

  return UserCompany;
};