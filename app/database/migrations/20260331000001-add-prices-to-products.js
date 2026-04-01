'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar columna purchase_price para almacenar el precio de compra por defecto del producto
    await queryInterface.addColumn('products', 'purchase_price', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: true,
      defaultValue: null,
      comment: 'Precio de compra por defecto del producto (se usa como fallback si la variante no tiene precio)'
    });

    // Agregar columna sale_price para almacenar el precio de venta por defecto del producto
    await queryInterface.addColumn('products', 'sale_price', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: true,
      defaultValue: null,
      comment: 'Precio de venta por defecto del producto (se usa como fallback si la variante no tiene precio)'
    });

    // Agregar índices para consultas por precio
    await queryInterface.addIndex('products', ['purchase_price'], {
      name: 'products_purchase_price_idx'
    });

    await queryInterface.addIndex('products', ['sale_price'], {
      name: 'products_sale_price_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('products', 'products_sale_price_idx');
    await queryInterface.removeIndex('products', 'products_purchase_price_idx');
    await queryInterface.removeColumn('products', 'sale_price');
    await queryInterface.removeColumn('products', 'purchase_price');
  }
};
