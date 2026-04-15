'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('variant_definitions', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      company_id: {
        type: Sequelize.BIGINT,
        allowNull: true,
        comment: 'ID de la empresa propietaria (NULL = global)'
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      type: {
        type: Sequelize.STRING,
        allowNull: true
      },
      cant: {
        type: Sequelize.INTEGER,
        allowNull: true
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

    await queryInterface.addIndex('variant_definitions', ['company_id'], {
      name: 'variant_definitions_company_id_idx'
    });

    await queryInterface.createTable('variant_values', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      variant_definition_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'variant_definitions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      name: {
        type: Sequelize.STRING,
        allowNull: false
      },
      code: {
        type: Sequelize.STRING,
        allowNull: true
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

    await queryInterface.addIndex('variant_values', ['variant_definition_id'], {
      name: 'variant_values_definition_id_idx'
    });

    await queryInterface.addIndex('variant_values', ['variant_definition_id', 'name'], {
      name: 'variant_values_definition_name_idx'
    });

    await queryInterface.createTable('product_variant_values', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.BIGINT
      },
      product_variant_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'product_variants', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      variant_value_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'variant_values', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
      },
      variant_definition_id: {
        type: Sequelize.BIGINT,
        allowNull: false,
        references: { model: 'variant_definitions', key: 'id' },
        onUpdate: 'CASCADE',
        onDelete: 'CASCADE'
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

    await queryInterface.addIndex('product_variant_values', ['product_variant_id'], {
      name: 'product_variant_values_variant_idx'
    });

    await queryInterface.addIndex('product_variant_values', ['variant_value_id'], {
      name: 'product_variant_values_value_idx'
    });

    await queryInterface.addIndex('product_variant_values', ['variant_definition_id'], {
      name: 'product_variant_values_definition_idx'
    });

    await queryInterface.addIndex('product_variant_values', ['product_variant_id', 'variant_definition_id'], {
      unique: true,
      name: 'product_variant_values_unique_definition'
    });

    await queryInterface.addIndex('product_variant_values', ['product_variant_id', 'variant_value_id'], {
      unique: true,
      name: 'product_variant_values_unique_value'
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('product_variant_values');
    await queryInterface.dropTable('variant_values');
    await queryInterface.dropTable('variant_definitions');
  }
};
