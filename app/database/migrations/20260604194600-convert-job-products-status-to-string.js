'use strict';

module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE job_products
      MODIFY COLUMN status VARCHAR(32) NOT NULL DEFAULT 'pending';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query(`
      ALTER TABLE job_products
      MODIFY COLUMN status ENUM('pending', 'processing', 'success', 'error', 'retrying', 'deleted')
      NOT NULL DEFAULT 'pending';
    `);
  }
};
