'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WarehouseProductVariant extends Model {
    static associate(models) {
      WarehouseProductVariant.belongsTo(models.WarehouseProduct, {
        foreignKey: 'warehouse_product_id',
        as: 'warehouseProduct',
        onDelete: 'CASCADE'
      });
      WarehouseProductVariant.belongsTo(models.ProductVariant, {
        foreignKey: 'variant_id',
        as: 'variant',
        onDelete: 'CASCADE'
      });
    }
  }

  WarehouseProductVariant.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    warehouse_product_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    variant_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    published: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    local_sku: {
      type: DataTypes.STRING,
      allowNull: true
    },
    price: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: false
    },
    promotional_price: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    }
  }, {
    sequelize,
    modelName: 'WarehouseProductVariant',
    tableName: 'warehouse_product_variants',
    timestamps: true
  });

  return WarehouseProductVariant;
};