'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceOrder extends Model {
    static associate(models) {
      // Una orden pertenece a una credencial de marketplace
      MarketplaceOrder.belongsTo(models.MarketplaceCredential, {
        foreignKey: 'marketplace_credential_id',
        as: 'credential'
      });

      // Una orden pertenece a una empresa
      MarketplaceOrder.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company'
      });

      // Una orden pertenece a una sucursal
      MarketplaceOrder.belongsTo(models.Branch, {
        foreignKey: 'branch_id',
        as: 'branch'
      });

      // Una orden pertenece a un usuario
      MarketplaceOrder.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user'
      });

      // Una orden tiene muchos items
      MarketplaceOrder.hasMany(models.MarketplaceOrderItem, {
        foreignKey: 'order_id',
        as: 'items'
      });

      // Una orden tiene muchos fees/comisiones
      MarketplaceOrder.hasMany(models.MarketplaceOrderFee, {
        foreignKey: 'order_id',
        as: 'fees'
      });

      // Una orden tiene muchos eventos
      MarketplaceOrder.hasMany(models.MarketplaceOrderEvent, {
        foreignKey: 'order_id',
        as: 'events'
      });

      MarketplaceOrder.hasOne(models.MarketplaceOrderCustomer, {
        foreignKey: 'order_id',
        as: 'customerSnapshot'
      });
    }

    /**
     * Calcula la ganancia bruta de la orden
     * @returns {Decimal} Ganancia bruta
     */
    getGrossProfit() {
      const totalAmount = parseFloat(this.total_amount || 0);
      const shippingTotal = parseFloat(this.shipping_total || 0);
      const taxTotal = parseFloat(this.tax_total || 0);
      const subtotal = totalAmount - shippingTotal - taxTotal;
      
      // Sumar costos de items
      const totalCost = this.items?.reduce((sum, item) => {
        return sum + parseFloat(item.total_cost || 0);
      }, 0) || 0;

      // Sumar fees
      const totalFees = this.fees?.reduce((sum, fee) => {
        return sum + parseFloat(fee.amount || 0);
      }, 0) || 0;

      return subtotal - totalCost - totalFees;
    }

    /**
     * Calcula el margen de ganancia en porcentaje
     * @returns {Number} Margen en porcentaje (0-100)
     */
    getMarginPercentage() {
      const totalAmount = parseFloat(this.total_amount || 0);
      if (totalAmount === 0) return 0;
      
      const grossProfit = this.getGrossProfit();
      return (grossProfit / totalAmount) * 100;
    }
  }

  MarketplaceOrder.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    marketplace: {
      type: DataTypes.STRING(50),
      allowNull: false,
      comment: 'mercadolibre, falabella, etc.'
    },
    marketplace_order_id: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: 'ID de la orden en el marketplace'
    },
    marketplace_credential_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Credencial usada para esta orden'
    },
    
    // Estados
    order_status: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'paid, cancelled, returned, pending, etc.'
    },
    payment_status: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'paid, pending, cancelled, refunded'
    },
    
    // Totales de la orden
    subtotal: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Subtotal sin impuestos ni envíos'
    },
    shipping_total: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
      comment: 'Total de envíos'
    },
    discount_total: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
      comment: 'Total de descuentos'
    },
    tax_total: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
      comment: 'Total de impuestos'
    },
    total_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Monto total de la orden'
    },
    currency: {
      type: DataTypes.STRING(10),
      allowNull: true,
      defaultValue: 'CLP',
      comment: 'Moneda de la orden'
    },
    
    // Cliente
    buyer_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID del comprador en el marketplace'
    },
    buyer_name: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Nombre del comprador'
    },
    buyer_email: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Email del comprador'
    },
    buyer_document: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Documento tributario del comprador (RUT, etc.)'
    },
    
    // Pagos
    payment_method: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'credit_card, debit_card, bank_transfer, etc.'
    },
    payment_date: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha de pago'
    },
    
    // Envío
    shipping_address: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Dirección completa de envío'
    },
    shipping_city: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Ciudad de envío'
    },
    shipping_region: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Región/Estado de envío'
    },
    
    // Documento tributario
    invoice_type: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'boleta, factura, ticket'
    },
    invoice_number: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'Número de documento tributario'
    },
    invoice_date: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha de emisión del documento'
    },
    
    // Raw payload para auditoría
    raw_payload: {
      type: DataTypes.JSON,
      allowNull: true,
      comment: 'Payload completo de la orden para auditoría'
    },
    
    // Relaciones con entidades locales
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Empresa propietaria de la orden'
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Sucursal asociada a la orden'
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Usuario que publicó el producto/gestionó la orden'
    }
  }, {
    sequelize,
    modelName: 'MarketplaceOrder',
    tableName: 'marketplace_orders',
    timestamps: true
  });

  return MarketplaceOrder;
};
