// models/poolwarehouse.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class PoolWarehouse extends Model {
    static associate(models) {
      // Relación con Pool
      PoolWarehouse.belongsTo(models.Pool, {
        foreignKey: 'pool_id',
        as: 'pool',
        onDelete: 'CASCADE'
      });

      // Relación con Warehouse
      PoolWarehouse.belongsTo(models.Warehouse, {
        foreignKey: 'warehouse_id',
        as: 'warehouse',
        onDelete: 'CASCADE'
      });
    }
  }

  PoolWarehouse.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    pool_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    is_primary: {
      type: DataTypes.BOOLEAN,
      defaultValue: false
    },
    position: {
      type: DataTypes.INTEGER,
      defaultValue: 0
    }
  }, {
    sequelize,
    modelName: 'PoolWarehouse',
    tableName: 'pool_warehouses',
    timestamps: true,
    indexes: [
      {
        unique: true,
        fields: ['pool_id', 'warehouse_id'],
        name: 'unique_pool_warehouse_combination'
      }
    ],
  });

  return PoolWarehouse;
};