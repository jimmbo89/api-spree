// seeders/XXXX-create-admin-role-and-user.js
'use strict';

const bcrypt = require('bcrypt');
const logger = require('../../../config/logger');

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      // 1. Crear el rol 'admin'
      const [role] = await queryInterface.sequelize.query(
        `INSERT INTO roles (name, status, description, createdAt, updatedAt) 
         VALUES (:name, :status, :description, NOW(), NOW())
         ON DUPLICATE KEY UPDATE 
         status = VALUES(status), description = VALUES(description), updatedAt = NOW();`,
        {
          replacements: {
            name: 'Admin',
            status: true,
            description: 'Administrador general del sistema'
          },
          type: Sequelize.QueryTypes.INSERT,
          transaction
        }
      );

      // Obtener el ID del rol (en caso de que ya existiera)
      const roleId = await queryInterface.sequelize.query(
        `SELECT id FROM roles WHERE name = 'Admin'`,
        { type: Sequelize.QueryTypes.SELECT, transaction }
      );

      if (!roleId || roleId.length === 0) {
        throw new Error('No se pudo obtener el ID del rol "admin"');
      }

      const adminRoleId = roleId[0].id;

      // 2. Hashear la contraseña
      const hashedPassword = bcrypt.hashSync('admin', 10);

      // 3. Insertar el usuario administrador
      await queryInterface.sequelize.query(
        `INSERT INTO users (
          name, email, password, status, role_id, image, registration_date, user, createdAt, updatedAt
        ) VALUES (
          :name, :email, :password, :status, :role_id, :image, :registration_date, :user, NOW(), NOW()
        )
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          password = VALUES(password),
          status = VALUES(status),
          role_id = VALUES(role_id),
          image = VALUES(image),
          registration_date = VALUES(registration_date),
          user = VALUES(user),
          updatedAt = NOW();`,
        {
          replacements: {
            name: 'Administrador general',
            email: 'admin@example.com', // 👈 Cambia si lo deseas
            password: hashedPassword,
            status: true,
            role_id: adminRoleId,
            image: 'users/default.jpg',
            registration_date: new Date(),
            user: 'admin'
          },
          transaction
        }
      );

      await transaction.commit();
      logger.info('✅ Seeder: Rol "admin" y usuario administrador creados/actualizados.');
    } catch (error) {
      await transaction.rollback();
      logger.error('❌ Error en el seeder:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    // Opcional: revertir (eliminar usuario y rol)
    // Pero normalmente NO se revierten los seeders de administrador
    logger.info('⚠️ Nota: El seeder de administrador no se revierte automáticamente por seguridad.');
  }
};