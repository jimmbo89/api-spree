const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { sequelize } = require("../models")
const authConfig = require('../../config/auth'); 
const logger = require("../../config/logger");
const { InvitationRepository, LogRepository } = require('../repositories');
const { sendEmail } = require('../services/EmailService');


const InvitationController = {
async sendInvitation(req, res) {
const { email } = req.body;
  const invitedBy = req.user.id;
  const inviterName = req.user.name;

    logger.info(`${inviterName} - Hace invitación a correo: ${email}`);
    logger.info("Datos recibidos:");
    logger.info(JSON.stringify(req.body ));

    const ip = req.ip || 'unknown';
    const userAgent = req.get('User-Agent') || null;
    // 1. Validar dominio
    
    // Lista de dominios permitidos (mejor en .env)
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
      return res.status(400).json({ error: `El dominio ${domain} no está autorizado.` });
    }

    const transaction = await sequelize.transaction();
  try {

    // 2. Invalidar invitaciones pendientes anteriores (para este email)
    await InvitationRepository.invalidatePendingByEmail(email, { transaction });

    // 3. Generar token JWT
    /*const payload = { email, invitedBy, type: 'invitation' };
    const token = jwt.sign(payload, authConfig.secret, { expiresIn: authConfig.expireInvitation });
    const decoded = jwt.decode(token);
    const expiresAt = new Date(decoded.exp * 1000);*/

    const token = uuidv4(); // ej: "a1b2c3d4-..."
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

    // 4. Guardar en DB
    await InvitationRepository.createInvitation({
      token,
      email,
      invitedBy,
      expiresAt
    }, { transaction });

    // 5. Enviar email con enlace seguro
    const inviteLink = `${process.env.FRONTEND_URL}/join?token=${encodeURIComponent(token)}`;

    const emailHtml = `
      <p>👋 ¡Hola!</p>
      <p>Has sido invitado por <strong>${inviterName}</strong> a unirte al equipo de <strong>Spree</strong>.</p>
      
      <div style="text-align: center; margin: 24px 0;">
        <a href="${inviteLink}" 
           style="display: inline-block; padding: 12px 24px; background-color: #006064; color: white; text-decoration: none; border-radius: 8px; font-weight: bold;">
          Aceptar invitación
        </a>
      </div>

      <p>🔒 Este enlace es válido por <strong>24 horas</strong>.</p>
      <p style="font-size: 13px; color: #666; margin-top: 24px;">
        Si no reconoces esta invitación, por favor ignórala.
      </p>
    `;

   await sendEmail({
      to: email,
      subject: "📬 Únete a Spre – Invitación de equipo",
      text: `Invitación de ${inviterName}. Enlace: ${inviteLink}`,
      html: emailHtml
    });
    
    // 6. Registrar en logs
    await LogRepository.create({
      user_id: invitedBy,
      action: 'user.invite',
      description: `Invitó al correo ${email}`,
      ip_address: ip,
      user_agent: userAgent,
      status: 'success'
    });
     // Confirmar transacción
    await transaction.commit();
    return res.status(201).json({ message: 'Invitación enviada', email, status: 'pending' });

  } catch (error) {
    // Revertir cambios en DB
    await transaction.rollback();

    // Registrar error
    logger.error(`Error en sendInvitation: ${error.message}`, error);
    await LogRepository.create({
      user_id: invitedBy,
      action: 'user.invite',
      description: `Error al invitar a ${email}: ${error.message}`,
      ip_address: ip,
      user_agent: userAgent,
      status: 'error'
    });
    return res.status(500).json({ error: 'Error al enviar invitación' });
  }
},

async verificInvitation(req, res){
const { token } = req.query;
    logger.info(`Aceptando invitación:`);
    logger.info("Token recibido:");
    logger.info(JSON.stringify(token ));

  if (!token) {
    return res.status(400).json({ msg: 'Token no proporcionado' });
  }

  try {
    // 1. Buscar en DB (estado + expiración física)
    const invitation = await InvitationRepository.findByToken(token);
    if (!invitation) {
      return res.status(401).json({ msg: 'Token inválido, expirado o ya utilizado' });
    }

    // 2. Verificar firma JWT
    /*jwt.verify(token, authConfig.secret, (err, decoded) => {
      if (err) {
        return res.status(401).json({ msg: 'Token no válido' });
      }*/
        await InvitationRepository.markAsUsed(invitation.token, null);
      // Todo OK: devolver datos para formulario de registro
      return res.json({
        valid: true,
        email: invitation.email,
        token // lo usarás en el registro final
      });

  } catch (error) {
    return res.status(500).json({ msg: 'Error interno', error: error.message });
  }
},
};

module.exports = InvitationController;