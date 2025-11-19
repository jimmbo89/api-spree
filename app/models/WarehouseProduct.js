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
    stock: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
      validate: { min: 0 }
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'warehouse_products/default.jpg'
    },
    price: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    published: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
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