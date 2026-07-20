'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class UserMarketplaceCredential extends Model {
    static associate(models) {
      UserMarketplaceCredential.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user',
        onDelete: 'CASCADE'
      });

      UserMarketplaceCredential.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });

      UserMarketplaceCredential.belongsTo(models.MarketplaceCredential, {
        foreignKey: 'marketplace_credential_id',
        as: 'marketplaceCredential',
        onDelete: 'CASCADE'
      });
    }
  }

  UserMarketplaceCredential.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: 'users', key: 'id' }
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: 'companies', key: 'id' },
      comment: 'Empresa a la que pertenece la asignación'
    },
    marketplace_credential_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: 'marketplace_credentials', key: 'id' }
    },
    status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 1,
      comment: '0 = inactivo, 1 = activo'
    }
  }, {
    sequelize,
    modelName: 'UserMarketplaceCredential',
    tableName: 'user_marketplace_credentials',
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ['user_id', 'company_id', 'marketplace_credential_id'],
        name: 'umc_user_company_credential_unique'
      },
      {
        fields: ['user_id'],
        name: 'umc_user_idx'
      },
      {
        fields: ['company_id'],
        name: 'umc_company_idx'
      },
      {
        fields: ['marketplace_credential_id'],
        name: 'umc_marketplace_credential_idx'
      },
      {
        fields: ['status'],
        name: 'umc_status_idx'
      }
    ]
  });

  return UserMarketplaceCredential;
};
