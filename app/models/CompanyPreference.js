'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class CompanyPreference extends Model {
    static associate(models) {
      CompanyPreference.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });
    }
  }

  CompanyPreference.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental de las preferencias del tenant'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true
    },
    timezone: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'America/Santiago'
    },
    language: {
      type: DataTypes.STRING(10),
      allowNull: true,
      defaultValue: 'es-CL'
    },
    date_format: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: 'DD/MM/YYYY'
    }
  }, {
    sequelize,
    modelName: 'CompanyPreference',
    tableName: 'company_preferences',
    timestamps: true
  });

  return CompanyPreference;
};