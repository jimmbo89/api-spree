'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplacePreviewOperation extends Model {
    static associate(models) {
      MarketplacePreviewOperation.belongsTo(models.Company, {
        foreignKey: 'company_id',
        as: 'company'
      });
      MarketplacePreviewOperation.belongsTo(models.User, {
        foreignKey: 'user_id',
        as: 'user'
      });
      MarketplacePreviewOperation.belongsTo(models.MarketplaceCredential, {
        foreignKey: 'credential_id',
        as: 'credential'
      });
      MarketplacePreviewOperation.belongsTo(models.Marketplace, {
        foreignKey: 'marketplace_id',
        as: 'marketplace'
      });
      MarketplacePreviewOperation.hasMany(models.MarketplacePreviewItem, {
        foreignKey: 'operation_id',
        as: 'items',
        onDelete: 'CASCADE'
      });
    }
  }

  MarketplacePreviewOperation.init({
    id: {
      type: DataTypes.UUID,
      primaryKey: true,
      allowNull: false
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    credential_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'queued'
    },
    phase: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'queued'
    },
    total: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    processed: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    success_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    error_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    options: {
      type: DataTypes.JSON,
      allowNull: true
    },
    checkpoint: {
      type: DataTypes.JSON,
      allowNull: true
    },
    cancel_requested: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    },
    worker_id: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    lease_until: {
      type: DataTypes.DATE,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false
    },
    started_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    last_error: {
      type: DataTypes.JSON,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'MarketplacePreviewOperation',
    tableName: 'marketplace_preview_operations',
    timestamps: true
  });

  return MarketplacePreviewOperation;
};
