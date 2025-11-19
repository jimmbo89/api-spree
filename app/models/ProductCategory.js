'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductCategory extends Model {
    static associate(models) {
      // Ejemplo de relación futura (opcional):
      ProductCategory.hasMany(models.Product, { foreignKey: 'category_id', as: 'products' });
    }
  }

  ProductCategory.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental de la categoría de producto'
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'El nombre de la categoría no puede estar vacío'
        }
      },
      comment: 'Nombre único y obligatorio de la categoría'
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
    // Opcional: asegura que los nombres de tablas no se pluralicen incorrectamente
    // (aunque ya usas tableName, es redundante pero seguro)
  });

  return ProductCategory;
};