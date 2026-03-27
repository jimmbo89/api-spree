'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Verificar si la columna ya existe
      const tableDescription = await queryInterface.describeTable('product_marketplace_links', { transaction });
      
      if (!tableDescription.credential_id) {
        // Solo agregar si no existe
        await queryInterface.addColumn('product_marketplace_links', 'credential_id', {
          type: Sequelize.BIGINT,
          allowNull: true,
          comment: 'ID de la credencial específica usada para esta publicación'
        }, { transaction });

        // 2. Agregar foreign key constraint (si no existe)
        try {
          await queryInterface.addConstraint('product_marketplace_links', {
            fields: ['credential_id'],
            type: 'foreign key',
            name: 'pml_credential_fk',
            references: {
              table: 'marketplace_credentials',
              field: 'id'
            },
            onUpdate: 'CASCADE',
            onDelete: 'SET NULL'
          }, { transaction });
        } catch (fkError) {
          console.warn('[Migration] FK constraint may already exist:', fkError.message);
        }

        // 3. Agregar índice para búsquedas por external_id + marketplace_id + credential_id
        const indexes = await queryInterface.showIndex('product_marketplace_links', { transaction });
        const indexExists = indexes.find(idx => idx.name === 'pml_external_marketplace_credential_idx');
        
        if (!indexExists) {
          await queryInterface.addIndex('product_marketplace_links', 
            ['external_id', 'marketplace_id', 'credential_id'], 
            {
              name: 'pml_external_marketplace_credential_idx',
              transaction
            }
          );
        }

        // 4. Actualizar registros existentes con credential_id desde product_publishing_tasks
        //    (para los que ya tienen external_id y se puede hacer join con la última tarea)
        //    NOTA: Usamos 'createdAt' (con T mayúscula) porque Sequelize usa ese nombre
        await queryInterface.sequelize.query(`
          UPDATE product_marketplace_links pml
          SET credential_id = (
            SELECT ppt.credential_id 
            FROM product_publishing_tasks ppt 
            WHERE ppt.external_id = pml.external_id 
              AND ppt.marketplace_id = pml.marketplace_id
              AND ppt.credential_id IS NOT NULL
            ORDER BY ppt.createdAt DESC 
            LIMIT 1
          )
          WHERE pml.external_id IS NOT NULL
            AND pml.credential_id IS NULL
        `, { transaction });
      }

      await transaction.commit();

      console.log('[Migration] credential_id agregado exitosamente a product_marketplace_links');
    } catch (error) {
      await transaction.rollback();
      console.error('[Migration] Error al agregar credential_id:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // 1. Verificar si la columna existe
      const tableDescription = await queryInterface.describeTable('product_marketplace_links', { transaction });
      
      if (tableDescription.credential_id) {
        // 1. Eliminar índice (si existe)
        const indexes = await queryInterface.showIndex('product_marketplace_links', { transaction });
        const indexExists = indexes.find(idx => idx.name === 'pml_external_marketplace_credential_idx');
        
        if (indexExists) {
          await queryInterface.removeIndex('product_marketplace_links', 'pml_external_marketplace_credential_idx', { transaction });
        }

        // 2. Eliminar foreign key constraint (si existe)
        try {
          await queryInterface.removeConstraint('product_marketplace_links', 'pml_credential_fk', { transaction });
        } catch (fkError) {
          console.warn('[Migration] FK constraint does not exist:', fkError.message);
        }

        // 3. Eliminar columna
        await queryInterface.removeColumn('product_marketplace_links', 'credential_id', { transaction });
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      console.error('[Migration] Error al revertir credential_id:', error);
      throw error;
    }
  }
};
