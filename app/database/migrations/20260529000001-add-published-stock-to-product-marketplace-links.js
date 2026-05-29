'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableDescription = await queryInterface.describeTable('product_marketplace_links');

    if (!tableDescription.published_stock) {
      await queryInterface.addColumn('product_marketplace_links', 'published_stock', {
        type: Sequelize.INTEGER,
        allowNull: true,
        comment: 'Stock publicado en el marketplace para este vínculo'
      });
    }

    if (!tableDescription.published_payload) {
      await queryInterface.addColumn('product_marketplace_links', 'published_payload', {
        type: Sequelize.JSON,
        allowNull: true,
        comment: 'Payload publicado más reciente del marketplace'
      });
    }
  },

  async down(queryInterface) {
    const tableDescription = await queryInterface.describeTable('product_marketplace_links');

    if (tableDescription.published_payload) {
      await queryInterface.removeColumn('product_marketplace_links', 'published_payload');
    }

    if (tableDescription.published_stock) {
      await queryInterface.removeColumn('product_marketplace_links', 'published_stock');
    }
  }
};
