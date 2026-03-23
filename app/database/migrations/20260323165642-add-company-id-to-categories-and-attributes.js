'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // ============================================
      // 1. Agregar company_id a product_categories
      // ============================================
      await queryInterface.addColumn('product_categories', 'company_id', {
        type: Sequelize.BIGINT,
        allowNull: true,
        defaultValue: null,
        comment: 'ID de la empresa propietaria (NULL = categoría global)',
        references: {
          model: 'companies',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      }, { transaction });

      // Crear índice para company_id en product_categories
      await queryInterface.addIndex('product_categories', {
        name: 'product_categories_company_id_idx',
        fields: ['company_id'],
        unique: false
      }, { transaction });

      // ============================================
      // 2. Agregar company_id a attributes
      // ============================================
      await queryInterface.addColumn('attributes', 'company_id', {
        type: Sequelize.BIGINT,
        allowNull: true,
        defaultValue: null,
        comment: 'ID de la empresa propietaria (NULL = atributo global)',
        references: {
          model: 'companies',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      }, { transaction });

      // Crear índice para company_id en attributes
      await queryInterface.addIndex('attributes', {
        name: 'attributes_company_id_idx',
        fields: ['company_id'],
        unique: false
      }, { transaction });

      await transaction.commit();

      console.log('✅ Migración completada: company_id agregado a product_categories y attributes');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en migración:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // ============================================
      // Revertir: Eliminar company_id de attributes
      // ============================================
      await queryInterface.removeIndex('attributes', 'attributes_company_id_idx', { transaction });
      await queryInterface.removeColumn('attributes', 'company_id', { transaction });

      // ============================================
      // Revertir: Eliminar company_id de product_categories
      // ============================================
      await queryInterface.removeIndex('product_categories', 'product_categories_company_id_idx', { transaction });
      await queryInterface.removeColumn('product_categories', 'company_id', { transaction });

      await transaction.commit();

      console.log('✅ Migración revertida: company_id eliminado de product_categories y attributes');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error al revertir migración:', error);
      throw error;
    }
  }
};
