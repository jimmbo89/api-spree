'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Warehouse extends Model {
    static associate(models) {
      Warehouse.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'SET NULL' });
      Warehouse.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'SET NULL' });
      Warehouse.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Warehouse.hasMany(models.ProductPublishingTask, { foreignKey: 'warehouse_id', as: 'publishingTasks', onDelete: 'SET NULL' });
    }
  }

  Warehouse.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'companies',
        key: 'id'
      }
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'branches',
        key: 'id'
      }
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    type: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 1, // 1 = Primario, 0 = Secundario
    },
    address: {
      type: DataTypes.STRING,
      allowNull: true
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'warehouses/default.jpg'
    }
  }, {
    sequelize,
    modelName: 'Warehouse',
    tableName: 'warehouses',
    timestamps: true
  });

  return Warehouse;
};