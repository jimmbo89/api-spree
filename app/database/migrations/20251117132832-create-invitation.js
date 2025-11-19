// migrations/XXXX-create-invitation-token.js
module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('invitations', {
      id: {
        allowNull: false,
        autoIncrement: true,
        primaryKey: true,
        type: Sequelize.INTEGER
      },
      token: {
        type: Sequelize.STRING,
        allowNull: false,
        unique: true
      },
      email: {
        type: Sequelize.STRING,
        allowNull: false,
        validate: { isEmail: true }
      },
      status: {
        type: Sequelize.ENUM('pending', 'accepted', 'rejected'),
        defaultValue: 'pending'
      },
      user_id: { // snake_case en la base de datos
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      },
      invited_by: { // snake_case en la base de datos
        type: Sequelize.BIGINT,
        allowNull: true,
        references: {
          model: 'users',
          key: 'id'
        },
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE'
      },
      expires_at: {
        type: Sequelize.DATE,
        allowNull: false
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
        defaultValue: Sequelize.NOW
      }
    });

    // Índice para búsquedas rápidas
    await queryInterface.addIndex('invitations', ['token']);
    await queryInterface.addIndex('invitations', ['email']);
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('invitations');
  }
};