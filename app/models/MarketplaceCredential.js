// models/marketplace-credential.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceCredential extends Model {
    static associate(models) {
      MarketplaceCredential.belongsTo(models.Marketplace, { foreignKey: 'marketplace_id', as: 'marketplace' });
      MarketplaceCredential.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'CASCADE' });
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
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: 'users', key: 'id' }
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
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    }
  }, {
    sequelize,
    modelName: 'MarketplaceCredential',
    tableName: 'marketplace_credentials',
    timestamps: true,
     indexes: [
      {
        unique: true,
        fields: ['marketplace_id', 'user_id'],
        name: 'mc_marketplace_user_unique'
      }
    ]
  });

  return MarketplaceCredential;
};