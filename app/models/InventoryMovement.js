// models/InventoryMovement.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class InventoryMovement extends Model {
    static associate(models) {
      InventoryMovement.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse' });
      InventoryMovement.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });
      InventoryMovement.belongsTo(models.ProductVariant, { foreignKey: 'variant_id', as: 'variant' });
      InventoryMovement.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      InventoryMovement.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
      InventoryMovement.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch' });
      InventoryMovement.belongsTo(models.Warehouse, { foreignKey: 'origin_warehouse_id', as: 'originWarehouse' });
      InventoryMovement.belongsTo(models.Warehouse, { foreignKey: 'destination_warehouse_id', as: 'destinationWarehouse' });
    }
  }

  InventoryMovement.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    variant_id: {
      type: DataTypes.BIGINT,
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
    movement_type: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    stock_before: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    stock_after: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    unit_price: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    total_value: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    reference_type: {
      type: DataTypes.STRING,
      allowNull: true
    },
    reference_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    origin_warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    destination_warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    meta: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {},
      comment: 'Metadatos adicionales del movimiento (ej: cálculo FIFO, lotes usados)'
    }
  }, {
    sequelize,
    modelName: 'InventoryMovement',
    tableName: 'inventory_movements',
    timestamps: true
  });

  return InventoryMovement;
};