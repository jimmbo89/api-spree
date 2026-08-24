'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class AuditEvent extends Model {
    static associate(models) {
      AuditEvent.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'CASCADE' });
      AuditEvent.belongsTo(models.Marketplace, { foreignKey: 'marketplace_id', as: 'marketplace', onDelete: 'SET NULL' });
      AuditEvent.belongsTo(models.MarketplaceCredential, { foreignKey: 'marketplace_credential_id', as: 'marketplaceCredential', onDelete: 'SET NULL' });
      AuditEvent.belongsTo(models.Pool, { foreignKey: 'pool_id', as: 'pool', onDelete: 'SET NULL' });
      AuditEvent.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse', onDelete: 'SET NULL' });
      AuditEvent.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'SET NULL' });
      AuditEvent.belongsTo(models.Job, { foreignKey: 'job_id', as: 'job', onDelete: 'SET NULL' });
      AuditEvent.belongsTo(models.Job, { foreignKey: 'origin_job_id', as: 'originJob', onDelete: 'SET NULL' });
      AuditEvent.belongsTo(models.AuditEvent, { foreignKey: 'parent_event_id', as: 'parentEvent', onDelete: 'SET NULL' });
      AuditEvent.hasMany(models.AuditEvent, { foreignKey: 'parent_event_id', as: 'childEvents' });
    }
  }

  AuditEvent.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    occurred_at: {
      type: DataTypes.DATE,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    module: {
      type: DataTypes.STRING(80),
      allowNull: false
    },
    action: {
      type: DataTypes.STRING(120),
      allowNull: false
    },
    result: {
      type: DataTypes.STRING(30),
      allowNull: false,
      defaultValue: 'success'
    },
    actor_type: {
      type: DataTypes.STRING(40),
      allowNull: false
    },
    actor_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    actor_name: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    resource_type: {
      type: DataTypes.STRING(80),
      allowNull: false
    },
    resource_id: {
      type: DataTypes.STRING(100),
      allowNull: false
    },
    resource_label: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    related_resource_type: {
      type: DataTypes.STRING(80),
      allowNull: true
    },
    related_resource_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    marketplace_credential_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    pool_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    job_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    origin_job_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    parent_event_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    previous_value: {
      type: DataTypes.JSON,
      allowNull: true
    },
    new_value: {
      type: DataTypes.JSON,
      allowNull: true
    },
    changes: {
      type: DataTypes.JSON,
      allowNull: true
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    metadata: {
      type: DataTypes.JSON,
      allowNull: true
    },
    correlation_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    dedupe_key: {
      type: DataTypes.STRING(190),
      allowNull: true,
      unique: true
    },
    ip_address: {
      type: DataTypes.STRING(45),
      allowNull: true
    },
    user_agent: {
      type: DataTypes.TEXT,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'AuditEvent',
    tableName: 'audit_events',
    timestamps: true
  });

  return AuditEvent;
};
