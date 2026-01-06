'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Permission extends Model {
    static associate(models) {
      Permission.hasMany(models.RolePermission, { foreignKey: 'permission_id', as: 'rolePermissions' });
      Permission.belongsToMany(models.Role, { 
        through: models.RolePermission, 
        foreignKey: 'permission_id',
        otherKey: 'role_id',
        as: 'roles' 
      });
    }
  }

  Permission.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del permiso'
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'El nombre del permiso no puede estar vacío'
        }
      },
      comment: 'Nombre único del permiso (ej: product.create)'
    },
    description: {
      type: DataTypes.STRING(255),
      allowNull: true,
      comment: 'Descripción del permiso'
    },
    service: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Microservicio o módulo (Product, Inventory, Publishing, etc.)'
    },
    resource: {
      type: DataTypes.STRING(50),
      allowNull: true,
      comment: 'Recurso sobre el que se aplica (product, branch, publication, etc.)'
    },
    action: {
      type: DataTypes.STRING(30),
      allowNull: true,
      comment: 'Acción realizada (create, view, edit, delete, publish, etc.)'
    },
    is_conditional: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: false,
      comment: 'Indica si el permiso requiere validación adicional (ACL, plan, etc.)'
    }
  }, {
    sequelize,
    modelName: 'Permission',
    tableName: 'permissions',
    timestamps: true,
  });

  return Permission;
};