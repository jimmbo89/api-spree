'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Attribute extends Model {
    static associate(models) {
      // Relación: atributo pertenece a una empresa (puede ser NULL = global)
      Attribute.belongsTo(models.Company, { 
        foreignKey: 'company_id', 
        as: 'company',
        onDelete: 'SET NULL'
      });
      
      // Relación: un atributo tiene muchos product_attributes
      Attribute.hasMany(models.ProductAttribute, { 
        foreignKey: 'attribute_id', 
        as: 'productAttributes', 
        onDelete: 'CASCADE' 
      });
    }
  }

  Attribute.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del atributo'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ID de la empresa propietaria (NULL = atributo global)'
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      // ✅ unique: true eliminado - ahora puede haber atributos con mismo nombre en diferentes empresas
      validate: {
        notEmpty: {
          msg: 'El nombre del atributo no puede estar vacío'
        }
      },
      comment: 'Nombre del atributo (único por empresa si company_id no es NULL)'
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