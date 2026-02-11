'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Company extends Model {
    static associate(models) {
      // Relación: una empresa tiene muchas sucursales
      Company.hasMany(models.Branch, { foreignKey: 'company_id', as: 'branches', onDelete: 'CASCADE' });
      Company.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Company.belongsTo(models.BusinessType, { foreignKey: 'business_type_id', as: 'businessType', });
      Company.belongsTo(models.Plan, { foreignKey: 'plan_id', as: 'plan' });      
      Company.hasMany(models.Product, { foreignKey: 'company_id', as: 'products', onDelete: 'SET NULL' });
      Company.hasMany(models.Warehouse, { foreignKey: 'company_id', as: 'warehouses', onDelete: 'SET NULL' });
      Company.hasMany(models.ProductMarketplaceLink, { foreignKey: 'company_id', as: 'productmarketplacelinks', onDelete: 'SET NULL' });
      Company.hasMany(models.Pool, { foreignKey: 'company_id', as: 'pools', onDelete: 'CASCADE' });
      Company.hasMany(models.UserCompany, { foreignKey: 'company_id', as: 'memberships', onDelete: 'CASCADE' });
      Company.hasMany(models.Notification, { foreignKey: 'company_id', as: 'notifications', onDelete: 'SET NULL' });
      Company.hasMany(models.UpgradeRequest, { foreignKey: 'company_id', as: 'upgradeRequests', onDelete: 'CASCADE' });
      Company.hasOne(models.CompanyPreference, { foreignKey: 'company_id', as: 'preference', onDelete: 'CASCADE' });
      Company.hasOne(models.SiiConfiguration, { foreignKey: 'company_id', as: 'siiConfig', onDelete: 'CASCADE' });
      Company.hasMany(models.SiiCertificate, { foreignKey: 'company_id', as: 'siiCertificates', onDelete: 'CASCADE' });
      Company.hasMany(models.FeatureFlag, { foreignKey: 'company_id', as: 'featureFlags', onDelete: 'CASCADE' });
      Company.hasMany(models.SiiCaf, {  foreignKey: 'company_id',  as: 'siiCafs',  onDelete: 'CASCADE'  });
      //Company.hasMany(models.TenantLog, { foreignKey: 'company_id', as: 'tenantLogs', onDelete: 'CASCADE' });
      //Company.hasOne(models.NotificationSetting, { foreignKey: 'company_id', as: 'notificationSetting', onDelete: 'CASCADE' });
    }
  }

  Company.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      validate: {
        isInt: {
          msg: 'El campo user_id debe ser un número entero'
        }
      }
    },
    business_type_id: {
      type: DataTypes.BIGINT,
      allowNull: true,
      validate: {
        isInt: {
          msg: 'El campo business_type_id debe ser un número entero'
        }
      }
    },
    plan_id: { // 👈 NUEVO
      type: DataTypes.BIGINT,
      allowNull: true,
      validate: {
        isInt: {
          msg: 'El campo plan_id debe ser un número entero'
        }
      }
    },
    name: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    description: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    rut: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
    },
    address: {
      type: DataTypes.STRING,
      allowNull: true
    },
    city: {
      type: DataTypes.STRING,
      allowNull: true
    },
    country: {
      type: DataTypes.STRING,
      allowNull: true
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'companies/default.jpg'
    },
    email: {
    type: DataTypes.STRING,
    allowNull: true,
    validate: {
      isEmail: {
        msg: 'El campo email debe ser una dirección de correo válida'
      }
    }
  },
  currency: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  }, {
    sequelize,
    modelName: 'Company',
    tableName: 'companies',
    timestamps: true
  });

  return Company;
};