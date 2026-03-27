'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductMarketplaceLink extends Model {
    static associate(models) {
      ProductMarketplaceLink.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });
      ProductMarketplaceLink.belongsTo(models.Marketplace, { foreignKey: 'marketplace_id', as: 'marketplace' });
      ProductMarketplaceLink.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      ProductMarketplaceLink.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'CASCADE' });
      // ✅ NUEVO: Asociación con MarketplaceCredential
      ProductMarketplaceLink.belongsTo(models.MarketplaceCredential, { 
        foreignKey: 'credential_id', 
        as: 'credential',
        onDelete: 'SET NULL'
      });
    }
  }

  ProductMarketplaceLink.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: false
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
    credential_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ID de la credencial específica usada para esta publicación'
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'unpublished'
    },
    external_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    external_url: {
      type: DataTypes.STRING,
      allowNull: true
    },
    last_synced_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'ProductMarketplaceLink',
    tableName: 'product_marketplace_links',
    timestamps: true
  });

  return ProductMarketplaceLink;
};