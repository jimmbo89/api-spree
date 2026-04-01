const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require("../models");
const authConfig = require('../../config/auth');
const bcrypt = require('bcrypt');
const logger = require("../../config/logger");
const { InvitationRepository, LogRepository, CompanyRepository, UserRepository, UserCompanyRepository, RoleRepository } = require('../repositories');
const { sendEmail } = require('../services/EmailService');

// 📨 Plantilla de correo de invitación (consistente en toda la app)
function buildInvitationEmailHtml({ inviterName, companyName, inviteLink, email, temporalPassword = null }) {
  return `
    <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
      <div style="background-color: white; padding: 30px; border-radius: 12px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);">
        <h2 style="color: #006064; margin-top: 0;">👋 ¡Hola!</h2>
        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          Has sido invitado por <strong>${inviterName}</strong> a unirte al equipo de
          <strong>${companyName}</strong> en <strong>Spree</strong>.
        </p>
        <p style="font-size: 16px; line-height: 1.6; color: #333;">
          Al aceptar esta invitación, podrás colaborar con su organización directamente desde la plataforma.
        </p>
        
        ${temporalPassword ? `
        <div style="background-color: #fff3cd; border-left: 4px solid #ffc107; padding: 15px; margin: 20px 0;">
          <p style="font-size: 14px; color: #856404; margin: 0;">
            <strong>🔐 Tus credenciales de acceso:</strong><br>
            <strong>Email:</strong> ${email}<br>
            <strong>Contraseña temporal:</strong> ${temporalPassword}
          </p>
        </div>
        <div style="background-color: #d1ecf1; border-left: 4px solid #17a2b8; padding: 15px; margin: 20px 0;">
          <p style="font-size: 14px; color: #0c5460; margin: 0;">
            <strong>⚠️ Recomendación de seguridad:</strong><br>
            Por tu seguridad, te recomendamos cambiar tu contraseña después de iniciar sesión por primera vez.
          </p>
        </div>
        ` : ''}
        
        <div style="text-align: center; margin: 32px 0;">
          <a href="${inviteLink}"
             style="display: inline-block; padding: 14px 32px; background-color: #006064; color: white; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 16px; transition: background-color 0.2s;">
            Aceptar invitación
          </a>
        </div>
        <p style="font-size: 14px; color: #555; text-align: center; margin-bottom: 0;">
          🔒 Este enlace es válido durante <strong>24 horas</strong> por seguridad.
        </p>
        <hr style="border: 0; border-top: 1px solid #eee; margin: 28px 0;">
        <p style="font-size: 13px; color: #777; margin-top: 24px; text-align: center;">
          Si no reconoces esta invitación o no esperabas unirte a <strong>${companyName}</strong>,
          por favor ignórala.
        </p>
      </div>
      <p style="font-size: 12px; color: #999; text-align: center; margin-top: 20px;">
        © ${new Date().getFullYear()} Spree. Todos los derechos reservados.
      </p>
    </div>
  `;
}

const InvitationController = {
/**
 * ✅ Enviar/reenviar invitación a usuario (existente o nuevo)
 * Guarda el token en user_companies (tabla principal)
 */
async sendInvitation(req, res) {
  const { email, company_id, role_id = 3 } = req.body; // role_id 3 = Viewer por defecto
  const invitedBy = req.user.id;
  const inviterName = req.user.name;

  logger.info(`${inviterName} - Envía invitación a correo: ${email}`);
  logger.info("Datos recibidos:");
  logger.info(JSON.stringify(req.body));

  const ip = req.ip || 'unknown';
  const userAgent = req.get('User-Agent') || null;
  
  // ✅ Obtener nombre de la empresa
  let companyName = 'Spree';
  try {
    const company = await CompanyRepository.findById(company_id);
    if (company) {
      companyName = company.name;
    }
  } catch (error) {
    logger.warn(`No se pudo obtener el nombre de la empresa ${company_id}: ${error.message}`);
  }
  
  // 1. Validar dominio
  const ALLOWED_EMAIL_DOMAINS = (process.env.ALLOWED_EMAIL_DOMAINS || 'klint.cl').split(',');
  const domain = email.split('@')[1];
  if (!ALLOWED_EMAIL_DOMAINS.includes(domain)) {
    await LogRepository.create({
      user_id: invitedBy,
      action: 'user.invite',
      description: `Dominio no permitido: ${domain || 'desconocido'} para ${email}`,
      ip_address: ip,
      user_agent: userAgent,
      status: 'error'
    });
    return res.status(400).json({
      success: false,
      error: `El dominio ${domain} no está autorizado.`
    });
  }

  const transaction = await sequelize.transaction();

  try {
    // ✅ Validar que el rol existe
    const role = await RoleRepository.findById(role_id);
    if (!role) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `El rol con ID ${role_id} no existe`
      });
    }

    // ✅ Validar que la empresa existe
    const company = await CompanyRepository.findById(company_id);
    if (!company) {
      await transaction.rollback();
      return res.status(400).json({
        success: false,
        message: `La empresa con ID ${company_id} no existe`
      });
    }

    // 2. Buscar o crear usuario
    let user = await UserRepository.findByEmail(email);
    let userId;
    let temporalPassword = null;

    if (!user) {
      // Crear usuario con status inactivo hasta que acepte
      const userName = email.split('@')[0];
      // Generar contraseña temporal válida (mínimo 6 caracteres)
      temporalPassword = 'Temp' + Math.random().toString(36).slice(-4);
      const bcrypt = require('bcrypt');
      const hashedPassword = bcrypt.hashSync(temporalPassword, 10);

      user = await UserRepository.create({
        name: userName,
        email: email,
        password: hashedPassword, // ✅ Contraseña temporal válida
        user: userName,
        status: 0, // Inactivo hasta aceptar invitación
      }, null, transaction);
      userId = user.id;
    } else {
      userId = user.id;

      // Verificar si ya tiene membresía activa en esta empresa
      const existingMembership = await UserCompanyRepository.findByUserIdAndCompanyId(userId, company_id);
      if (existingMembership && existingMembership.status === 1) {
        await transaction.rollback();
        return res.status(400).json({
          success: false,
          message: `El usuario ${email} ya es miembro activo de esta empresa`
        });
      }
    }

    // 3. Generar token de invitación
    const invitationToken = uuidv4();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h
    const hashedToken = bcrypt.hashSync(invitationToken, 10);

    // 4. Crear o actualizar membresía en user_companies
    let membership = await UserCompanyRepository.findByUserIdAndCompanyId(userId, company_id);

    if (membership) {
      // Actualizar membresía existente - ✅ Solo actualizar campos de invitación, NO role_id
      await UserCompanyRepository.update(membership, {
        status: -1, // Pendiente
        invited_by: invitedBy,
        invitation_token: hashedToken,
        expires_at: expiresAt,
        joined_at: null
      }, transaction);
    } else {
      // Crear nueva membresía
      membership = await UserCompanyRepository.create({
        user_id: userId,
        company_id,
        role_id,
        status: -1, // Pendiente
        invited_by: invitedBy,
        invitation_token: hashedToken,
        expires_at: expiresAt,
        joined_at: null
      }, transaction);
    }
    
    // 5. Opcional: Guardar en invitations para auditoría histórica
    try {
      await InvitationRepository.invalidatePendingByEmail(email, { transaction });
      await InvitationRepository.createInvitation({
        token: hashedToken,
        email,
        invitedBy,
        expiresAt,
        status: 'pending'
      }, { transaction });
    } catch (auditError) {
      logger.warn(`No se pudo guardar auditoría en invitations: ${auditError.message}`);
      // No fallamos la operación principal
    }

    // 6. Enviar email con enlace seguro (apunta al FRONTEND)
    // El frontend debe tener una ruta que maneje la invitación, ej: /invitacion o /login
    const inviteLink = `${process.env.FRONTEND_URL}/login?token=${encodeURIComponent(invitationToken)}&company_id=${company_id}`;

    const emailHtml = buildInvitationEmailHtml({
      inviterName,
      companyName,
      inviteLink,
      email,
      temporalPassword // ✅ Incluir contraseña si es usuario nuevo
    });

    await sendEmail({
      to: email,
      subject: `📬 Únete a ${companyName} en Spree Invitación de ${inviterName}`,
      text: `Invitación de ${inviterName}. Enlace: ${inviteLink}${temporalPassword ? `\n\nUsuario: ${user.email}\nContraseña temporal: ${temporalPassword}` : ''}`,
      html: emailHtml
    });

    // 7. Registrar en logs
    await LogRepository.create({
      user_id: invitedBy,
      company_id,
      action: 'user.invite',
      description: `Invitó al correo ${email} a la empresa ${companyName}`,
      ip_address: ip,
      user_agent: userAgent,
      status: 'success'
    });
    
    await transaction.commit();
    
    return res.status(201).json({ 
      success: true,
      message: 'Invitación enviada correctamente',
      data: {
        email,
        company_id,
        user_id: userId,
        membership_id: membership.id,
        status: 'pending'
      }
    });

  } catch (error) {
    await transaction.rollback();
    logger.error(`Error en sendInvitation: ${error.message}`, error);
    
    await LogRepository.create({
      user_id: invitedBy,
      action: 'user.invite',
      description: `Error al invitar a ${email}: ${error.message}`,
      ip_address: ip,
      user_agent: userAgent,
      status: 'error'
    });
    
    return res.status(500).json({ 
      success: false,
      error: 'Error al enviar invitación',
      details: error.message 
    });
  }
},

/**
 * ✅ Verificar y aceptar invitación
 * Valida token y actualiza status a 1 en user_companies
 */
async verificInvitation(req, res) {
  const { token, company_id } = req.body;
  const ip = req.ip || 'unknown';
  const userAgent = req.get('User-Agent') || null;
  
  logger.info(`Verificando invitación: company_id=${company_id}`);

  if (!token || !company_id) {
    return res.status(400).json({ 
      success: false,
      message: 'Token y company_id son requeridos' 
    });
  }

  const transaction = await sequelize.transaction();
  
  try {
    // 1. Buscar membresías pendientes en esta empresa
    const memberships = await UserCompanyRepository.findAll({
      company_id,
      status: -1 // Solo pendientes
    });
    
    if (!memberships || memberships.length === 0) {
      await transaction.rollback();
      return res.status(404).json({ 
        success: false,
        message: 'No hay invitaciones pendientes para esta empresa',
        code: 'INVITATION_NOT_FOUND'
      });
    }
    
    // 2. Buscar la membresía con token válido
    let validMembership = null;
    for (const membership of memberships) {
      if (membership.invitation_token) {
        const isMatch = await bcrypt.compare(token, membership.invitation_token);
        if (isMatch) {
          // Verificar expiración
          if (membership.expires_at && new Date(membership.expires_at) < new Date()) {
            await transaction.rollback();
            return res.status(401).json({ 
              success: false,
              message: 'Invitación expirada',
              code: 'INVITATION_EXPIRED'
            });
          }
          validMembership = membership;
          break;
        }
      }
    }
    
    if (!validMembership) {
      await transaction.rollback();
      return res.status(401).json({ 
        success: false,
        message: 'Token inválido o ya utilizado',
        code: 'INVALID_TOKEN'
      });
    }
    
    // 3. Obtener datos del usuario y empresa
    const user = await UserRepository.findById(validMembership.user_id, transaction);
    const company = await CompanyRepository.findById(company_id, transaction);
    const role = await RoleRepository.findById(validMembership.role_id, transaction);
    
    // 4. Activar membresía
    await UserCompanyRepository.update(validMembership, {
      status: 1, // Activo
      joined_at: new Date(),
      invitation_token: null, // Limpiar token
      expires_at: null
    }, transaction);
    
    // 5. Actualizar usuario a activo si estaba inactivo
    if (user && user.status === 0) {
      await UserRepository.update(user, { status: 1 }, transaction);
    }
    
    // 6. Opcional: Actualizar invitations para auditoría
    try {
      await InvitationRepository.update(
        { email: user.email, status: 'accepted' },
        { token: validMembership.invitation_token },
        transaction
      );
    } catch (auditError) {
      logger.warn(`No se pudo actualizar auditoría: ${auditError.message}`);
    }
    
    // 7. Registrar log
    await LogRepository.create({
      user_id: validMembership.user_id,
      company_id: validMembership.company_id,
      action: 'user.invite.accept',
      description: `Usuario ${user.email} aceptó invitación a la empresa`,
      ip_address: ip,
      user_agent: userAgent,
      status: 'success'
    });
    
    await transaction.commit();
    
    return res.status(200).json({
      success: true,
      message: `¡Bienvenido a ${company.name}! Tu invitación ha sido aceptada correctamente.`,
      data: {
        user_id: user.id,
        email: user.email,
        company_id: company.id,
        company_name: company.name,
        role_id: role.id,
        role_name: role.name,
        membership_id: validMembership.id
      }
    });

  } catch (error) {
    await transaction.rollback();
    logger.error(`Error en verificInvitation: ${error.message}`, error);
    
    return res.status(500).json({ 
      success: false,
      message: 'Error interno al procesar invitación',
      details: error.message 
    });
  }
}

};

module.exports = InvitationController;
