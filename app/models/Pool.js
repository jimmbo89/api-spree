// models/pool.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Pool extends Model {
    static associate(models) {
      // Relación con Company
      Pool.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });

      // Relación con User
      Pool.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user',
        onDelete: 'CASCADE'
      });

      // Relación con PoolWarehouse
      Pool.hasMany(models.PoolWarehouse, {
        foreignKey: 'pool_id',
        as: 'poolWarehouses',
        onDelete: 'CASCADE'
      });

      // Relación con Warehouse a través de PoolWarehouse
      Pool.belongsToMany(models.Warehouse, {
        through: models.PoolWarehouse,
        foreignKey: 'pool_id',
        otherKey: 'warehouse_id',
        as: 'warehouses'
      });
    }
  }

  Pool.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: true,
        len: [2, 100]
      }
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      defaultValue: true
    }
  }, {
    sequelize,
    modelName: 'Pool',
    tableName: 'pools',
    timestamps: true,
    paranoid: true, // Para soft delete (deletedAt)
    indexes: [
      {
        unique: true,
        fields: ['company_id', 'name'],
        name: 'unique_pool_name_per_company'
      },
      {
        fields: ['company_id', 'user_id']
      },
      {
        fields: ['is_active']
      }
    ]
  });

  return Pool;
};