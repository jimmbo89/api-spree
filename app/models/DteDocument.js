// models/dteDocument.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class DTEDocument extends Model {
    static associate(models) {
      DTEDocument.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });
      DTEDocument.belongsTo(models.DTEDocument, {
        foreignKey: 'referenced_document_id',
        as: 'referencedDocument',
        onDelete: 'SET NULL'
      });
    }
  }

  DTEDocument.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID del documento DTE'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    document_type: {
      type: DataTypes.STRING,
      allowNull: true
    },
    folio: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    rut_emisor: {
      type: DataTypes.STRING,
      allowNull: true
    },
    rut_receptor: {
      type: DataTypes.STRING,
      allowNull: true
    },
    razon_social_receptor: {
      type: DataTypes.STRING,
      allowNull: true
    },
    giro_receptor: {
      type: DataTypes.STRING,
      allowNull: true
    },
    direccion_receptor: {
      type: DataTypes.STRING,
      allowNull: true
    },
    comuna_receptor: {
      type: DataTypes.STRING,
      allowNull: true
    },
    ciudad_receptor: {
      type: DataTypes.STRING,
      allowNull: true
    },
    monto_neto: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    monto_iva: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    monto_total: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true
    },
    fecha_emision: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    sii_status: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'pendiente'
    },
    track_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    sii_response: {
      type: DataTypes.TEXT('long'),
      allowNull: true
    },
    sii_error_code: {
      type: DataTypes.STRING,
      allowNull: true
    },
    sii_error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    xml_dte: {
      type: DataTypes.TEXT('long'),
      allowNull: true
    },
    xml_envio: {
      type: DataTypes.TEXT('long'),
      allowNull: true
    },
    referenced_document_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    detalles: {
      type: DataTypes.JSON,
      allowNull: true
    },
    order_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    order_type: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'DTEDocument',
    tableName: 'dte_documents',
    timestamps: true
  });

  return DTEDocument;
};