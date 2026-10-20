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

async function sendPasswordResetCode(email, username, code) {
  await sendToRecipient(email, {
    subject: 'Reset your LogiAuth password',
    text: `Hello ${username},\n\nYour LogiAuth password reset email code is ${code}. It expires in 10 minutes. Enter this code in LogiAuth to choose a new password. If you did not request this, ignore this email.`,
    html: `<div style="font-family:Arial,sans-serif;color:#17191f"><p>Hello ${escapeHtml(username)},</p><p>Your LogiAuth password reset email code is:</p><p style="font-size:32px;font-weight:bold;letter-spacing:8px">${code}</p><p>This code expires in 10 minutes. Enter it in LogiAuth to choose a new password. If you did not request this, ignore this email.</p></div>`,
  });
}

async function sendPasswordResetNotification(email, username) {
  await sendToRecipient(email, {
    subject: 'Your LogiAuth password was reset',
    text: `Hello ${username},\n\nThe password for your LogiAuth account was reset. All existing passkeys and recovery codes were removed. You will need to sign in with the new password, set up a new passkey, and generate new recovery codes.\n\nIf you did not do this, secure your email account and contact support immediately.`,
    html: `<div style="font-family:Arial,sans-serif;color:#17191f"><p>Hello ${escapeHtml(username)},</p><p>The password for your LogiAuth account was reset. All existing passkeys and recovery codes were removed.</p><p>You will need to sign in with the new password, set up a new passkey, and generate new recovery codes.</p><p>If you did not do this, secure your email account and contact support immediately.</p></div>`,
  });
}

async function sendPasskeyAddedNotification(email, username) {
  await sendToRecipient(email, {
    subject: 'A passkey was added to your LogiAuth account',
    text: `Hello ${username},\n\nA new passkey was added to your LogiAuth account. If you did not just add it, reset your LogiAuth password and secure your email account immediately.`,
    html: `<div style="font-family:Arial,sans-serif;color:#17191f"><p>Hello ${escapeHtml(username)},</p><p>A new passkey was added to your LogiAuth account.</p><p>If you did not just add it, reset your LogiAuth password and secure your email account immediately.</p></div>`,
  });
}

async function sendRecoveryCodesChangedNotification(email, username) {
  await sendToRecipient(email, {
    subject: 'Your LogiAuth recovery codes changed',
    text: `Hello ${username},\n\nNew recovery codes were generated for your LogiAuth account. All previous recovery codes are now invalid. If you did not do this, reset your LogiAuth password and secure your email account immediately.`,
    html: `<div style="font-family:Arial,sans-serif;color:#17191f"><p>Hello ${escapeHtml(username)},</p><p>New recovery codes were generated for your LogiAuth account. All previous recovery codes are now invalid.</p><p>If you did not do this, reset your LogiAuth password and secure your email account immediately.</p></div>`,
  });
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

module.exports = {
  sendLoginCode,
  sendRegistrationCode,
  sendPasswordResetCode,
  sendPasswordResetNotification,
  sendPasskeyAddedNotification,
  sendRecoveryCodesChangedNotification,
  sendWelcomeEmail,
};
