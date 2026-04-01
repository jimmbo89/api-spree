// migration/20260330000001-add-task-id-to-job-products.js
'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.addColumn('job_products', 'task_id', {
      type: Sequelize.BIGINT,
      allowNull: true,
      comment: 'Referencia al product_publishing_task creado para este producto',
      index: true
    });

    // Agregar índice para consultas por task_id
    await queryInterface.addIndex('job_products', ['task_id'], {
      name: 'idx_job_products_task_id'
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.removeIndex('job_products', 'idx_job_products_task_id', {
      transaction: queryInterface.sequelize.transaction()
    });

    await queryInterface.removeColumn('job_products', 'task_id', {
      transaction: queryInterface.sequelize.transaction()
    });
  }
};
