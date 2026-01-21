'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Branch extends Model {
    static associate(models) {
      // Sucursal pertenece a una empresa (opcional)
      Branch.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'SET NULL' });

      // Sucursal pertenece a un usuario (opcional)
      Branch.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Branch.hasMany(models.Warehouse, { foreignKey: 'branch_id', as: 'warehouses', onDelete: 'SET NULL' });
      Branch.hasMany(models.ProductMarketplaceLink, { foreignKey: 'branch_id', as: 'productmarketplacelinks', onDelete: 'SET NULL' });
    }
  }

  Branch.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'companies',
        key: 'id'
      }
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    address: {
      type: DataTypes.STRING,
      allowNull: true
    },
    city: {
      type: DataTypes.STRING,
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.TINYINT,
      allowNull: true,
      defaultValue: 1, // 1 = activa, 0 = inactiva
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'branches/default.jpg'
    }
  }, {
    sequelize,
    modelName: 'Branch',
    tableName: 'branches',
    timestamps: true
  });

  return Branch;
};