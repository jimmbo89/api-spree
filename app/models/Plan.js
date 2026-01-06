'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Plan extends Model {
    static associate(models) {
      // Asociaciones se definirán cuando se implementen tenants, etc.
    }
  }

  Plan.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del plan'
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'El nombre del plan no puede estar vacío'
        }
      },
      comment: 'Nombre del plan (FREE, PRO, BUSINESS, ENTERPRISE)'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción del plan'
    },
    is_active: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true,
      comment: 'Indica si el plan está activo'
    },
    max_products: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Límite de productos (-1 = ilimitado)'
    },
    max_branches: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Límite de sucursales (-1 = ilimitado)'
    },
    max_stores: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Límite de almacenes (-1 = ilimitado)'
    },
    max_integrations: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Límite de integraciones (-1 = ilimitado)'
    },
    max_global_publications: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Límite de publicaciones en Marketplace Global'
    },
    max_pools: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Límite de warehouse pools (-1 = ilimitado)'
    },
    has_tenant_marketplace: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Indica si incluye Marketplace del Tenant'
    },
    has_custom_domain: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Indica si permite dominio personalizado'
    },
    has_multi_seller: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Indica si permite múltiples sellers en Tenant Marketplace'
    },
    has_headless_api: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Indica si incluye acceso a API headless'
    },
    ia_level: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: 'Nivel de IA: manual, auto, advanced, api'
    },
    global_commission_rate: {
      type: DataTypes.DECIMAL(10,2),
      allowNull: true,
      comment: 'Tasa de comisión global en porcentaje (ej: 5.00)'
    },
    sort_order: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: 'Orden para mostrar en UI'
    }
  }, {
    sequelize,
    modelName: 'Plan',
    tableName: 'plans',
    timestamps: true,
  });

  return Plan;
};