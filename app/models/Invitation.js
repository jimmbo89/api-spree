'use strict';
const {
  Model
} = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Invitation extends Model {
    /**
     * Helper method for defining associations.
     * This method is not a part of Sequelize lifecycle.
     * The `models/index` file will call this method automatically.
     */
    static associate(models) {
      Invitation.belongsTo(models.User, { foreignKey: 'user_id', as: 'user' });
    }
  }
  Invitation.init({
   id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true
    },
    token: {
      type: DataTypes.STRING,
      allowNull: true,
      unique: true
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
      validate: { isEmail: true }
    },
    status: {
      type: DataTypes.ENUM('pending', 'accepted', 'rejected'),
      defaultValue: 'pending'
    },
    user_id: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    invited_by: {
      type: DataTypes.INTEGER,
      allowNull: true
    },
    expires_at: {
      type: DataTypes.DATE,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'Invitation',
    tableName: 'invitations',
    timestamps: true,
  });
  return Invitation;
};