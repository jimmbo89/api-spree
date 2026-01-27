'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Subscription extends Model {
    static associate(models) {
      Subscription.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      Subscription.belongsTo(models.Plan, { foreignKey: 'plan_id', as: 'plan', onDelete: 'RESTRICT' });
    }
  }

  Subscription.init({
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    plan_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'active'
    },
    start_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    end_date: {
      type: DataTypes.DATEONLY,
      allowNull: true
    },
    renewal_date: {
      type: DataTypes.DATEONLY,
      allowNull: false
    },
    billing_cycle: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'monthly'
    }
  }, {
    sequelize,
    modelName: 'Subscription',
    tableName: 'subscriptions',
    timestamps: true
  });

  return Subscription;
};