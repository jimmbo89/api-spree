'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class VariantValue extends Model {
    static associate(models) {
      VariantValue.belongsTo(models.VariantDefinition, {
        foreignKey: 'variant_definition_id',
        as: 'definition',
        onDelete: 'CASCADE'
      });

      VariantValue.belongsToMany(models.ProductVariant, {
        through: models.ProductVariantValue,
        foreignKey: 'variant_value_id',
        otherKey: 'product_variant_id',
        as: 'productVariants'
      });
    }
  }

  VariantValue.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },
    variant_definition_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true
    }
  }, {
    sequelize,
    modelName: 'VariantValue',
    tableName: 'variant_values',
    timestamps: true
  });

  return VariantValue;
};
