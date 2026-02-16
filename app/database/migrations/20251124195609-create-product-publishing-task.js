'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('product_publishing_tasks', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      product_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'products',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      marketplace_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'marketplaces',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'warehouses',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'branches',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      user_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL'
      },
      // ? CAMPO CRÍTICO: Agrupa publicaciones de una misma acción del usuario
      batch_id: {
        type: Sequelize.UUID,
        allowNull: true,
        defaultValue: Sequelize.UUIDV4
      },
      // ? CAMPO CRÍTICO: Distingue entre draft, pending, published, etc.
      status: {
        type: Sequelize.STRING(100), //ENUM('draft', 'pending', 'processing', 'published', 'failed', 'cancelled'),
        allowNull: false,
        defaultValue: 'pending'
      },
      // ? CAMPO CRÍTICO: Nombre descriptivo del borrador
      draft_name: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      // ? CAMPO CRÍTICO: Modo de publicación (quick, guided, draft)
      publishing_mode: {
        type: Sequelize.STRING(50),
        allowNull: true,
        defaultValue: 'quick'
      },
      date: {
        type: Sequelize.DATEONLY,
        allowNull: false,
        defaultValue: Sequelize.NOW // se guarda como YYYY-MM-DD
      },
      // ? CAMPO CRÍTICO: Almacena errores estructurados (cause[], warnings, etc.)
      error_details: {
        type: Sequelize.JSON,
        allowNull: true
      },
      // ? CAMPO CRÍTICO: Almacena respuesta completa de la API (éxito o error)
      api_response: {
        type: Sequelize.JSON,
        allowNull: true
      },
      error_message: {
        type: Sequelize.TEXT,
        allowNull: true
      },
      payload: {
        type: Sequelize.JSON,
        allowNull: false
      },
      external_id: {
        type: Sequelize.STRING(255),
        allowNull: true
      },
      external_url: {
        type: Sequelize.STRING(500),
        allowNull: true
      },
      // ? CAMPO CRÍTICO: Timestamp de publicación exitosa
      published_at: {
        type: Sequelize.DATE,
        allowNull: true
      },
      // ? CAMPO CRÍTICO: Número de intentos de publicación
      attempt_count: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 1
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    // ? ÍNDICES OPTIMIZADOS PARA CONSULTAS FRECUENTES
    await queryInterface.addIndex('product_publishing_tasks', ['date'], {
      name: 'ppt_date_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['marketplace_id'], {
      name: 'ppt_marketplace_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['product_id'], {
      name: 'ppt_product_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['user_id'], {
      name: 'ppt_user_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['batch_id'], {
      name: 'ppt_batch_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['status'], {
      name: 'ppt_status_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['company_id'], {
      name: 'ppt_company_idx'
    });
    await queryInterface.addIndex('product_publishing_tasks', ['status', 'date'], {
      name: 'ppt_status_date_idx'
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('product_publishing_tasks');
  }
};