'use strict';
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('warehouse_products', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      product_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: {
          model: 'products',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      warehouse_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: {
          model: 'warehouses',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      stock: {
        type: Sequelize.INTEGER,
        allowNull: false,
        defaultValue: 0,
        validate: {
          min: 0
        }
      },
      // 👇 RUTA DE IMAGEN PRINCIPAL (por almacén, si se desea diferenciar)
      image: {
        type: Sequelize.STRING,
        allowNull: true,
        defaultValue: 'warehouse_products/default.jpg'
      },
      // 👇 PRECIO DE VENTA (sobreescribe base_price del producto)
      price: {
        type: Sequelize.DECIMAL(16, 2),
        allowNull: true,
        comment: 'Precio de venta en este almacén (sobreescribe base_price)'
      },
      // 👇 ESTADO DE PUBLICACIÓN POR ALMACÉN
      published: {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false
      },
      // 👇 CAMPOS DE FILTRADO RÁPIDO (normalizados desde warehouse)
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'companies',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Redundancia desde warehouse para optimizar queries'
      },
      branch_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'branches',
          key: 'id'
        },
        onUpdate: 'CASCADE',
        onDelete: 'SET NULL',
        comment: 'Redundancia desde warehouse'
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
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE
      }
    });

    // Índice único: un producto solo puede estar una vez por almacén
    await queryInterface.addIndex('warehouse_products', ['product_id', 'warehouse_id'], {
      unique: true,
      name: 'warehouse_products_product_warehouse_unique'
    });

    // Índices para mejor rendimiento
    await queryInterface.addIndex('warehouse_products', ['company_id', 'published']);
    await queryInterface.addIndex('warehouse_products', ['warehouse_id', 'published']);
    await queryInterface.addIndex('warehouse_products', ['product_id', 'published']);
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable('warehouse_products');
  }
};