'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const now = new Date();

    const definitions = [
      { name: 'Color', type: 'select', cant: null, company_id: null, createdAt: now, updatedAt: now },
      { name: 'Talla', type: 'select', cant: null, company_id: null, createdAt: now, updatedAt: now },
      { name: 'Material', type: 'select', cant: null, company_id: null, createdAt: now, updatedAt: now }
    ];

    await queryInterface.bulkInsert('variant_definitions', definitions, {
      ignoreDuplicates: true
    });

    const [rows] = await queryInterface.sequelize.query(
      "SELECT id, name FROM variant_definitions WHERE company_id IS NULL AND name IN (:names)",
      { replacements: { names: definitions.map(d => d.name) } }
    );

    const idMap = new Map(rows.map(r => [r.name, r.id]));

    const values = [
      { variant_definition_id: idMap.get('Color'), name: 'Rojo', code: '#FF0000', createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Color'), name: 'Azul', code: '#0000FF', createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Color'), name: 'Verde', code: '#00FF00', createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Color'), name: 'Negro', code: '#000000', createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Color'), name: 'Blanco', code: '#FFFFFF', createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Talla'), name: 'XS', code: null, createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Talla'), name: 'S', code: null, createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Talla'), name: 'M', code: null, createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Talla'), name: 'L', code: null, createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Talla'), name: 'XL', code: null, createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Material'), name: 'Algodon', code: null, createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Material'), name: 'Poliester', code: null, createdAt: now, updatedAt: now },
      { variant_definition_id: idMap.get('Material'), name: 'Cuero', code: null, createdAt: now, updatedAt: now }
    ].filter(v => v.variant_definition_id);

    if (values.length > 0) {
      await queryInterface.bulkInsert('variant_values', values, {
        ignoreDuplicates: true
      });
    }
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.bulkDelete('variant_values', {
      name: ['Rojo', 'Azul', 'Verde', 'Negro', 'Blanco', 'XS', 'S', 'M', 'L', 'XL', 'Algodon', 'Poliester', 'Cuero']
    }, {});

    await queryInterface.bulkDelete('variant_definitions', {
      name: ['Color', 'Talla', 'Material'],
      company_id: null
    }, {});
  }
};
