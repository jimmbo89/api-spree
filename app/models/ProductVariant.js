'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductVariant extends Model {
    static associate(models) {
      ProductVariant.belongsTo(models.Product, {
        foreignKey: 'product_id',
        as: 'product',
        onDelete: 'CASCADE'
      });
      ProductVariant.hasMany(models.WarehouseProductVariant, {
        foreignKey: 'variant_id',
        as: 'warehouseVariants',
        onDelete: 'CASCADE'
      });
    }
  }

  ProductVariant.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    sku: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },
    internal_code: {
      type: DataTypes.STRING,
      allowNull: true
    },
    attributes: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {}
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'ProductVariant',
    tableName: 'product_variants',
    timestamps: true
  });

  return ProductVariant;
};