'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceWebhookEvent extends Model {
    static associate(models) {
      // Sin asociaciones por ahora
    }
  }

  MarketplaceWebhookEvent.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    marketplace: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    topic: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    resource: {
      type: DataTypes.STRING(255),
      allowNull: false
    },
    event_id: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    external_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    marketplace_user_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    status: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'received'
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: true
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    processed_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'MarketplaceWebhookEvent',
    tableName: 'marketplace_webhook_events',
    timestamps: true
  });

  return MarketplaceWebhookEvent;
};
