'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('products', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      sku: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      description: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      // 👇 NUEVOS CAMPOS MULTI-PLATAFORMA
      brand: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'Generico',
        comment: 'Marca del producto (requerido para marketplaces)'
      },
      model: {
        type: Sequelize.STRING,
        allowNull: true,
        comment: 'Modelo o variante del producto'
      },
      condition: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'new',
        comment: 'Estado del producto'
      },
      gtin: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'Código de barras (EAN/UPC/GTIN)'
      },
      mpn: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Número de parte del fabricante'
      },
      attributes: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: JSON.stringify([]),
        comment: 'Atributos genéricos para todos los marketplaces'
      },
      warranty_months: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: 'Meses de garantía'
      },
      warranty_text: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Texto de garantía (ej: "6 meses de garantía")'
      },
      weight_grams: {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: 'Peso en gramos'
      },
      length_cm: {
        type: Sequelize.DECIMAL(8, 2),
        allowNull: true,
        comment: 'Largo en cm'
      },
      width_cm: {
        type: Sequelize.DECIMAL(8, 2),
        allowNull: true,
        comment: 'Ancho en cm'
      },
      height_cm: {
        type: Sequelize.DECIMAL(8, 2),
        allowNull: true,
        comment: 'Alto en cm'
      },
      // 👇 CAMPOS EXISTENTES
      status: {
        type: Sequelize.TINYINT,
        allowNull: false,
        defaultValue: 0,
        comment: 'Estado interno del producto'
      },
      category_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'product_categories',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      base_price: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'branches',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      images: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: JSON.stringify([]),
        comment: 'Array de rutas de imágenes del producto'
      },
      sync_meta: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: JSON.stringify({}),
        comment: 'Metadata de sincronización con marketplaces'
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    }, {
      // 👇 ÍNDICES DEFINIDOS DENTRO DE createTable
      indexes: [
        {
          unique: true,
          fields: ['sku']
        },
        {
          fields: ['company_id', 'status']
        },
        {
          fields: ['brand']
        },
        {
          fields: ['gtin']
        }
      ]
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('products');
  }
};