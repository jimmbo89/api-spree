// migrations/20260218000000-fix-marketplace-credentials-index.js
'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // ===== 1. Agregar columnas faltantes (solo si no existen) =====
      
      // Columna 'name'
      try {
        await queryInterface.addColumn('marketplace_credentials', 'name', {
          type: Sequelize.STRING(100),
          allowNull: false,
          defaultValue: 'Conexión Principal',
          comment: 'Nombre identificador de la conexión'
        }, { transaction });
      } catch (e) {
        console.log('✓ Columna name ya existe');
      }

      // Columna 'country'
      try {
        await queryInterface.addColumn('marketplace_credentials', 'country', {
          type: Sequelize.STRING,
          allowNull: true,
          comment: 'Código ISO del país (ej: CL, PE, CO)'
        }, { transaction });
      } catch (e) {
        console.log('✓ Columna country ya existe');
      }

      // ===== 2. Obtener y eliminar foreign keys temporalmente =====
      const [foreignKeys] = await queryInterface.sequelize.query(`
        SELECT CONSTRAINT_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = 'marketplace_credentials'
        AND REFERENCED_TABLE_NAME IS NOT NULL
        AND CONSTRAINT_NAME NOT LIKE 'PRIMARY'
      `, { transaction });

      const removedFks = [];
      for (const fk of foreignKeys) {
        try {
          await queryInterface.removeConstraint('marketplace_credentials', fk.CONSTRAINT_NAME, { transaction });
          removedFks.push(fk.CONSTRAINT_NAME);
          console.log(`✓ FK eliminada: ${fk.CONSTRAINT_NAME}`);
        } catch (e) {
          console.log(`⚠ No se eliminó FK ${fk.CONSTRAINT_NAME}: ${e.message}`);
        }
      }

      // ===== 3. Eliminar índice antiguo =====
      try {
        await queryInterface.removeIndex('marketplace_credentials', 'mc_marketplace_user_unique', { transaction });
        console.log('✓ Índice antiguo eliminado');
      } catch (e) {
        console.log(`⚠ No se eliminó índice antiguo: ${e.message}`);
      }

      // ===== 4. Crear nuevo índice único compuesto =====
      try {
        await queryInterface.addIndex('marketplace_credentials', ['marketplace_id', 'user_id', 'name'], {
          unique: true,
          name: 'mc_marketplace_user_name_unique',
          transaction
        });
        console.log('✓ Nuevo índice único creado: mc_marketplace_user_name_unique');
      } catch (e) {
        console.error(`❌ Error creando índice nuevo: ${e.message}`);
        throw e;
      }

      // ===== 5. Índice simple para búsquedas por nombre =====
      try {
        await queryInterface.addIndex('marketplace_credentials', ['name'], {
          name: 'mc_name_idx',
          transaction
        });
        console.log('✓ Índice simple para name creado');
      } catch (e) {
        console.log(`⚠ Índice name: ${e.message}`);
      }

      // ===== 6. Recrear foreign keys eliminadas =====
      // marketplace_id -> marketplaces
      try {
        await queryInterface.addConstraint('marketplace_credentials', {
          fields: ['marketplace_id'],
          type: 'foreign key',
          name: 'marketplace_credentials_marketplace_id_fkey',
          references: {
            table: 'marketplaces',
            field: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
          transaction
        });
        console.log('✓ FK marketplace_id recreada');
      } catch (e) {
        console.log(`⚠ FK marketplace_id: ${e.message}`);
      }

      // user_id -> users
      try {
        await queryInterface.addConstraint('marketplace_credentials', {
          fields: ['user_id'],
          type: 'foreign key',
          name: 'marketplace_credentials_user_id_fkey',
          references: {
            table: 'users',
            field: 'id'
          },
          onUpdate: 'CASCADE',
          onDelete: 'CASCADE',
          transaction
        });
        console.log('✓ FK user_id recreada');
      } catch (e) {
        console.log(`⚠ FK user_id: ${e.message}`);
      }

      await transaction.commit();
      console.log('✅ Migración completada exitosamente');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en migración:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    
    try {
      // Eliminar índices nuevos
      await queryInterface.removeIndex('marketplace_credentials', 'mc_marketplace_user_name_unique', { transaction });
      await queryInterface.removeIndex('marketplace_credentials', 'mc_name_idx', { transaction });
      
      // Restaurar índice antiguo (opcional)
      try {
        await queryInterface.addIndex('marketplace_credentials', ['marketplace_id'], {
          unique: true,
          name: 'mc_marketplace_user_unique',
          transaction
        });
      } catch (e) {
        console.log('⚠ No se restauró índice antiguo:', e.message);
      }

      await transaction.commit();
    } catch (error) {
      await transaction.rollback();
      throw error;
    }
  }
};