// migrations/xxxx-create-category-commissions.js
'use strict';

const { Op } = require('sequelize');

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('category_commissions', {
      // 🔑 Primary Key
      id: {
        type: Sequelize.BIGINT,
        primaryKey: true,
        autoIncrement: true
      },
      
      // 🔗 Relaciones con tablas existentes
      marketplace_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: {
          model: 'marketplaces',
          key: 'id'
        },
        onDelete: 'CASCADE',
        comment: 'FK a tabla marketplaces (falabella_cl, mercadolibre_cl, etc.)'
      },
      credential_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'marketplace_credentials',
          key: 'id'
        },
        onDelete: 'SET NULL',
        comment: 'FK opcional para comisiones personalizadas por seller'
      },
      
      // 🏷️ Identificadores de categoría desde la API del marketplace
      category_id: {
        type: Sequelize.STRING(50),
        allowNull: true,
        comment: 'ID de categoría desde API (ej: "79" en Falabella)'
      },
      global_identifier: {
        type: Sequelize.STRING(100),
        allowNull: true,
        comment: 'Código global (ej: "G19020604" en Falabella)'
      },
      category_name_api: {
        type: Sequelize.STRING(255),
        allowNull: true,
        comment: 'Nombre tal como lo devuelve la API (para fallback)'
      },
      
      // 📂 Jerarquía de categoría desde CSV oficial (4 niveles)
      category_level_1: {
        type: Sequelize.STRING(150),
        allowNull: false,
        comment: 'Nivel 1: Categoría principal'
      },
      category_level_2: {
        type: Sequelize.STRING(150),
        allowNull: true,
        comment: 'Nivel 2: Subcategoría 1'
      },
      category_level_3: {
        type: Sequelize.STRING(150),
        allowNull: true,
        comment: 'Nivel 3: Subcategoría 2'
      },
      category_level_4: {
        type: Sequelize.STRING(255),
        allowNull: false,
        comment: 'Nivel 4: Hoja donde aplica la comisión'
      },
      
      // 💰 Datos de comisión
      commission_percentage: {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        comment: 'Porcentaje de comisión (ej: 14.50 para 14.5%)'
      },
      min_fee_amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
        comment: 'Comisión mínima fija (si aplica)'
      },
      max_fee_amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        comment: 'Tope máximo de comisión (si aplica)'
      },
      fixed_fee_amount: {
        type: Sequelize.DECIMAL(12, 2),
        allowNull: true,
        defaultValue: 0,
        comment: 'Fee fijo adicional por publicación'
      },
      currency: {
        type: Sequelize.STRING(3),
        allowNull: false,
        defaultValue: 'CLP',
        comment: 'Moneda: CLP, COP, PEN, MXN, USD'
      },
      
      // 📊 Metadatos y control
      is_active: {
        type: Sequelize.TINYINT,
        allowNull: false,
        defaultValue: 1,
        comment: 'Estado: 1=activa, 0=inactiva (soft delete)'
      },
      source: {
        type: Sequelize.ENUM('csv_import', 'api_sync', 'manual', 'marketplace_api'),
        allowNull: false,
        defaultValue: 'csv_import',
        comment: 'Origen del dato de comisión'
      },
      last_synced_at: {
        type: Sequelize.DATE,
        allowNull: true,
        comment: 'Última sincronización desde fuente externa'
      },
      notes: {
        type: Sequelize.TEXT,
        allowNull: true,
        comment: 'Notas adicionales'
      },
      
      // ⏰ Timestamps
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false
      }
    }, {
      comment: 'Comisiones por categoría para marketplaces (genérico)'
    });

    // 🔍 Índices optimizados para búsquedas rápidas
    
    // Índice único: marketplace + category_id (búsqueda principal O(1))
    await queryInterface.addIndex('category_commissions', 
      ['marketplace_id', 'category_id', 'credential_id'],
      { 
        unique: true, 
        name: 'idx_marketplace_category_unique',
        where: { 
          category_id: { [Op.ne]: null },
          credential_id: { [Op.eq]: null } 
        }
      }
    );
    
    // Índice: global_identifier (fallback por código global)
    await queryInterface.addIndex('category_commissions',
      ['marketplace_id', 'global_identifier', 'credential_id'],
      { 
        name: 'idx_global_identifier',
        where: { global_identifier: { [Op.ne]: null } }
      }
    );
    
    // Índice: category_name_api (fallback por nombre de API)
    await queryInterface.addIndex('category_commissions',
      ['marketplace_id', 'category_name_api'],
      { 
        name: 'idx_category_name_api',
        where: { category_name_api: { [Op.ne]: null } }
      }
    );
    
    // Índice único: ruta completa de categoría desde CSV
    await queryInterface.addIndex('category_commissions',
      ['marketplace_id', 'category_level_1', 'category_level_2', 'category_level_3', 'category_level_4', 'credential_id'],
      { 
        unique: true, 
        name: 'idx_category_path_unique',
        where: { credential_id: { [Op.eq]: null } }
      }
    );
    
    // Índice: filtro rápido por marketplace + estado activo
    await queryInterface.addIndex('category_commissions',
      ['marketplace_id', 'is_active'],
      { name: 'idx_marketplace_active' }
    );
  },

  down: async (queryInterface) => {
    await queryInterface.dropTable('category_commissions');
  }
};