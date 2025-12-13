'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Warehouse extends Model {
    static associate(models) {
      Warehouse.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'SET NULL' });
      Warehouse.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'SET NULL' });
      Warehouse.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Warehouse.hasMany(models.ProductPublishingTask, { foreignKey: 'warehouse_id', as: 'publishingTasks', onDelete: 'SET NULL' });
        // Agregar esta relación con WarehouseProduct
    Warehouse.hasMany(models.WarehouseProduct, {
      foreignKey: 'warehouse_id',
      as: 'warehouseProducts'
    });
    
    // Y la relación muchos-a-muchos con Product a través de WarehouseProduct
    Warehouse.belongsToMany(models.Product, {
      through: models.WarehouseProduct,
      foreignKey: 'warehouse_id',
      otherKey: 'product_id',
      as: 'products'
    });
    }
  }

  Warehouse.init({
     id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    code: {
      type: DataTypes.STRING(50),
      allowNull: true,
      unique: true
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
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    type: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'central',
    },
    address: {
      type: DataTypes.STRING,
      allowNull: true
    },
    city: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    region: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    country: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    latitude: {
      type: DataTypes.DECIMAL(10, 8),
      allowNull: true,
      validate: {
        min: -90,
        max: 90
      }
    },
    longitude: {
      type: DataTypes.DECIMAL(11, 8),
      allowNull: true,
      validate: {
        min: -180,
        max: 180
      }
    },
    capacity_max_units: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: 0
      }
    },
    allow_mermas: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true
    },
    rotation_policy: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'FIFO',
      validate: {
        isIn: [['FIFO', 'LIFO', 'FEFO']]
      }
    },
    status: {
      type: DataTypes.STRING(20),
      allowNull: false,
      defaultValue: 'activo',
      validate: {
        isIn: [['activo', 'inactivo']]
      }
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