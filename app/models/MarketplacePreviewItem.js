'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class MarketplacePreviewItem extends Model {
    static associate(models) {
      MarketplacePreviewItem.belongsTo(models.MarketplacePreviewOperation, {
        foreignKey: 'operation_id',
        as: 'operation',
        onDelete: 'CASCADE'
      });
    }
  }

  MarketplacePreviewItem.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    operation_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    sequence: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    external_id: {
      type: DataTypes.STRING(150),
      allowNull: false
    },
    external_variant_id: {
      type: DataTypes.STRING(150),
      allowNull: true
    },
    sku: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    status: {
      type: DataTypes.STRING(32),
      allowNull: false
    },
    data: {
      type: DataTypes.JSON,
      allowNull: false
    },
    source_payload: {
      type: DataTypes.JSON,
      allowNull: true
    },
    error: {
      type: DataTypes.JSON,
      allowNull: true
    },
    fetched_at: {
      type: DataTypes.DATE,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'MarketplacePreviewItem',
    tableName: 'marketplace_preview_items',
    timestamps: true
  });

  return MarketplacePreviewItem;
};
