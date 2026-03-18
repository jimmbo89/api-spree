'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // Agregar columna purchase_price para almacenar el precio de compra del lote
    await queryInterface.addColumn('warehouse_product_variants', 'purchase_price', {
      type: Sequelize.DECIMAL(16, 2),
      allowNull: false,
      defaultValue: 0,
      comment: 'Precio de compra unitario del lote/producto'
    });

    // Agregar índice para consultas por purchase_price
    await queryInterface.addIndex('warehouse_product_variants', ['purchase_price'], {
      name: 'warehouse_product_variants_purchase_price_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.removeIndex('warehouse_product_variants', 'warehouse_product_variants_purchase_price_idx');
    await queryInterface.removeColumn('warehouse_product_variants', 'purchase_price');
  }
};
