'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class WarehouseProduct extends Model {
    static associate(models) {
      WarehouseProduct.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product', onDelete: 'CASCADE' });
      WarehouseProduct.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse', onDelete: 'CASCADE' });
      WarehouseProduct.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      WarehouseProduct.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'SET NULL' });
      WarehouseProduct.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'RESTRICT' });
      WarehouseProduct.hasMany(models.WarehouseProductVariant, { foreignKey: 'warehouse_product_id', as: 'warehouseVariants', onDelete: 'CASCADE' });
    }
  }

  WarehouseProduct.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    active: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'WarehouseProduct',
    tableName: 'warehouse_products',
    timestamps: true
  });

  return WarehouseProduct;
};