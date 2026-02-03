'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class SiiConfiguration extends Model {
    static associate(models) {
      SiiConfiguration.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });
    }
  }

  SiiConfiguration.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID de configuración SII'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      unique: true
    },
    rut: {
      type: DataTypes.STRING(12),
      allowNull: true
    },
    legal_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    sii_environment: {
      type: DataTypes.STRING(255), //.ENUM('production', 'certification'),
      allowNull: true,
      defaultValue: 'certification'
    },
    contributor_type: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    is_connected: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false
    },
    connected_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    disconnected_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'SiiConfiguration',
    tableName: 'sii_configurations',
    timestamps: true
  });

  return SiiConfiguration;
};