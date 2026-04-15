'use strict';

const { Model } = require('sequelize');

module.exports = (sequelize, DataTypes) => {
  class ProductVariantValue extends Model {
    static associate(models) {
      ProductVariantValue.belongsTo(models.ProductVariant, {
        foreignKey: 'product_variant_id',
        as: 'productVariant',
        onDelete: 'CASCADE'
      });

      ProductVariantValue.belongsTo(models.VariantValue, {
        foreignKey: 'variant_value_id',
        as: 'variantValue',
        onDelete: 'CASCADE'
      });

      ProductVariantValue.belongsTo(models.VariantDefinition, {
        foreignKey: 'variant_definition_id',
        as: 'definition',
        onDelete: 'CASCADE'
      });
    }
  }

  ProductVariantValue.init({
    id: {
      type: DataTypes.BIGINT,
      autoIncrement: true,
      primaryKey: true
    },
    product_variant_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    variant_value_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    },
    variant_definition_id: {
      type: DataTypes.BIGINT,
      allowNull: false
    }
  }, {
    sequelize,
    modelName: 'ProductVariantValue',
    tableName: 'product_variant_values',
    timestamps: true
  });

  return ProductVariantValue;
};
