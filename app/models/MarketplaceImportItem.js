'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplaceImportItem extends Model {
    static associate(models) {
      MarketplaceImportItem.belongsTo(models.MarketplaceImportOperation, {
        foreignKey: 'operation_id',
        as: 'operation',
        onDelete: 'CASCADE'
      });
      MarketplaceImportItem.belongsTo(models.MarketplacePreviewItem, {
        foreignKey: 'preview_item_id',
        as: 'previewItem'
      });
      MarketplaceImportItem.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });
      MarketplaceImportItem.belongsTo(models.ProductMarketplaceLink, { foreignKey: 'link_id', as: 'link' });
    }
  }

  MarketplaceImportItem.init({
    id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
    operation_id: { type: DataTypes.UUID, allowNull: false },
    preview_item_id: { type: DataTypes.BIGINT, allowNull: false },
    action: { type: DataTypes.STRING(16), allowNull: false },
    payload: { type: DataTypes.JSON, allowNull: false, defaultValue: {} },
    status: { type: DataTypes.STRING(32), allowNull: false, defaultValue: 'queued' },
    product_id: { type: DataTypes.BIGINT, allowNull: true },
    link_id: { type: DataTypes.BIGINT, allowNull: true },
    result: { type: DataTypes.JSON, allowNull: true },
    error: { type: DataTypes.JSON, allowNull: true },
    started_at: { type: DataTypes.DATE, allowNull: true },
    completed_at: { type: DataTypes.DATE, allowNull: true }
  }, {
    sequelize,
    modelName: 'MarketplaceImportItem',
    tableName: 'marketplace_import_items',
    timestamps: true
  });

  return MarketplaceImportItem;
};
