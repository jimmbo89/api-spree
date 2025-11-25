'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Marketplace extends Model {
    static associate(models) {
      Marketplace.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'SET NULL' });
      Marketplace.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Marketplace.hasMany(models.ProductFieldMapping, { foreignKey: 'marketplace_id', as: 'fieldMappings', onDelete: 'CASCADE' });
      Marketplace.hasMany(models.ProductPublishingTask, { foreignKey: 'marketplace_id', as: 'publishingTasks', onDelete: 'SET NUll' });
    }
  }

  Marketplace.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: 'companies', key: 'id' }
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: { model: 'users', key: 'id' }
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
    }
  }, {
    sequelize,
    modelName: 'Marketplace',
    tableName: 'marketplaces',
    timestamps: true
  });

  return Marketplace;
};