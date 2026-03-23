'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductCategory extends Model {
    static associate(models) {
      // Relación: categoría pertenece a una empresa (puede ser NULL = global)
      ProductCategory.belongsTo(models.Company, { 
        foreignKey: 'company_id', 
        as: 'company',
        onDelete: 'SET NULL'
      });
      
      // Relación: una categoría tiene muchos productos
      ProductCategory.hasMany(models.Product, { 
        foreignKey: 'category_id', 
        as: 'products',
        onDelete: 'SET NULL'
      });
    }
  }

  ProductCategory.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental de la categoría de producto'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ID de la empresa propietaria (NULL = categoría global)'
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      // ✅ unique: true eliminado - ahora puede haber categorías con mismo nombre en diferentes empresas
      validate: {
        notEmpty: {
          msg: 'El nombre de la categoría no puede estar vacío'
        }
      },
      comment: 'Nombre de la categoría (único por empresa si company_id no es NULL)'
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true,
      comment: 'Estado activo/inactivo de la categoría'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción opcional de la categoría'
    }
  }, {
    sequelize,
    modelName: 'ProductCategory',
    tableName: 'product_categories',
    timestamps: true,
  });

  return ProductCategory;
};