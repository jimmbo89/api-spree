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
});

async function sendEmail({ to, subject, text, html }) {
  try {
    logger.info("Enviando correo a:", to);

    const mailOptions = {
      from: `"Remitente" <${process.env.EMAIL_USER}>`,
      to,
      subject,
      text,
      html,
    };

    const info = await transporter.sendMail(mailOptions);
    logger.info("Correo enviado a:", to, "ID:", info.messageId);
    return info;
  } catch (error) {
    logger.error("Error al enviar el correo:", error.message || error);
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