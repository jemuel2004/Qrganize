import nodemailer from 'nodemailer';
import type SMTPTransport from 'nodemailer/lib/smtp-transport';

function smtpUser(): string {
  return (process.env.SMTP_USER || '').trim();
}

function smtpPass(): string {
  // Accept SMTP_PASS (current project) or SMTP_PASSWORD (Gmail docs alias).
  // Gmail App Passwords are often copied with spaces — strip them.
  return (process.env.SMTP_PASS || process.env.SMTP_PASSWORD || '').replace(/\s+/g, '');
}

export function isMailConfigured(): boolean {
  return Boolean(smtpUser() && smtpPass());
}

function transportOptions(): SMTPTransport.Options {
  const host = (process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const port = Number(process.env.SMTP_PORT || 587);
  return {
    host,
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: {
      user: smtpUser(),
      pass: smtpPass(),
    },
    tls: {
      minVersion: 'TLSv1.2',
    },
  };
}

function fromAddress(): string {
  return (process.env.SMTP_FROM || `QRganize <${smtpUser()}>`).trim();
}

function createTransport() {
  if (!isMailConfigured()) {
    throw new Error('MAIL_NOT_CONFIGURED');
  }
  return nodemailer.createTransport(transportOptions());
}

export async function sendLoginOtpEmail(
  to: string,
  code: string,
  purpose: 'login' | 'password_change' | 'disable_otp' = 'login'
): Promise<void> {
  const transporter = createTransport();
  const subject =
    purpose === 'password_change'
      ? 'QRganize Identity Verification'
      : purpose === 'disable_otp'
        ? 'QRganize Security Confirmation'
        : 'QRganize Login Verification';
  const ignoreLine =
    purpose === 'password_change'
      ? 'If you did not attempt to change your password, you may ignore this email.'
      : purpose === 'disable_otp'
        ? 'If you did not attempt to turn off Two-Step Verification, you may ignore this email.'
        : 'If you did not attempt to sign in, you may ignore this email.';
  await transporter.sendMail({
    from: fromAddress(),
    to,
    subject,
    text:
      `Your QRganize verification code is:\n\n` +
      `${code}\n\n` +
      `This code expires in 5 minutes.\n\n` +
      `Do not share this code with anyone.\n\n` +
      ignoreLine,
    html:
      `<p>Your QRganize verification code is:</p>` +
      `<p style="font-size:28px;letter-spacing:6px;font-weight:700">${code}</p>` +
      `<p>This code expires in 5 minutes.</p>` +
      `<p>Do not share this code with anyone.</p>` +
      `<p>${ignoreLine}</p>`,
  });
}
