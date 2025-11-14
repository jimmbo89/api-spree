'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Log extends Model {
    static associate(models) {
      Log.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    }
  }

  Log.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del registro de log'
    },
    user_id: { // snake_case en el modelo también (opcional, pero coherente con tu DB)
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'ID del usuario relacionado (opcional)'
    },
    action: {
      type: DataTypes.STRING(100),
      allowNull: false,
      validate: {
        notEmpty: { msg: 'La acción no puede estar vacía' }
      },
      comment: 'Nombre de la acción realizada (ej: auth.login)'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción legible del evento'
    },
    ip_address: {
      type: DataTypes.STRING(45),
      allowNull: true,
      comment: 'Dirección IP del cliente (IPv4 o IPv6)'
    },
    user_agent: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'User-Agent del cliente'
    },
    status: {
      type: DataTypes.ENUM('success', 'error', 'warning'),
      allowNull: false,
      defaultValue: 'success',
      comment: 'Estado del evento'
    },
    meta: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Datos adicionales en formato JSON'
    }
  }, {
    sequelize,
    modelName: 'Log',
    tableName: 'logs',
    timestamps: true,
  });

  return Log;
};