'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class SiiCertificate extends Model {
    static associate(models) {
      SiiCertificate.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      SiiCertificate.hasMany(models.SiiCaf, { foreignKey: 'certificate_id', as: 'cafs', onDelete: 'CASCADE' });
    }
  }

  SiiCertificate.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID del certificado SII'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    certificate_path: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    password_hash: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    uploaded_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    document_types_enabled: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: []
    },
    folios_available: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {}
    },
    is_valid: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false
    }
  }, {
    sequelize,
    modelName: 'SiiCertificate',
    tableName: 'sii_certificates',
    timestamps: true
  });

  return SiiCertificate;
};