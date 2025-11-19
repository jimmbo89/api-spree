'use strict';
const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class User extends Model {
    static associate(models) {
      User.hasMany(models.UserToken, { foreignKey: 'user_id', as: 'tokens', onDelete: 'CASCADE' });
      // Relación con Role
      User.belongsTo(models.Role, { foreignKey: 'role_id', as: 'role', onDelete: 'SET NULL' });
      User.hasMany(models.Invitation, { foreignKey: 'user_id', as: 'invitations', onDelete: 'SET NULL' });
      User.hasMany(models.Invitation, { foreignKey: 'invited_by', as: 'inviteds', onDelete: 'SET NULL' });
      User.hasMany(models.Company, { foreignKey: 'user_id', as: 'companies', onDelete: 'SET NULL' });
      User.hasMany(models.Branch, { foreignKey: 'user_id', as: 'branches', onDelete: 'SET NULL' });
      User.hasMany(models.Product, { foreignKey: 'user_id', as: 'products', onDelete: 'SET NULL' });
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
    role_id: {
      type: DataTypes.BIGINT,
      allowNull: true, // o false si es obligatorio
      references: {
        model: 'roles',
        key: 'id'
      },
      comment: 'ID del rol asignado al usuario'
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
  }, {
    sequelize,
    modelName: 'User',
    tableName: 'users',
    timestamps: true,
  });

  function normalizeRoles(roles) {
    if (!roles) return [];

    // Si es un string, devolver array con ese string
    if (typeof roles === 'string') {
      return [roles];
    }

    // Si es un array
    if (Array.isArray(roles)) {
      return roles.map(role => {
        if (typeof role === 'string') return role;
        if (role && typeof role === 'object' && typeof role.name === 'string') return role.name;
        return null; // o lanzar error si prefieres
      }).filter(Boolean); // elimina nulos/undefined
    }

    // Si es un objeto con propiedad 'name' (ej: rol individual como { name: 'admin' })
    if (roles && typeof roles === 'object' && typeof roles.name === 'string') {
      return [roles.name];
    }

    // Si no coincide con nada, devolver vacío
    return [];
  }

  User.hasRole = function(roles, targetRoles) {
    const normalizedInput = normalizeRoles(roles);
    const targets = Array.isArray(targetRoles) ? targetRoles : [targetRoles];
    return normalizedInput.some(role => targets.includes(role));
  };

  // Métodos específicos (opcionales, para retrocompatibilidad o conveniencia)
  User.isAdmin = function(roles) {
    return User.hasRole(roles, ['Admin']);
  };

  User.isEditer = function(roles) {
    return User.hasRole(roles, ['Editor', 'Admin']);
  };

   User.isViewer = function(roles) {
    return User.hasRole(roles, ['Viewer', 'Editor', 'Admin']);
  };

  return User;
};