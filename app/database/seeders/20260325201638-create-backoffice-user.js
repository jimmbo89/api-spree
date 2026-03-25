'use strict';

const bcrypt = require('bcrypt');
const logger = require('../../../config/logger');

module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    
    try {
      // 1. Crear/obtener el rol 'BackOffice'
      await queryInterface.sequelize.query(
        `INSERT INTO roles (name, status, description, createdAt, updatedAt)
         VALUES (:name, :status, :description, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           status = VALUES(status),
           description = VALUES(description),
           updatedAt = NOW();`,
        {
          replacements: {
            name: 'BackOffice',
            status: true,
            description: 'Usuario root global con acceso total a todas las empresas sin pertenecer a ninguna'
          },
          type: Sequelize.QueryTypes.INSERT,
          transaction
        }
      );

      // Obtener el ID del rol BackOffice
      const [roleResult] = await queryInterface.sequelize.query(
        `SELECT id FROM roles WHERE name = 'BackOffice'`,
        { 
          type: Sequelize.QueryTypes.SELECT, 
          transaction 
        }
      );

      if (!roleResult) {
        throw new Error('No se pudo obtener el ID del rol "BackOffice"');
      }

      const backOfficeRoleId = roleResult.id;

      // 2. Hashear la contraseña
      const hashedPassword = bcrypt.hashSync('BackOffice@2024', 10);

      // 3. Insertar/actualizar el usuario BackOffice con role_id
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
            name: 'Administrador BackOffice',
            email: 'backoffice@spree.com',
            password: hashedPassword,
            status: true,
            role_id: backOfficeRoleId, // ✅ Asignar rol global
            image: 'users/default.jpg',
            registration_date: new Date(),
            user: 'backoffice'
          },
          transaction
        }
      );

      await transaction.commit();
      logger.info('✅ Seeder: Rol "BackOffice" y usuario root global creados/actualizados.');
      logger.info('📧 Email: backoffice@spree.com');
      logger.info('🔑 Password: BackOffice@2024');
      logger.info('🔐 Este usuario tiene acceso global sin necesidad de empresa.');
    } catch (error) {
      await transaction.rollback();
      logger.error('❌ Error en el seeder BackOffice:', error);
      throw error;
    }
  },

  async down(queryInterface, Sequelize) {
    logger.info('⚠️ Nota: El seeder de BackOffice no se revierte automáticamente por seguridad.');
  }
};
