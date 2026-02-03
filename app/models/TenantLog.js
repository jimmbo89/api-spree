// models/tenantLog.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class TenantLog extends Model {
    static associate(models) {
      TenantLog.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company',
        onDelete: 'CASCADE'
      });
      TenantLog.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user',
        onDelete: 'SET NULL'
      });
    }
  }

  TenantLog.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID del log'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: 'ID de la empresa tenant'
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: 'ID del usuario del tenant'
    },
    module: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'sii, configuracion, documentos, notificaciones'
    },
    event_type: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'create, update, delete, error, success'
    },
    action: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Acción realizada'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción detallada'
    },
    meta: {  // ✅ Corregido: agregada la coma y el :
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Metadatos adicionales'
    },
    ip_address: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Dirección IP del cliente'
    },
    user_agent: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'User agent del navegador'
    },
    result: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'success',
      comment: 'success, error, warning'
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Mensaje de error si aplica'
    },
    createdAt: {  // ✅ Solo createdAt (inmutable)
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fecha de creación'
    },
    updatedAt: {  // ✅ Solo createdAt (inmutable)
      type: DataTypes.DATE,
      allowNull: false,
      comment: 'Fecha de creación'
    }
  }, {
    sequelize,
    modelName: 'TenantLog',
    tableName: 'tenant_logs',
    timestamps: true,  // ✅ Sin updatedAt (logs inmutables)
  });

  return TenantLog;
};