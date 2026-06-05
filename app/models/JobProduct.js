// src/models/JobProduct.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class JobProduct extends Model {
    static associate(models) {
      // JobProduct pertenece a un Job padre
      JobProduct.belongsTo(models.Job, { 
        foreignKey: 'job_id', 
        as: 'job', 
        onDelete: 'CASCADE' 
      });

      // JobProduct pertenece a un producto (si existe en tu sistema)
      JobProduct.belongsTo(models.Product, { 
        foreignKey: 'product_id', 
        as: 'product', 
        onDelete: 'SET NULL' 
      });

      // JobProduct pertenece a un marketplace
      JobProduct.belongsTo(models.Marketplace, { 
        foreignKey: 'marketplace_id', 
        as: 'marketplace', 
        onDelete: 'SET NULL' 
      });

      // JobProduct pertenece a una credencial (opcional)
      JobProduct.belongsTo(models.MarketplaceCredential, {
        foreignKey: 'credential_id',
        as: 'credential',
        onDelete: 'SET NULL'
      });

      // ✅ JobProduct tiene referencia a un ProductPublishingTask (opcional)
      JobProduct.belongsTo(models.ProductPublishingTask, {
        foreignKey: 'task_id',
        as: 'task',
        onDelete: 'SET NULL'
      });
    }
  }

  JobProduct.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    job_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: {
        model: 'jobs',
        key: 'id'
      }
    },
    product_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: {
        model: 'products',
        key: 'id'
      }
    },
    credential_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'marketplace_credentials',
        key: 'id'
      }
    },
    marketplace_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: {
        model: 'marketplaces',
        key: 'id'
      }
    },
    
    // Estado individual del producto
    status: {
      type: DataTypes.STRING(32),
      allowNull: false,
      defaultValue: 'pending',
      validate: {
        isIn: [['pending', 'processing', 'success', 'error', 'retrying', 'deleted']]
      }
    },
    
    // Resultado de la publicación
    external_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    external_url: {
      type: DataTypes.STRING,
      allowNull: true
    },
    error_message: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    error_details: {
      type: DataTypes.JSON,
      allowNull: true
    },
    
    // Control de intentos
    attempt_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    last_attempt_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    
    // Payload original del producto (para reintentar sin consultar de nuevo)
    product_payload: {
      type: DataTypes.JSON,
      allowNull: true
    },
    marketplace_payload: {
      type: DataTypes.JSON,
      allowNull: true
    },
    // ✅ Referencia al product_publishing_task creado
    task_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      comment: 'Referencia al product_publishing_task creado para este producto',
      references: {
        model: 'product_publishing_tasks',
        key: 'id'
      }
    }
  }, {
    sequelize,
    modelName: 'JobProduct',
    tableName: 'job_products',
    timestamps: true,
  });

  return JobProduct;
};
