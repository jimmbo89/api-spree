'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductFieldMapping extends Model {
    static associate(models) {
      ProductFieldMapping.belongsTo(models.Marketplace, {
        foreignKey: 'marketplace_id',
        as: 'marketplace',
        onDelete: 'CASCADE'
      });
    }
  }

  ProductFieldMapping.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: { model: 'marketplaces', key: 'id' }
    },
    internal_field: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    external_field: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    required: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    data_type: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    direction: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'export'
    },
    default_value: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    validation_rules: {
      type: DataTypes.JSON,
      allowNull: true,
    }
  }, {
    sequelize,
    modelName: 'ProductFieldMapping',
    tableName: 'product_field_mappings',
    timestamps: true
  });

  return ProductFieldMapping;
};