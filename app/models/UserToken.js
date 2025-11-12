'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class UserToken extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      // Relación con el modelo User
      UserToken.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    }
  }
  UserToken.init({
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,   // Indica que 'id' es la clave primaria
      autoIncrement: true // Esto hace que el campo 'id' sea auto-incrementable
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: false
    },
    token: {
      type: DataTypes.STRING,
      allowNull: false
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: true
    },
    revoked: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false
    }
  }, {
    sequelize,
    modelName: 'UserToken',
    tableName: 'user_tokens', // Asegúrate de que el nombre de la tabla sea correcto
    timestamps: true, // Si deseas incluir createdAt y updatedAt
  });
  return UserToken;
};