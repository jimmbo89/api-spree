'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceImportOperation extends Model {
    static associate(models) {
      MarketplaceImportOperation.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
      MarketplaceImportOperation.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      MarketplaceImportOperation.belongsTo(models.MarketplaceCredential, { foreignKey: 'credential_id', as: 'credential' });
      MarketplaceImportOperation.belongsTo(models.Marketplace, { foreignKey: 'marketplace_id', as: 'marketplace' });
      MarketplaceImportOperation.belongsTo(models.MarketplacePreviewOperation, {
        foreignKey: 'preview_operation_id',
        as: 'previewOperation'
      });
      MarketplaceImportOperation.hasMany(models.MarketplaceImportItem, {
        foreignKey: 'operation_id',
        as: 'items',
        onDelete: 'CASCADE'
      });
    }
  }

  MarketplaceImportOperation.init({
    id: { type: DataTypes.UUID, primaryKey: true, allowNull: false },
    preview_operation_id: { type: DataTypes.UUID, allowNull: false },
    company_id: { type: DataTypes.BIGINT, allowNull: false },
    user_id: { type: DataTypes.BIGINT, allowNull: false },
    credential_id: { type: DataTypes.BIGINT, allowNull: false },
    marketplace_id: { type: DataTypes.BIGINT, allowNull: false },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
    phase: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
    total: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    processed: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    success_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    error_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    skipped_count: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    cancel_requested: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    worker_id: { type: DataTypes.STRING(100), allowNull: true },
    lease_until: { type: DataTypes.DATE, allowNull: true },
    expires_at: { type: DataTypes.DATE, allowNull: false },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true },
    last_error: { type: DataTypes.JSON, allowNull: true }
  }, {
    sequelize,
    modelName: 'MarketplaceImportOperation',
    tableName: 'marketplace_import_operations',
    timestamps: true
  });

  return MarketplaceImportOperation;
};
