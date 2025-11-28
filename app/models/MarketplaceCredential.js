// models/marketplace-credential.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceCredential extends Model {
    static associate(models) {
      MarketplaceCredential.belongsTo(models.Marketplace, { foreignKey: 'marketplace_id', as: 'marketplace' });
      MarketplaceCredential.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      MarketplaceCredential.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'CASCADE' });
    }
  }

  MarketplaceCredential.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    // 🔑 Campos OAuth
    client_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    client_secret: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    redirect_uri: {
      type: DataTypes.STRING,
      allowNull: true
    },
    access_token: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    refresh_token: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    scopes: {
      type: DataTypes.STRING,
      allowNull: true
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    }
  }, {
    sequelize,
    modelName: 'MarketplaceCredential',
    tableName: 'marketplace_credentials',
    timestamps: true
  });

  return MarketplaceCredential;
};