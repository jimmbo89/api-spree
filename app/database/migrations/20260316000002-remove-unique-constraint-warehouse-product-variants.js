'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // NOTA IMPORTANTE: Esta migración remueve el constraint UNIQUE para permitir
    // múltiples lotes del mismo producto/variante en un almacén con diferente precio de compra.
    // 
    // ADVERTENCIA: Esto cambia el comportamiento del sistema. Asegúrate de que:
    // 1. El frontend esté actualizado para manejar múltiples lotes
    // 2. Las consultas de stock ahora deben sumar todos los lotes
    // 3. Las ventas deben usar lógica FIFO o selección manual de lotes
    //
    // Si prefieres mantener compatibilidad, NO apliques esta migración todavía.
    
    try {
      // Remover el índice UNIQUE que previene múltiples registros por variante-almacén
      await queryInterface.removeIndex('warehouse_product_variants', 'warehouse_product_variants_unique');
      
      // Crear nuevo índice no-único para mantener rendimiento en búsquedas
      await queryInterface.addIndex('warehouse_product_variants', ['warehouse_product_id', 'variant_id'], {
        name: 'warehouse_product_variants_wp_variant_idx'
      });
      
      // Agregar índice compuesto útil para consultas FIFO (por fecha de creación)
      await queryInterface.addIndex('warehouse_product_variants', ['warehouse_product_id', 'variant_id', 'createdAt'], {
        name: 'warehouse_product_variants_fifo_idx'
      });
    } catch (error) {
      // Si el índice unique no existe, continuar sin error
      console.log('El índice unique puede no existir, continuando...');
    }
  },

  async down(queryInterface, Sequelize) {
    try {
      // Restaurar el índice unique
      await queryInterface.removeIndex('warehouse_product_variants', 'warehouse_product_variants_wp_variant_idx');
      await queryInterface.removeIndex('warehouse_product_variants', 'warehouse_product_variants_fifo_idx');
      
      await queryInterface.addIndex('warehouse_product_variants', ['warehouse_product_id', 'variant_id'], {
        unique: true,
        name: 'warehouse_product_variants_unique'
      });
    } catch (error) {
      console.log('Error al revertir:', error.message);
    }
  }
};
