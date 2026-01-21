'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Marketplace extends Model {
    static associate(models) {
      Marketplace.hasMany(models.ProductFieldMapping, { foreignKey: 'marketplace_id', as: 'fieldMappings', onDelete: 'CASCADE' });
      Marketplace.hasMany(models.ProductPublishingTask, { foreignKey: 'marketplace_id', as: 'publishingTasks', onDelete: 'SET NULL' });
      Marketplace.hasMany(models.ProductMarketplaceLink, { foreignKey: 'marketplace_id', as: 'productLinks', onDelete: 'CASCADE' });
      Marketplace.hasMany(models.MarketplaceCredential, { foreignKey: 'marketplace_id', as: 'credentials' });
    }
  }

  Marketplace.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.STRING,
      allowNull: true
    },
    type: {
      type: DataTypes.TINYINT,
      allowNull: true
    },
    domain: {
      type: DataTypes.STRING,
      allowNull: true
    },
    config: {
      type: DataTypes.JSON,
      allowNull: true
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
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
    scopes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
  }, {
    sequelize,
    modelName: 'Marketplace',
    tableName: 'marketplaces',
    timestamps: true
  });

  return Marketplace;
};