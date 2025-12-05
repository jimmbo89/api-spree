'use strict';
const { Model, Op } = require('sequelize');
module.exports = (sequelize, DataTypes) => {
  class Product extends Model {
    static associate(models) {
      Product.belongsTo(models.ProductCategory, { foreignKey: 'category_id', as: 'category', onDelete: 'SET NULL' });
      Product.belongsTo(models.User, { foreignKey: 'user_id', as: 'user', onDelete: 'SET NULL' });
      Product.belongsTo(models.Company, { foreignKey: 'company_id', as: 'company', onDelete: 'SET NULL' });
      Product.belongsTo(models.Branch, { foreignKey: 'branch_id', as: 'branch', onDelete: 'SET NULL' });
      Product.hasMany(models.ProductPublishingTask, { foreignKey: 'product_id', as: 'publishingTasks', onDelete: 'CASCADE' });
      Product.hasMany(models.ProductMarketplaceLink, { foreignKey: 'product_id', as: 'marketplaceLinks', onDelete: 'CASCADE' });
      Product.hasMany(models.WarehouseProduct, { foreignKey: 'product_id', as: 'warehouseProducts', onDelete: 'CASCADE' });
    }

    getMarketplaceData(marketplaceType) {
      const baseData = {
        sku: this.sku,
        name: this.name,
        description: this.description,
        brand: this.brand,
        model: this.model,
        condition: this.condition,
        gtin: this.gtin,
        mpn: this.mpn,
        base_price: this.base_price,
        attributes: this.attributes || [],
        warranty_months: this.warranty_months,
        warranty_text: this.warranty_text,
        weight_grams: this.weight_grams,
        dimensions: {
          length: this.length_cm,
          width: this.width_cm,
          height: this.height_cm
        },
        images: this.images || []
      };
      const syncData = this.sync_meta || {};
      if (syncData[marketplaceType]) {
        baseData.marketplace_specific = syncData[marketplaceType];
      }
      return baseData;
    }

    hasMinimumMarketplaceData() {
      const required = ['sku', 'name', 'brand', 'condition'];
      const missing = required.filter(field => !this[field] || this[field] === '');
      return {
        valid: missing.length === 0,
        missing,
        message: missing.length > 0 ? `Faltan campos: ${missing.join(', ')}` : 'OK'
      };
    }
  }

  Product.init({
    id: {
      type: DataTypes.BIGINT,
      primaryKey: true,
      autoIncrement: true
    },
    sku: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
      validate: {
        notEmpty: { msg: 'SKU es obligatorio' },
        len: { args: [1, 100], msg: 'SKU debe tener entre 1 y 100 caracteres' }
      }
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
      validate: {
        notEmpty: { msg: 'Nombre es obligatorio' },
        len: { args: [1, 255], msg: 'Nombre debe tener entre 1 y 255 caracteres' }
      }
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true
    },
    brand: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'Generico',
      validate: {
        notEmpty: { msg: 'Marca es obligatoria' }
      }
    },
    model: {
      type: DataTypes.STRING,
      allowNull: true
    },
    condition: {
      type: DataTypes.ENUM('new', 'used', 'refurbished', 'not_specified'),
      allowNull: false,
      defaultValue: 'new'
    },
    gtin: {
      type: DataTypes.STRING(50),
      allowNull: true,
      validate: {
        len: { args: [0, 50], msg: 'GTIN máximo 50 caracteres' }
      }
    },
    mpn: {
      type: DataTypes.STRING(100),
      allowNull: true
    },
    attributes: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: []
    },
    warranty_months: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: { args: [0], msg: 'Garantía no puede ser negativa' }
      }
    },
    warranty_text: {
      type: DataTypes.STRING(255),
      allowNull: true
    },
    weight_grams: {
      type: DataTypes.INTEGER,
      allowNull: true,
      validate: {
        min: { args: [0], msg: 'Peso no puede ser negativo' }
      }
    },
    length_cm: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: true,
      validate: {
        min: { args: [0], msg: 'Largo no puede ser negativo' }
      }
    },
    width_cm: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: true,
      validate: {
        min: { args: [0], msg: 'Ancho no puede ser negativo' }
      }
    },
    height_cm: {
      type: DataTypes.DECIMAL(8, 2),
      allowNull: true,
      validate: {
        min: { args: [0], msg: 'Alto no puede ser negativo' }
      }
    },
    status: {
      type: DataTypes.TINYINT,
      allowNull: false,
      defaultValue: 0,
      validate: {
        isIn: { args: [[0, 1, 2, 3]], msg: 'Estado inválido' }
      }
    },
    category_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    base_price: {
      type: DataTypes.DECIMAL(16, 2),
      allowNull: true,
      validate: {
        min: { args: [0], msg: 'Precio no puede ser negativo' }
      }
    },
    user_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    company_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    branch_id: {
      type: DataTypes.BIGINT,
      allowNull: true
    },
    images: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: []
    },
    sync_meta: {
      type: DataTypes.JSON,
      allowNull: true,
      defaultValue: {}
    }
  }, {
    sequelize,
    modelName: 'Product',
    tableName: 'products',
    timestamps: true,
    hooks: {
      beforeCreate: (product) => {
        if (!product.brand || product.brand.trim() === '') {
          product.brand = 'Generico';
        }
        if (!product.condition) {
          product.condition = 'new';
        }
        if (product.images && !Array.isArray(product.images)) {
          product.images = [];
        }
      },
      beforeUpdate: (product) => {
        if (product.images && !Array.isArray(product.images)) {
          product.images = [];
        }
      }
    },
    scopes: {
      active: {
        where: { status: 0 }
      },
      published: {
        where: { status: 1 }
      },
      byCompany: function(companyId) {
        return { where: { company_id: companyId } };
      },
      withBrand: function(brand) {
        return { where: { brand: { [Op.iLike]: `%${brand}%` } } };
      },
      hasGtin: {
        where: { gtin: { [Op.not]: null } }
      }
    }
  });
  return Product;
};