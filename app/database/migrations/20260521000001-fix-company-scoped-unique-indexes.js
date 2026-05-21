'use strict';

async function removeIndexIfExists(queryInterface, tableName, indexName, transaction) {
  const indexes = await queryInterface.showIndex(tableName, { transaction });
  const exists = indexes.some(index => index.name === indexName);

  if (exists) {
    await queryInterface.removeIndex(tableName, indexName, { transaction });
  }
}

async function removeUniqueSingleFieldIndex(queryInterface, tableName, fieldName, preserveNames = [], transaction) {
  const indexes = await queryInterface.showIndex(tableName, { transaction });

  for (const index of indexes) {
    const sameFields = Array.isArray(index.fields) && index.fields.length === 1 && index.fields[0].attribute === fieldName;
    const shouldRemove = index.unique === true && sameFields && !preserveNames.includes(index.name);

    if (shouldRemove) {
      await queryInterface.removeIndex(tableName, index.name, { transaction });
    }
  }
}

async function assertNoDuplicates(queryInterface, tableName, fields, transaction) {
  const selectFields = fields
    .map(field => `\`${field}\``)
    .join(', ');

  const whereFields = fields
    .map(field => `\`${field}\` IS NOT NULL`)
    .join(' AND ');

  const groupFields = fields
    .map(field => `\`${field}\``)
    .join(', ');

  const query = `
    SELECT ${selectFields}, COUNT(*) AS duplicate_count
    FROM \`${tableName}\`
    WHERE ${whereFields}
    GROUP BY ${groupFields}
    HAVING COUNT(*) > 1
    LIMIT 10
  `;

  const rows = await queryInterface.sequelize.query(query, {
    type: queryInterface.sequelize.QueryTypes.SELECT,
    transaction
  });

  if (rows.length > 0) {
    throw new Error(`Existen duplicados en ${tableName} para índice único ${fields.join(', ')}: ${JSON.stringify(rows)}`);
  }
}

module.exports = {
  async up(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      // product_categories: quitar unique(name) viejo
      await removeUniqueSingleFieldIndex(
        queryInterface,
        'product_categories',
        'name',
        ['product_categories_company_name_unique'],
        transaction
      );

      // attributes: quitar unique(name) viejo
      await removeUniqueSingleFieldIndex(
        queryInterface,
        'attributes',
        'name',
        ['attributes_company_name_unique'],
        transaction
      );

      // variant_values: quitar índice no unique viejo sobre (variant_definition_id, name)
      await removeIndexIfExists(
        queryInterface,
        'variant_values',
        'variant_values_definition_name_idx',
        transaction
      );

      // Validar duplicados antes de crear índices únicos compuestos
      await assertNoDuplicates(queryInterface, 'product_categories', ['company_id', 'name'], transaction);
      await assertNoDuplicates(queryInterface, 'attributes', ['company_id', 'name'], transaction);
      await assertNoDuplicates(queryInterface, 'variant_definitions', ['company_id', 'name'], transaction);
      await assertNoDuplicates(queryInterface, 'variant_values', ['variant_definition_id', 'name'], transaction);

      await queryInterface.addIndex('product_categories', {
        name: 'product_categories_company_name_unique',
        unique: true,
        fields: ['company_id', 'name']
      }, { transaction });

      await queryInterface.addIndex('attributes', {
        name: 'attributes_company_name_unique',
        unique: true,
        fields: ['company_id', 'name']
      }, { transaction });

      await queryInterface.addIndex('variant_definitions', {
        name: 'variant_definitions_company_name_unique',
        unique: true,
        fields: ['company_id', 'name']
      }, { transaction });

      await queryInterface.addIndex('variant_values', {
        name: 'variant_values_definition_name_unique',
        unique: true,
        fields: ['variant_definition_id', 'name']
      }, { transaction });

      await transaction.commit();
      console.log('✅ Migración completada: índices únicos corregidos por company_id + name');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error en migración fix-company-scoped-unique-indexes:', error);
      throw error;
    }
  },

  async down(queryInterface) {
    const transaction = await queryInterface.sequelize.transaction();

    try {
      await removeIndexIfExists(queryInterface, 'variant_values', 'variant_values_definition_name_unique', transaction);
      await removeIndexIfExists(queryInterface, 'variant_definitions', 'variant_definitions_company_name_unique', transaction);
      await removeIndexIfExists(queryInterface, 'attributes', 'attributes_company_name_unique', transaction);
      await removeIndexIfExists(queryInterface, 'product_categories', 'product_categories_company_name_unique', transaction);

      await queryInterface.addIndex('product_categories', {
        name: 'name',
        unique: true,
        fields: ['name']
      }, { transaction });

      await queryInterface.addIndex('attributes', {
        name: 'name',
        unique: true,
        fields: ['name']
      }, { transaction });

      await queryInterface.addIndex('variant_values', {
        name: 'variant_values_definition_name_idx',
        fields: ['variant_definition_id', 'name']
      }, { transaction });

      await transaction.commit();
      console.log('✅ Migración revertida: índices únicos globales restaurados');
    } catch (error) {
      await transaction.rollback();
      console.error('❌ Error al revertir migración fix-company-scoped-unique-indexes:', error);
      throw error;
    }
  }
};
