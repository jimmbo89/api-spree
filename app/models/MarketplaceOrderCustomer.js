'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceOrderCustomer extends Model {
    static associate(models) {
      MarketplaceOrderCustomer.belongsTo(models.MarketplaceOrder, {
        foreignKey: 'order_id',
        as: 'order'
      });
    }
  }

  MarketplaceOrderCustomer.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    order_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    marketplace: {
      type: DataTypes.STRING(50),
      allowNull: false
    },
    marketplace_customer_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    first_name: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    last_name: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    full_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    phone_secondary: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    document_type: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    document_number: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    document_verifier: {
      type: DataTypes.STRING(20),
      allowNull: true
    },
    customer_type: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    legal_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    receiver_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    invoice_required: {
      type: DataTypes.BOOLEAN,
      allowNull: true
    },
    billing_address_line: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    billing_address_line_2: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    billing_city: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    billing_municipality: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    billing_state: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    billing_state_code: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    billing_zip_code: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    billing_country_code: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    billing_comment: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    shipping_address_line: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    shipping_address_line_2: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    shipping_city: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    shipping_municipality: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    shipping_state: {
      type: DataTypes.STRING(120),
      allowNull: true
    },
    shipping_state_code: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    shipping_zip_code: {
      type: DataTypes.STRING(50),
      allowNull: true
    },
    shipping_country_code: {
      type: DataTypes.STRING(10),
      allowNull: true
    },
    shipping_comment: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    shipping_reference: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    data_completeness: {
      type: DataTypes.STRING(20),
      allowNull: true,
      defaultValue: 'partial'
    },
    source_updated_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    raw_order_payload: {
      type: DataTypes.JSON,
      allowNull: true
    },
    raw_billing_payload: {
      type: DataTypes.JSON,
      allowNull: true
    },
    raw_shipping_payload: {
      type: DataTypes.JSON,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'MarketplaceOrderCustomer',
    tableName: 'marketplace_order_customers',
    timestamps: true
  });

  return MarketplaceOrderCustomer;
};
