'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class BillingOrder extends Model {
    static associate(models) {
      BillingOrder.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      BillingOrder.belongsTo(models.Plan, { foreignKey: 'current_plan_id', as: 'currentPlan', onDelete: 'RESTRICT' });
      BillingOrder.belongsTo(models.Plan, { foreignKey: 'target_plan_id', as: 'targetPlan', onDelete: 'RESTRICT' });
    }
  }

  BillingOrder.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental de la orden'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    current_plan_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    target_plan_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    billing_cycle: {
      type: DataTypes.STRING,
      allowNull: false
    },
    type: {
      type: DataTypes.STRING,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'pending_payment'
    },
    total_amount: {
      type: DataTypes.DECIMAL(16,2),
      allowNull: false
    },
    currency: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'USD'
    },
    payment_method: {
      type: DataTypes.STRING,
      allowNull: false
    },
    payment_link_url: {
      type: DataTypes.STRING,
      allowNull: true
    },
    proof_url: {
      type: DataTypes.STRING,
      allowNull: true
    },
    invoice_request: {
      type: DataTypes.JSON,
      allowNull: true
    },
    effective_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    paid_at: {
      type: DataTypes.DATE,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'BillingOrder',
    tableName: 'billing_orders',
    timestamps: true
  });

  return BillingOrder;
};