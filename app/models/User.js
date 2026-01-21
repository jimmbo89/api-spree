'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class User extends Model {
    static associate(models) {
      User.hasMany(models.UserToken, { foreignKey: 'user_id', as: 'tokens', onDelete: 'CASCADE' });
      // Relación con Role
      User.hasMany(models.Invitation, { foreignKey: 'user_id', as: 'invitations', onDelete: 'SET NULL' });
      User.hasMany(models.Invitation, { foreignKey: 'invited_by', as: 'inviteds', onDelete: 'SET NULL' });
      User.hasMany(models.Company, { foreignKey: 'user_id', as: 'companies', onDelete: 'SET NULL' });
      User.hasMany(models.Branch, { foreignKey: 'user_id', as: 'branches', onDelete: 'SET NULL' });
      User.hasMany(models.Product, { foreignKey: 'user_id', as: 'products', onDelete: 'SET NULL' });
      User.hasMany(models.ProductPublishingTask, { foreignKey: 'user_id', as: 'publishingTasks', onDelete: 'SET NULL' });
      User.hasMany(models.Pool, { foreignKey: 'user_id', as: 'pools', onDelete: 'CASCADE' });
      User.hasMany(models.UserCompany, { foreignKey: 'user_id', as: 'memberships', onDelete: 'CASCADE' });
      User.hasMany(models.UserAclScope, { foreignKey: 'user_id', as: 'aclScopes', onDelete: 'CASCADE' });
      User.hasMany(models.MarketplaceCredential, { foreignKey: 'user_id', as: 'credentials', onDelete: 'CASCADE' });
    }
  }

  User.init({
    id: {
      type: DataTypes.BIGINT, // 👈 Ajustado a BIGINT como en tu migración
      primaryKey: true,
      autoIncrement: true
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        len: {
          args: [2, 255],
          msg: "El nombre tiene que ser mínimo de dos caracteres"
        }
      }
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true,
      validate: {
        isEmail: {
          msg: 'Debe ser un correo electrónico válido'
        }
      }
    },
    email_verified_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: {
        len: {
          args: [6, 255], // 👈 Corregido: mínimo 6 caracteres (no 2)
          msg: "La contraseña debe tener al menos seis caracteres"
        }
      }
    },
    remember_token: {
      type: DataTypes.STRING,
      allowNull: true
    },
    external_id: {
      type: DataTypes.STRING,
      allowNull: true
    },
    external_auth: {
      type: DataTypes.STRING,
      allowNull: true
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Estado del usuario: true = activo, false = inactivo'
    },
    image: {
      type: DataTypes.STRING,
      allowNull: true
    },
    registration_date: {
      type: DataTypes.DATE,
      allowNull: true,
      comment: 'Fecha en que el usuario se registró'
    },
    user: {
      type: DataTypes.STRING,
      allowNull: true
    },
     reset_token: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    reset_expire: {
      type: DataTypes.BIGINT,
      allowNull: true,
    },
  }, {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    timestamps: true,
  });

  return User;
};