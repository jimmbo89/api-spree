// app/controllers/UserCompanyController.js
const { getUserId } = require('../../config/context');
const logger = require('../../config/logger');
const { UserRepository, CompanyRepository, RoleRepository } = require('../repositories');
const UserCompanyRepository = require('../repositories/UserCompanyRepository');
const { sendEmail } = require('../services/EmailService');

const UserCompanyController = {
  async create(req, res) {
    const { user_id, company_id, role_id, status, invited_by, invitation_token, expires_at } = req.body;

    // Validación de existencia
    const user = await UserRepository.findById(user_id);
    if (!user) return res.status(400).json({ success: false, message: 'Usuario no encontrado' });

    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(400).json({ success: false, message: 'Empresa no encontrada' });

    const role = await RoleRepository.findById(role_id);
    if (!role) return res.status(400).json({ success: false, message: 'Rol no encontrado' });

    try {
      const membership = await UserCompanyRepository.create({
        user_id,
        company_id,
        role_id,
        status,
        invited_by: invited_by || null,
        invitation_token: invitation_token || null,
        expires_at: expires_at || null
      });
      return res.status(201).json({ success: true, membership, message: "Membresía creada correctamente" });
    } catch (error) {
      logger.error("UserCompanyController->create:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async updateStatus(req, res) {
    const { id, status } = req.body;
    const record = await UserCompanyRepository.findByPk(id);
    if (!record) return res.status(400).json({ success: false, message: 'Membresía no encontrada' });

    try {
      const updated = await UserCompanyRepository.updateStatus(record, status);
      return res.status(200).json({ success: true, membership: updated, message: "Estado de membresía actualizado" });
    } catch (error) {
      logger.error("UserCompanyController->updateStatus:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

    async updateRole(req, res) {
        logger.info(
      `${req.user?.name || "Unknown"} - Actualiza rol del usuario en la company ${req.body.id}`
    );
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));
    const { id, role_id } = req.body;
    const record = await UserCompanyRepository.findByPk(id);
    if (!record) return res.status(400).json({ success: false, message: 'Membresía no encontrada' });
    
    const role = await RoleRepository.findById(role_id);
    if (!role) return res.status(400).json({ success: false, message: 'Rol no encontrado' });

    try {
      const updated = await UserCompanyRepository.updateRole(record, role_id);
      return res.status(200).json({ success: true, membership: updated, message: "Rol del usario actualizado correctamente" });
    } catch (error) {
      logger.error("UserCompanyController->updateStatus:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async destroy(req, res) {
    const { id } = req.body;
    const record = await UserCompanyRepository.findByPk(id);
    if (!record) return res.status(400).json({ success: false, message: 'Membresía no encontrada' });

    try {
      await UserCompanyRepository.delete(record);
      return res.status(200).json({ success: true, message: "Membresía eliminada" });
    } catch (error) {
      logger.error("UserCompanyController->destroy:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async findByUserAndCompany(req, res) {
    const { user_id, company_id } = req.body;
    try {
      const membership = await UserCompanyRepository.findByUserIdAndCompanyId(user_id, company_id);
      if (!membership) {
        return res.status(404).json({ success: false, message: 'Membresía no encontrada' });
      }
      const populated = await UserCompany.findByPk(membership.id, {
        include: [
          { model: User, as: 'user' },
          { model: Company, as: 'company' },
          { model: Role, as: 'role' }
        ]
      });
      return res.status(200).json({ success: true, membership: mapUserCompany(populated) });
    } catch (error) {
      logger.error("UserCompanyController->findByUserAndCompany:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async findByToken(req, res) {
    const { invitation_token } = req.body;
    try {
      const membership = await UserCompanyRepository.findByInvitationToken(invitation_token);
      if (!membership) {
        return res.status(404).json({ success: false, message: 'Invitación no válida o expirada' });
      }
      const populated = await UserCompany.findByPk(membership.id, {
        include: [
          { model: Company, as: 'company' },
          { model: Role, as: 'role' }
        ]
      });
      return res.status(200).json({ success: true, membership: mapUserCompany(populated) });
    } catch (error) {
      logger.error("UserCompanyController->findByToken:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },

  async listByCompany(req, res) {
    const { company_id, status } = req.body;
    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(400).json({ success: false, message: 'Empresa no encontrada' });

    try {
      const memberships = await UserCompanyRepository.getMembershipsByCompanyId(
        parseInt(company_id, 10),
        status !== undefined ? parseInt(status, 10) : null
      );
      return res.status(200).json({ success: true, memberships });
    } catch (error) {
      logger.error("UserCompanyController->listByCompany:", error.message);
      return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
    }
  },
  async list(req, res) {
  const { user_id, company_id, status } = req.body;

  // Validaciones de existencia solo si se pasan los IDs
  if (user_id) {
    const user = await UserRepository.findById(user_id);
    if (!user) return res.status(400).json({ success: false, message: 'Usuario no encontrado' });
  }

  if (company_id) {
    const company = await CompanyRepository.findById(company_id);
    if (!company) return res.status(400).json({ success: false, message: 'Empresa no encontrada' });
  }

  try {
    const memberships = await UserCompanyRepository.getMemberships({
      user_id: user_id ? parseInt(user_id, 10) : undefined,
      company_id: company_id ? parseInt(company_id, 10) : undefined,
      status: status !== undefined ? parseInt(status, 10) : null
    });

    return res.status(200).json({ success: true, memberships });
  } catch (error) {
    logger.error("UserCompanyController->list:", error.message);
    return res.status(500).json({ success: false, error: "Error interno del servidor", details: error.message });
  }
},
async listAvailableCompanies(req, res) {
          logger.info(
      `${req.user?.name || "Unknown"} - Busca las compañias existentes no asociadas`
    );
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body));
  const {   user_id: bodyuser_id } = req.body;

    const user_id = bodyuser_id || getUserId();
    if (bodyuser_id) {
      const user = await UserRepository.findById(bodyuser_id);
      if (!user) {
        return res.status(400).json({ success: false, message: 'Usuario no encontrado' });
      }      
    }

  try {
    const availableCompanies = await UserCompanyRepository.getAvailableCompaniesForUser(user_id);
    return res.status(200).json({ success: true, companies: availableCompanies });
  } catch (error) {
    logger.error("UserCompanyController->listAvailableCompanies:", error.message);
    return res.status(500).json({ success: false, error: "Error al cargar empresas disponibles", details: error.message });
  }
},

/*async createMembershipRequest(req, res) {
  const { company_id, user_id: bodyuser_id } = req.body;
      const user_id = bodyuser_id || getUserId();

  logger.info(`Usuario ${req.user.name} solicita acceso a la empresa ${company_id}`);

  try {
    // Validar usuario
    const user = await UserRepository.findById(user_id);
    if (!user) {
      return res.status(400).json({ success: false, message: 'Usuario no encontrado' });
    } 

    // Validar empresa
    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(400).json({ 
        success: false, 
        message: 'La empresa no es válida o no está activa' 
      });
    }

    // Verificar si ya es miembro
    const existingMembership = await UserCompanyRepository.findByUserIdAndCompanyId(user_id, company_id);
    if (existingMembership && existingMembership.status === 1) {
      return res.status(409).json({
        success: false,
        message: 'Ya eres miembro de esta empresa'
      });
    }

    let role_id = null;
          const role = await RoleRepository.findByName("Viewer");
        if (role) {
          role_id = role.id;
        }

    const membership = await UserCompanyRepository.create(
          {
            user_id,
            company_id,
            role_id,
            status: -1,
            joined_at: null,
            invited_by: null,
          }
        );
      await notifyAdminsAboutMembershipRequest({ user, company, membershipId: membership.id });
      return res.status(201).json({
      success: true,
      message: 'Solicitud enviada correctamente. Un administrador debe enviarle un token de invitacións.',
    });

  } catch (error) {
    logger.error('UserCompanyController->createMembershipRequest:', error.message);
    return res.status(500).json({
      success: false,
      error: 'Error interno al procesar la solicitud'
    });
  }
},*/

async createMembershipRequest(req, res) {
  const { company_id, user_id: bodyuser_id } = req.body;
  const user_id = bodyuser_id || getUserId();

  logger.info(`Usuario ${req.user.name} solicita acceso a la empresa ${company_id}`);

  try {
    // Validar usuario
    const user = await UserRepository.findById(user_id);
    if (!user) {
      return res.status(400).json({ success: false, message: 'Usuario no encontrado' });
    } 

    // Validar empresa
    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      return res.status(400).json({ 
        success: false, 
        message: 'La empresa no es válida o no está activa' 
      });
    }

    // Verificar membresía existente
    let existingMembership = await UserCompanyRepository.findByUserIdAndCompanyId(user_id, company_id);
    
    if (existingMembership) {
      if (existingMembership.status === 1) {
        return res.status(409).json({
          success: false,
          message: 'Ya eres miembro de esta empresa'
        });
      }
      // Si existe pero no está activa, reutilizarla (actualizar a pendiente)
      if (existingMembership.status !== -1) {
        existingMembership = await UserCompanyRepository.updateStatus(
          existingMembership,
          -1 // pendiente
        );
      }
      // Si ya está pendiente (-1), usarla tal cual
    } else {
      // Crear nueva membresía
      let role_id = null;
      const role = await RoleRepository.findByName("Viewer");
      if (role) {
        role_id = role.id;
      }

      existingMembership = await UserCompanyRepository.create({
        user_id,
        company_id,
        role_id,
        status: -1,
        joined_at: null,
        invited_by: null,
      });
    }

    // Notificar a administradores
    await notifyAdminsAboutMembershipRequest({ 
      requester: user, 
      company, 
      membershipId: existingMembership.id 
    });

    return res.status(201).json({
      success: true,
      message: 'Solicitud enviada correctamente. Un administrador debe aprobarla.',
    });

  } catch (error) {
    logger.error('UserCompanyController->createMembershipRequest:', {
      message: error.message,
      stack: error.stack
    });
    return res.status(500).json({
      success: false,
      error: 'Error interno al procesar la solicitud'
    });
  }
},
async handleMembershipRequest(req, res) {
  const { id } = req.params;
 const isApprove = req.originalUrl.endsWith('/approve');
  const action = isApprove ? 'approve' : 'reject';

  try {
    // 1. Obtener membresía
    const membership = await UserCompanyRepository.findByPk(id);
    if (!membership) {
      return res.status(404).json({ success: false, message: 'Solicitud no encontrada' });
    }

    // 2. Validar estado pendiente
    if (membership.status !== -1) {
      return res.status(400).json({ 
        success: false, 
        message: 'La solicitud ya fue procesada' 
      });
    }

    // 4. Ejecutar acción
    let resultMessage, emailSubject, emailHtml;
    
    if (isApprove) {
      // Aprobar: actualizar a status 1
      await UserCompanyRepository.updateStatus(membership, 1);
      resultMessage = 'Solicitud aprobada exitosamente';
      emailSubject = `✅ Solicitud aprobada: `;
    } else {
      // Rechazar: eliminar registro
      await UserCompanyRepository.delete(membership);
      resultMessage = 'Solicitud rechazada exitosamente';
      emailSubject = `❌ Solicitud rechazada: `;
    }

    // 5. Notificar al solicitante
    const user = await UserRepository.findById(membership.user_id);
    const company = await CompanyRepository.findById(membership.company_id);

    if (user && company) {
      const actionText = isApprove ? 'aprobada' : 'rechazada';
      const actionEmoji = isApprove ? '🎉' : '👋';
      const actionColor = isApprove ? '#10b981' : '#ef4444';
      
      emailHtml = `
        <p>${actionEmoji} Hola ${user.name},</p>
        <p>Tu solicitud para unirte a <strong>${company.name}</strong> ha sido <strong>${actionText}</strong>.</p>
        ${isApprove ? '<p>¡Ya puedes acceder a la plataforma!</p>' : '<p>Si crees que esto es un error, contacta a un administrador.</p>'}
      `;

      emailSubject += company.name;

      await sendEmail({
        to: user.email,
        subject: emailSubject,
        html: emailHtml
      }).catch(err => logger.warn('Error al enviar notificación:', err.message));
    }

    // 6. Responder con HTML amigable
    const successColor = isApprove ? '#10b981' : '#ef4444';
    const icon = isApprove ? '✅' : '❌';
    
    return res.status(200).send(`
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 40px;">
        <h2 style="color: ${successColor};">${icon} ${resultMessage}</h2>
        <p>El usuario ha sido notificado por correo.</p>
        <a href="${process.env.FRONTEND_URL}" 
           style="display: inline-block; margin-top: 20px; padding: 10px 20px; background-color: #3b82f6; color: white; text-decoration: none; border-radius: 6px;">
          Volver al panel
        </a>
      </div>
    `);

  } catch (error) {
    logger.error(`UserCompanyController->handleMembershipRequest (${action}) falló: ${error.message}`, {
  stack: error.stack,
  userId: req.user?.id,
  requestId: id
});
    return res.status(500).send(`
      <div style="font-family: Arial, sans-serif; text-align: center; padding: 40px; color: #ef4444;">
        <h2>❌ Error al procesar la solicitud</h2>
        <p>Por favor, inténtalo nuevamente.</p>
      </div>
    `);
  }
}
};
// Reutilizamos la función de mapeo del repositorio
function mapUserCompany(record) {
  if (!record) return null;
  return {
    id: record.id,
    user_id: record.user_id,
    company_id: record.company_id,
    role_id: record.role_id,
    status: record.status,
    joined_at: record.joined_at,
    invited_by: record.invited_by,
    invitation_token: record.invitation_token,
    expires_at: record.expires_at,
    user: record.user ? { id: record.user.id, name: record.user.name, email: record.user.email } : null,
    company: record.company ? { id: record.company.id, name: record.company.name } : null,
    role: record.role ? { id: record.role.id, name: record.role.name } : null
  };
}

async function notifyAdminsAboutMembershipRequest({ requester, company, membershipId }) {
  try {
    // 1. Obtener administradores
    const adminMemberships = await UserCompanyRepository.findActiveByCompanyIdAndRoleName(
      company.id,
      'admin'
    );

    if (!adminMemberships || adminMemberships.length === 0) {
      logger.warn(`No se encontraron administradores para la empresa ${company.id}`);
      return;
    }

    const adminEmails = [...new Set(adminMemberships.map(m => m.user.email))];

    // 2. 🔥 Enlaces DIRECTOS al API (no al frontend)
    const approveLink = `${process.env.API_URLSOLICITED}/validate-requests/${membershipId}/approve`;
    const rejectLink = `${process.env.API_URLSOLICITED}/validate-requests/${membershipId}/reject`;

    // 3. Enviar correo
    for (const email of adminEmails) {
      const emailHtml = `
        <p>👋 ¡Hola!</p>
        <p>El usuario <strong>${requester.name} (${requester.email})</strong> ha solicitado unirse a la empresa <strong>${company.name}</strong>.</p>
        
        <div style="text-align: center; margin: 24px 0;">
          <a href="${approveLink}" 
             style="display: inline-block; padding: 12px 24px; background-color: #10b981; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; margin-right: 12px;">
            Aceptar solicitud
          </a>
          <a href="${rejectLink}" 
             style="display: inline-block; padding: 12px 24px; background-color: #ef4444; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
            Rechazar solicitud
          </a>
        </div>

        <p><em>Al hacer clic, se actualizará automáticamente el estado de la solicitud.</em></p>
        <p style="font-size: 13px; color: #666; margin-top: 24px;">
          Si los enlaces no funcionan, copia y pega la URL en tu navegador.
        </p>
      `;

      await sendEmail({
        to: email,
        subject: `📬 Nueva solicitud de acceso a ${company.name}`,
        html: emailHtml
      });
    }

    logger.info(`Notificación enviada a ${adminEmails.length} administradores para la solicitud ${membershipId}`);
  }catch (error) {
  logger.error('Error al notificar a administradores:', {
    message: error.message,
    stack: error.stack,
    // Si es un error de Sequelize o Axios, incluye más detalles
    originalError: error.original || error.response?.data || error
  });
}
}

module.exports = UserCompanyController;