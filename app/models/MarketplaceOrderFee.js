'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceOrderFee extends Model {
    static associate(models) {
      // Un fee pertenece a una orden
      MarketplaceOrderFee.belongsTo(models.MarketplaceOrder, {
        foreignKey: 'order_id',
        as: 'order'
      });

      // Un fee puede pertenecer a un item
      MarketplaceOrderFee.belongsTo(models.MarketplaceOrderItem, {
        foreignKey: 'order_item_id',
        as: 'orderItem'
      });

      // Un fee pertenece a una empresa
      MarketplaceOrderFee.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company'
      });
    }
  }

  MarketplaceOrderFee.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    order_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      comment: 'Referencia a la orden padre'
    },
    order_item_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Referencia al item (si el fee es por item)'
    },
    
    // Tipo de fee
    fee_type: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'commission, shipping_fee, tax, fixed_fee, other'
    },
    
    // Montos
    amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      comment: 'Monto del fee'
    },
    percentage: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      comment: 'Porcentaje aplicado (si corresponde)'
    },
    
    // Estado
    status: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'pending',
      comment: 'pending, charged, paid, cancelled'
    },
    payout_date: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha de pago del fee (cuando se cobra)'
    },
    payout_reference: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Referencia del payout (ID de liquidación)'
    },
    
    // Metadatos
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción del fee'
    },
    raw_data: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Datos raw del fee para auditoría'
    },
    
    // Relaciones con entidades locales
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Empresa propietaria del fee'
    }
  }, {
    sequelize,
    modelName: 'MarketplaceOrderFee',
    tableName: 'marketplace_order_fees',
    timestamps: true
  });

  return MarketplaceOrderFee;
};
