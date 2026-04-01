'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceOrderEvent extends Model {
    static associate(models) {
      // Un evento pertenece a una orden
      MarketplaceOrderEvent.belongsTo(models.MarketplaceOrder, {
        foreignKey: 'order_id',
        as: 'order'
      });

      // Un evento puede pertenecer a un webhook event
      MarketplaceOrderEvent.belongsTo(models.MarketplaceWebhookEvent, {
        foreignKey: 'webhook_event_id',
        as: 'webhookEvent'
      });

      // Un evento pertenece a una empresa
      MarketplaceOrderEvent.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company'
      });
    }
  }

  MarketplaceOrderEvent.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    order_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: 'Referencia a la orden'
    },
    webhook_event_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Evento webhook que originó este cambio (si aplica)'
    },
    
    // Tipo de evento
    event_type: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'created, paid, cancelled, returned, shipped, refunded'
    },
    
    // Estado antes/después
    previous_status: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Estado anterior al evento'
    },
    new_status: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Nuevo estado después del evento'
    },
    
    // Raw payload
    raw_payload: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Payload completo del evento para auditoría'
    },
    
    // Metadatos adicionales
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Notas adicionales del evento'
    },
    
    // Relaciones con entidades locales
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Empresa propietaria del evento'
    }
  }, {
    sequelize,
    modelName: 'MarketplaceOrderEvent',
    tableName: 'marketplace_order_events',
    timestamps: true
  });

  return MarketplaceOrderEvent;
};
