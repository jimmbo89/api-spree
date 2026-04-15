'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class VariantDefinition extends Model {
    static associate(models) {
      VariantDefinition.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'SET NULL'
      });

      VariantDefinition.hasMany(models.VariantValue, {
        foreignKey: 'variant_definition_id',
        as: 'values',
        onDelete: 'CASCADE'
      });
    }
  }

  VariantDefinition.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING,
      allowNull: true
    },
    cant: {
      type: DataTypes.INTEGER,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'VariantDefinition',
    tableName: 'variant_definitions',
    timestamps: true
  });

  return VariantDefinition;
};
