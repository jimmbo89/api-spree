'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Product extends Model {
    static associate(models) {
      Product.belongsTo(models.ProductCategory, { foreignKey: 'category_id', as: 'category', onDelete: 'SET NULL' });
      Product.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Product.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'SET NUll' });
      Product.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'SET NULL' });
      Product.hasMany(models.ProductPublishingTask, { foreignKey: 'product_id', as: 'publishingTasks', onDelete: 'CASCADE'});
    }
  }

  Product.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    sku: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0
    },
    category_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    base_price: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    user_id: {
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
     images: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: []
    }
  }, {
    sequelize,
    modelName: 'Product',
    tableName: 'products',
    timestamps: true
  });

  return Product;
};