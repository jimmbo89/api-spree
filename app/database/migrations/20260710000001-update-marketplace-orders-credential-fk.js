'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      UPDATE marketplace_orders mo
      INNER JOIN marketplace_credentials mc ON mc.id = mo.marketplace_credential_id
      SET mo.user_id = mc.user_id
      WHERE mo.user_id IS NULL
        AND mo.marketplace_credential_id IS NOT NULL
        AND mc.user_id IS NOT NULL
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE marketplace_orders
      DROP FOREIGN KEY marketplace_orders_ibfk_1
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE marketplace_orders
      ADD CONSTRAINT marketplace_orders_ibfk_1
      FOREIGN KEY (marketplace_credential_id)
      REFERENCES marketplace_credentials(id)
      ON DELETE SET NULL
      ON UPDATE CASCADE
    `);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.sequelize.query(`
      ALTER TABLE marketplace_orders
      DROP FOREIGN KEY marketplace_orders_ibfk_1
    `);

    await queryInterface.sequelize.query(`
      ALTER TABLE marketplace_orders
      ADD CONSTRAINT marketplace_orders_ibfk_1
      FOREIGN KEY (marketplace_credential_id)
      REFERENCES marketplace_credentials(id)
      ON DELETE RESTRICT
      ON UPDATE CASCADE
    `);
  }
};
