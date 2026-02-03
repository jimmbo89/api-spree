'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class FeatureFlag extends Model {
    static associate(models) {
      FeatureFlag.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });
    }
  }

  FeatureFlag.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID del feature flag'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    flag_key: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    is_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false
    },
    source: {
      type: DataTypes.STRING(255), //ENUM('plan', 'backoffice', 'manual')
      allowNull: true,
      defaultValue: 'plan'
    }
  }, {
    sequelize,
    modelName: 'FeatureFlag',
    tableName: 'feature_flags',
    timestamps: true
  });

  return FeatureFlag;
};