// repositories/InvitationTokenRepository.js
const { Invitation } = require('../models');
const { Op } = require('sequelize');

const InvitationRepository = {
  async invalidatePendingByEmail(email, options = {}) {
  return await Invitation.update(
    { status: 'rejected' },
    {
      where: { email, status: 'pending' },
      ...options // permite pasar { transaction }
    }
  );
},

async createInvitation(data, options = {}) {
  const { token, email, invitedBy, expiresAt } = data;
  return await Invitation.create({
    token,
    email,
    invited_by: invitedBy,
    expires_at: expiresAt,
    status: 'pending'
  }, options); // pasa transaction si existe
},

  async findByToken(token) {
    return await Invitation.findOne({
      where: {
        token,
        expires_at: { [Op.gt]: new Date() },
        status: 'pending'
      }
    });
  },

  async markAsUsed(token, userId) {
    return await Invitation.update(
      { status: 'accepted', user_id: userId },
      { where: { token } }
    );
  },

 async markAsRejected(token) {
    return await Invitation.update(
      { status: 'rejected' },
      { where: { token } }
    );
  },

}

module.exports = InvitationRepository;