// models/siiCaf.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class SiiCaf extends Model {
    static associate(models) {
      SiiCaf.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });
      SiiCaf.belongsTo(models.SiiCertificate, {
        foreignKey: 'certificate_id',
        as: 'certificate',
        onDelete: 'CASCADE'
      });
    }
  }

  SiiCaf.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID del CAF'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    certificate_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    document_type: {
      type: DataTypes.STRING(3),
      allowNull: true
    },
    folio_start: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    folio_end: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    folio_next: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    issue_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    expiration_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    caf_xml: {
      type: DataTypes.TEXT('long'),
      allowNull: true
    },
    private_key: {
      type: DataTypes.TEXT('long'),
      allowNull: true
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true
    },
    is_exhausted: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true
    },
    used_count: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0
    },
    remaining_count: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0
    }
  }, {
    sequelize,
    modelName: 'SiiCaf',
    tableName: 'sii_cafs',
    timestamps: true
  });

  return SiiCaf;
};