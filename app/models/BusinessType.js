'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class BusinessType extends Model {
    static associate(models) {
      // Define relaciones aquí si las necesitas en el futuro
      BusinessType.hasMany(models.Company, { foreignKey: 'business_type_id', as: 'companies' });
    }
  }

  BusinessType.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del tipo de negocio'
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'El nombre del tipo de negocio no puede estar vacío'
        }
      },
      comment: 'Nombre único del tipo de negocio (obligatorio)'
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true,
      comment: 'Estado del tipo de negocio (activo/inactivo)'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción opcional del tipo de negocio'
    }
  }, {
    sequelize,
    modelName: 'BusinessType',
    tableName: 'business_types',
    timestamps: true,
  });

  return BusinessType;
};