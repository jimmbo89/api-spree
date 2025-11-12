'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class Role extends Model {
    static associate(models) {
      Role.hasMany(models.User, { foreignKey: 'role_id', as: 'users' });
    }
  }

  Role.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true,
      comment: 'ID autoincremental del rol'
    },
    name: {
      type: DataTypes.STRING(200),
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: {
          msg: 'El nombre del rol no puede estar vacío'
        }
      },
      comment: 'Nombre único del rol (obligatorio)'
    },
    status: {
      type: DataTypes.BOOLEAN,
      allowNull: true,
      defaultValue: true,
      comment: 'Estado del rol (activo/inactivo)'
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
      comment: 'Descripción opcional del rol'
    }
  }, {
    sequelize,
    modelName: 'Role',
    tableName: 'roles',
    timestamps: true,
  });

  return Role;
};