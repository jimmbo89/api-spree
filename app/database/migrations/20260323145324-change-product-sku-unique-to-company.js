'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Eliminar el índice único global de sku
      // El índice se llama 'sku' (no 'products_sku_uindex')
      await queryInterface.removeIndex('products', 'sku', { transaction });

      // 2. Crear nuevo índice único compuesto (company_id + sku)
      // Esto permite que el mismo SKU exista en diferentes empresas
      // pero no duplicado dentro de la misma empresa
      await queryInterface.addIndex('products', {
        name: 'products_company_id_sku_unique',
        unique: true,
        fields: ['company_id', 'sku']
      }, { transaction });

      // 3. Crear índice normal para búsquedas por sku (sin unicidad)
      await queryInterface.addIndex('products', {
        name: 'products_sku_index',
        fields: ['sku']
      }, { transaction });

      await transaction.commit();

      console.log('✅ Migración completada: SKU único por empresa');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en migración:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Eliminar índices nuevos
      await queryInterface.removeIndex('products', 'products_company_id_sku_unique', { transaction });
      await queryInterface.removeIndex('products', 'products_sku_index', { transaction });

      // 2. Restaurar índice único global original
      await queryInterface.addIndex('products', {
        name: 'sku',
        unique: true,
        fields: ['sku']
      }, { transaction });

      await transaction.commit();

      console.log('✅ Migración revertida: SKU único global restaurado');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error al revertir migración:', error);
      throw error;
    }
  }
};
