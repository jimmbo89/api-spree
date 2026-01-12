'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Attribute extends Model {
    static associate(models) {
      // Puedes agregar relaciones aquí si decides usar product_attributes después
      Attribute.hasMany(models.ProductAttribute, { foreignKey: 'attribute_id', as: 'productAttributes', onDelete: 'CASCADE' });
    }
  }

  Attribute.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del atributo'
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'El nombre del atributo no puede estar vacío'
        }
      },
      comment: 'Nombre único del atributo (obligatorio)'
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: {
          msg: 'El tipo del atributo no puede estar vacío'
        }
      },
      comment: 'Tipo del atributo (ej: text, number, select, etc.)'
    },
    cant: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Cantidad o cardinalidad asociada al atributo'
    }
  }, {
    sequelize,
    modelName: 'Attribute',
    tableName: 'attributes',
    timestamps: true,
  });

  return Attribute;
};