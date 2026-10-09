const nodemailer = require('nodemailer');

let transporter;

function getTransporter() {
  const { GMAIL_USER, GMAIL_APP_PASSWORD } = process.env;
  if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
    throw new Error('Set GMAIL_USER and GMAIL_APP_PASSWORD in .env.');
  }

  if (!transporter) {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD.replace(/\s/g, ''),
      },
    });
  }
  return transporter;
}

async function sendToRecipient(email, message) {
  const mailer = getTransporter();
  const info = await mailer.sendMail({
    from: `"LogiAuth" <${process.env.GMAIL_USER}>`,
    to: email,
    ...message,
  });
  const accepted = (info.accepted || []).some(
    (recipient) => String(recipient).toLowerCase() === email.toLowerCase()
  );
  if (!accepted) {
    const error = new Error('The email provider did not accept the recipient.');
    error.code = 'ERECIPIENTREJECTED';
    throw error;
  }
  console.info(`Email accepted by SMTP (message ${info.messageId || 'id unavailable'}).`);
}

async function sendLoginCode(email, username, code) {
  await sendToRecipient(email, {
    subject: 'Your LogiAuth verification code',
    text: `Hello ${username},\n\nYour LogiAuth verification code is ${code}. It expires in 5 minutes. If you did not try to sign in, you can ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;color:#17191f"><p>Hello ${escapeHtml(username)},</p><p>Your LogiAuth verification code is:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px">${code}</p><p>This code expires in 5 minutes. If you did not try to sign in, you can ignore this email.</p></div>`,
  });
}

async function sendRegistrationCode(email, username, code) {
  return sendLoginCode(email, username, code);
}

async function sendWelcomeEmail(email, username) {
  await sendToRecipient(email, {
    subject: 'Welcome to LogiAuth',
    text: `Welcome to LogiAuth, ${username}!\n\nYour email is verified and your learning account is ready. Sign in anytime to organize your courses and prepare for exams.`,
    html: `<div style="font-family:Arial,sans-serif;color:#17191f"><h1>Welcome to LogiAuth, ${escapeHtml(username)}!</h1><p>Your email is verified and your learning account is ready.</p><p>Sign in anytime to organize your courses and prepare for exams.</p></div>`,
  });
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[character]);
}

module.exports = { sendLoginCode, sendRegistrationCode, sendWelcomeEmail };
