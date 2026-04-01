require("dotenv").config();
const nodemailer = require("nodemailer");
const logger = require("../../config/logger");

//logger.info("USER:", process.env.EMAIL_USER);
//logger.log("PASS length:", process.env.EMAIL_PASSWORD?.length);
// Cargar configuración desde .env (mejor que JSON para credenciales)
const transporter = nodemailer.createTransport({
  host: "mail.klint.cl",
  port: 465,
  secure: true, // true para puerto 465
  auth: {
    user: process.env.EMAIL_USER,      // no-reply@klint.cl
    pass: process.env.EMAIL_PASSWORD,  // contraseña de la cuenta
  },
  debug: true, // ✅ Habilitar debug de nodemailer
  logger: true // ✅ Logs internos de nodemailer
});

async function sendEmail({ to, subject, text, html }) {
  try {
    logger.info(`📧 Enviando correo a: ${to}`);
    logger.info(`📝 Asunto: ${subject}`);
    
    // ✅ Verificar configuración SMTP
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASSWORD) {
      logger.error('❌ EMAIL_USER o EMAIL_PASSWORD no están configurados en .env');
      throw new Error('Configuración SMTP incompleta');
    }
    
    logger.info(`👤 From: ${process.env.EMAIL_USER}`);

    const mailOptions = {
      from: `"Spree" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html,
    };

    logger.info('📤 Intentando enviar correo...');
    const info = await transporter.sendMail(mailOptions);
    logger.info(`✅ Correo enviado a: ${to}, ID: ${info.messageId}`);
    logger.info(`📬 Accepted: ${JSON.stringify(info.accepted)}`);
    logger.info(`📭 Rejected: ${JSON.stringify(info.rejected)}`);
    
    // ✅ Verificar respuesta del servidor SMTP
    if (info.response) {
      logger.info(`📨 Respuesta SMTP: ${info.response}`);
    }
    
    return info;
  } catch (error) {
    logger.error(`❌ Error al enviar el correo: ${error.message || error}`);
    logger.error(`🔍 Stack: ${error.stack}`);
    throw error;
  }
}

// Nuevo: envía a múltiples destinatarios
async function sendEmailsToUsers(users, { subject, text, html }) {
  const emails = users.map(u => u.email).filter(Boolean);
  if (emails.length === 0) {
    logger.warn("No hay emails válidos para enviar notificación");
    return [];
  }

  const results = [];
  for (const email of emails) {
    try {
      const result = await sendEmail({ to: email, subject, text, html });
      results.push({ email, success: true, messageId: result.messageId });
    } catch (error) {
      results.push({ email, success: false, error: error.message });
      // No lanzamos error aquí: queremos que otros correos se envíen aunque uno falle
    }
  }
  return results;
}
module.exports = { sendEmail, sendEmailsToUsers };