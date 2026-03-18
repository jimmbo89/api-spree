'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductPublishingTask extends Model {
    static associate(models) {
      ProductPublishingTask.belongsTo(models.Product, { foreignKey: 'product_id', as: 'product' });
      ProductPublishingTask.belongsTo(models.Marketplace, { foreignKey: 'marketplace_id', as: 'marketplace' });
      ProductPublishingTask.belongsTo(models.Warehouse, { foreignKey: 'warehouse_id', as: 'warehouse', onDelete: 'SET NULL' });
      ProductPublishingTask.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'SET NULL' }); // ✅ Nuevo
      ProductPublishingTask.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company' });
      ProductPublishingTask.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
      ProductPublishingTask.belongsTo(models.MarketplaceCredential, {  foreignKey: 'credential_id',  as: 'credential', onDelete: 'SET NULL' });
      ProductPublishingTask.belongsTo(models.Job, { 
        foreignKey: 'batch_id', 
        targetKey: 'batch_id', 
        as: 'job', 
        onDelete: 'SET NULL' 
      });
    }
  }

  ProductPublishingTask.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    warehouse_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true // ✅ Nuevo
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true // ✅ Nuevo
    },
    batch_id: {
      type: DataTypes.UUID,
      allowNull: true,
      defaultValue: DataTypes.UUIDV4 // ✅ Nuevo
    },
    credential_id: {
    type: DataTypes.BIGINT,
    allowNull: true,
    comment: 'ID de la credencial específica usada para esta publicación'
  },
    status: {
      type: DataTypes.ENUM(
        'draft',
        'pending',
        'processing',
        'published',
        'published_with_warnings',  // ✅ Nuevo status para publicaciones con advertencias
        'failed',
        'cancelled'
      ),
      allowNull: false,
      defaultValue: 'pending'
    },
    draft_name: {
      type: DataTypes.STRING(255),
      allowNull: true // ✅ Nuevo
    },
    publishing_mode: {
      type: DataTypes.STRING(50),
      allowNull: true,
      defaultValue: 'quick' // ✅ Nuevo
    },
    date: {
      type: DataTypes.DATEONLY,
      allowNull: false,
      defaultValue: DataTypes.NOW
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    error_details: {
      type: DataTypes.JSON,
      allowNull: true // ✅ Nuevo
    },
    api_response: {
      type: DataTypes.JSON,
      allowNull: true // ✅ Nuevo
    },
    payload: {
      type: DataTypes.JSON,
      allowNull: false
    },
    external_id: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    external_url: {
      type: DataTypes.STRING(500),
      allowNull: true
    },
    published_at: {
      type: DataTypes.DATE,
      allowNull: true // ✅ Nuevo
    },
    attempt_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1 // ✅ Nuevo
    }
  }, {
    sequelize,
    modelName: 'ProductPublishingTask',
    tableName: 'product_publishing_tasks',
    timestamps: true
  });

  return ProductPublishingTask;
};