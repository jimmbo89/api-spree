'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceOrderItem extends Model {
    static associate(models) {
      // Un item pertenece a una orden
      MarketplaceOrderItem.belongsTo(models.MarketplaceOrder, {
        foreignKey: 'order_id',
        as: 'order'
      });

      // Un item pertenece a un producto
      MarketplaceOrderItem.belongsTo(models.Product, {
        foreignKey: 'product_id',
        as: 'product'
      });

      // Un item pertenece a una variante
      MarketplaceOrderItem.belongsTo(models.ProductVariant, {
        foreignKey: 'variant_id',
        as: 'variant'
      });

      // Un item pertenece a un movimiento de inventario
      MarketplaceOrderItem.belongsTo(models.InventoryMovement, {
        foreignKey: 'inventory_movement_id',
        as: 'inventoryMovement'
      });

      // Un item pertenece a una empresa
      MarketplaceOrderItem.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company'
      });

      // Un item pertenece a una sucursal
      MarketplaceOrderItem.belongsTo(models.Branch, {
        foreignKey: 'branch_id',
        as: 'branch'
      });

      // Un item pertenece a un usuario
      MarketplaceOrderItem.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user'
      });

      // Un item tiene muchos fees
      MarketplaceOrderItem.hasMany(models.MarketplaceOrderFee, {
        foreignKey: 'order_item_id',
        as: 'fees'
      });
    }

    /**
     * Calcula la ganancia bruta del item
     * @returns {Decimal} Ganancia bruta
     */
    getGrossProfit() {
      const totalPrice = parseFloat(this.total_price || 0);
      const totalCost = parseFloat(this.total_cost || 0);
      
      // Obtener fees asociados al item
      const totalFees = this.fees?.reduce((sum, fee) => {
        return sum + parseFloat(fee.amount || 0);
      }, 0) || 0;

      return totalPrice - totalCost - totalFees;
    }

    /**
     * Calcula el margen de ganancia en porcentaje
     * @returns {Number} Margen en porcentaje (0-100)
     */
    getMarginPercentage() {
      const totalPrice = parseFloat(this.total_price || 0);
      if (totalPrice === 0) return 0;
      
      const grossProfit = this.getGrossProfit();
      return (grossProfit / totalPrice) * 100;
    }
  }

  MarketplaceOrderItem.init({
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
    
    // Identificación del item
    marketplace_item_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'ID del item en el marketplace'
    },
    listing_id: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'External ID del listing (product_marketplace_links)'
    },
    sku: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: 'SKU del producto'
    },
    title: { type: DataTypes.STRING(500), allowNull: true },
    user_product_id: { type: DataTypes.STRING(100), allowNull: true },
    marketplace_attributes: { type: DataTypes.JSON, allowNull: true },
    managed_by_spree: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    
    // Vínculo con productos locales
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Producto local asociado'
    },
    variant_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Variante local asociada'
    },
    
    // Relaciones con entidades locales
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Empresa propietaria del item'
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Sucursal asociada al item'
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Usuario que publicó el producto'
    },
    
    // Cantidad y precios
    quantity: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
      comment: 'Cantidad del item'
    },
    unit_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      comment: 'Precio unitario del item'
    },
    total_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: false,
      comment: 'Precio total (quantity * unit_price)'
    },
    
    // Descuentos e impuestos
    discount_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
      comment: 'Descuento aplicado al item'
    },
    tax_amount: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      defaultValue: 0,
      comment: 'Impuestos aplicados al item'
    },
    
    // Costos
    cost_price: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Costo unitario del producto (para cálculo de ganancias)'
    },
    total_cost: {
      type: DataTypes.DECIMAL(12, 2),
      allowNull: true,
      comment: 'Costo total (quantity * cost_price)'
    },
    
    // Vínculo con movimiento de inventario
    inventory_movement_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Movimiento de inventario asociado a este item'
    }
  }, {
    sequelize,
    modelName: 'MarketplaceOrderItem',
    tableName: 'marketplace_order_items',
    timestamps: true
  });

  return MarketplaceOrderItem;
};
