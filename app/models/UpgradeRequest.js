'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class UpgradeRequest extends Model {
    static associate(models) {
      UpgradeRequest.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      UpgradeRequest.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'CASCADE' });
      UpgradeRequest.belongsTo(models.Plan, { foreignKey: 'current_plan_id', as: 'currentPlan', onDelete: 'RESTRICT' });
      UpgradeRequest.belongsTo(models.Plan, { foreignKey: 'target_plan_id', as: 'targetPlan', onDelete: 'RESTRICT' });
    }
  }

  UpgradeRequest.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental de la solicitud de actualización'
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    user_id: {
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
      allowNull: false,
      defaultValue: 'monthly'
    },
    message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'open'
    }
  }, {
    sequelize,
    modelName: 'UpgradeRequest',
    tableName: 'upgrade_requests',
    timestamps: true
  });

  return UpgradeRequest;
};