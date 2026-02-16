'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductPublishingTask extends Model {
    static associate(models) {
      ProductPublishingTask.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });
      ProductPublishingTask.belongsTo(models.Marketplace, { foreignKey: 'marketplace_id', as: 'marketplace' });
      ProductPublishingTask.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse', onDelete: 'SET NULL' });
      ProductPublishingTask.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
      ProductPublishingTask.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    }
  }

  ProductPublishingTask.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
     date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending'
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false
    },
    external_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    external_url: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'ProductPublishingTask',
    tableName: 'product_publishing_tasks',
    timestamps: true
  });

  return ProductPublishingTask;
};