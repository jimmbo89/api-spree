'use strict';
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
      brand: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'Generico'
      },
      model: {
        type: Sequelize.STRING,
        allowNull: true
      },
      condition: {
        type: Sequelize.STRING,  //ENUM('new', 'used', 'refurbished', 'not_specified'),
        allowNull: false,
        defaultValue: 'new'
      },
      gtin: {
        type: Sequelize.STRING(50),
        allowNull: true
      },
      mpn: {
        type: Sequelize.STRING(100),
        allowNull: true
      },
      attributes: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: []
      },
      warranty_months: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      warranty_text: {
        type: Sequelize.STRING,
        allowNull: true
      },
      weight_grams: {
        type: Sequelize.INTEGER,
        allowNull: true
      },
      length_cm: {
        type: Sequelize.DECIMAL(8, 2),
        allowNull: true
      },
      width_cm: {
        type: Sequelize.DECIMAL(8, 2),
        allowNull: true
      },
      height_cm: {
        type: Sequelize.DECIMAL(8, 2),
        allowNull: true
      },
      category_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'product_categories', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'users', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: { model: 'companies', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      images: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: []
      },
      sync_meta: {
        type: Sequelize.JSON,
        allowNull: true,
        defaultValue: []
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
      indexes: [
        { unique: true, fields: ['sku'] },
        { fields: ['company_id'] },
        { fields: ['brand'] },
        { fields: ['gtin'] },
        { fields: ['category_id'] }
      ]
    });
  },
  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('products');
  }
};