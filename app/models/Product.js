'use strict';
const { Model, Op } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Product extends Model {
    static associate(models) {
      Product.belongsTo(models.ProductCategory, { foreignKey: 'category_id', as: 'category', onDelete: 'SET NULL' });
      Product.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Product.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'SET NULL' });
      Product.hasMany(models.ProductPublishingTask, { foreignKey: 'product_id', as: 'publishingTasks', onDelete: 'CASCADE' });
      Product.hasMany(models.ProductMarketplaceLink, { foreignKey: 'product_id', as: 'marketplaceLinks', onDelete: 'CASCADE' });
      Product.hasMany(models.ProductVariant, { foreignKey: 'product_id', as: 'variants', onDelete: 'CASCADE' });
      Product.hasMany(models.WarehouseProduct, { foreignKey: 'product_id', as: 'warehouseProducts', onDelete: 'CASCADE' });
      Product.hasMany(models.ProductAttribute, { foreignKey: 'product_id', as: 'productAttributes', onDelete: 'CASCADE' });
      Product.hasMany(models.JobProduct, {
      foreignKey: 'product_id',
      as: 'jobProducts',
      onDelete: 'SET NULL'
    });
    }

        // Método para verificar si SKU existe dentro de una empresa
    static async skuExists(sku, companyId = null, excludeId = null) {
      const where = { sku };
      
      // ✅ Si hay company_id, filtrar por empresa (SKU único por empresa)
      if (companyId) {
        where.company_id = companyId;
      }
      
      if (excludeId) {
        where.id = { [Op.ne]: excludeId };
      }
      const count = await this.count({ where });
      return count > 0;
    }
  }

  Product.init({
    sku: { type: DataTypes.STRING, allowNull: false },  // ✅ unique: true eliminado (ahora es por company_id)
    name: { type: DataTypes.STRING, allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: true },
    brand: { type: DataTypes.STRING, allowNull: false, defaultValue: 'Generico' },
    model: { type: DataTypes.STRING, allowNull: true },
    condition: {
      type: DataTypes.STRING,//.ENUM('new', 'used', 'refurbished', 'not_specified'),
      allowNull: false,
      defaultValue: 'new'
    },
    gtin: { type: DataTypes.STRING(50), allowNull: true },
    mpn: { type: DataTypes.STRING(100), allowNull: true },
    attributes: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    warranty_months: { type: DataTypes.INTEGER, allowNull: true },
    warranty_text: { type: DataTypes.STRING(255), allowNull: true },
    weight_grams: { type: DataTypes.INTEGER, allowNull: true },
    length_cm: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
    width_cm: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
    height_cm: { type: DataTypes.DECIMAL(8, 2), allowNull: true },
    category_id: { type: DataTypes.BIGINT, allowNull: true },
    user_id: { type: DataTypes.BIGINT, allowNull: true },
    company_id: { type: DataTypes.BIGINT, allowNull: true },
    images: { type: DataTypes.JSON, allowNull: true, defaultValue: [] },
    sync_meta: { type: DataTypes.JSON, allowNull: true, defaultValue: {} },
    state: { type: DataTypes.TINYINT, allowNull: true, defaultValue: 1 },
  }, {
    sequelize,
    modelName: 'Product',
    tableName: 'products',
    timestamps: true,
  });
  return Product;
};