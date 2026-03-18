// src/models/Job.js
'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Job extends Model {
    static associate(models) {
      // Job pertenece a un usuario
      Job.belongsTo(models.User, { 
        foreignKey: 'user_id', 
        as: 'user', 
        onDelete: 'SET NULL' 
      });

      // Job pertenece a una empresa
      Job.belongsTo(models.Company, { 
        foreignKey: 'company_id', 
        as: 'company', 
        onDelete: 'CASCADE' 
      });

      // Job tiene muchos productos (detalle de ejecución)
      Job.hasMany(models.JobProduct, { 
        foreignKey: 'job_id', 
        as: 'jobProducts', 
        onDelete: 'CASCADE' 
      });
    }
  }

  Job.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      references: {
        model: 'users',
        key: 'id'
      }
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: false,
      references: {
        model: 'companies',
        key: 'id'
      }
    },
    batch_id: {
      type: DataTypes.UUID,
      allowNull: false
    },
    
    // Tipo y configuración del job
    job_type: {
      type: DataTypes.ENUM('publish', 'draft', 'sync'),
      allowNull: false
    },
    mode: {
      type: DataTypes.STRING,
      allowNull: true
    },
    draft_name: {
      type: DataTypes.STRING,
      allowNull: true
    },
    
    // Métricas de progreso (denormalizadas para lectura rápida)
    total_products: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    processed: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    successful: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    errors_count: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    percentage: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0
    },
    
    // Estado del job
    status: {
      type: DataTypes.ENUM(
        'pending',
        'processing',
        'completed',
        'completed_with_errors',  // ✅ Agregado para diferenciar jobs con errores
        'failed',
        'cancelled'
      ),
      allowNull: false,
      defaultValue: 'pending'
    },
    
    // Configuración del job (marketplaces, pool, etc.)
    config: {
      type: DataTypes.JSON,
      allowNull: true
    },
    
    // Metadata de ejecución
    started_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    completed_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    error_summary: {
      type: DataTypes.JSON,
      allowNull: true
    },
    notified_users: {
      type: DataTypes.JSON,
      allowNull: true
    },
  }, {
    sequelize,
    modelName: 'Job',
    tableName: 'jobs',
    timestamps: true
  });

  return Job;
};