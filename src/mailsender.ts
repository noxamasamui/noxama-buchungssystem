// src/mailsender.ts
// SMTP-Transport (Nodemailer) – einfache Wrapper-Funktionen.
// Erwartete ENV-Variablen:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM

import nodemailer from "nodemailer";

let _transporter: nodemailer.Transporter | null = null;

function ensureTransporter(): nodemailer.Transporter {
  if (_transporter) return _transporter;

  const host = process.env.SMTP_HOST || "";
  const port = Number(process.env.SMTP_PORT || 587);
  const user = process.env.SMTP_USER || "";
  const pass = process.env.SMTP_PASS || "";

  _transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: user ? { user, pass } : undefined,
  });

  return _transporter;
}

export function mailer(): nodemailer.Transporter {
  return ensureTransporter();
}

export function fromAddress(): string {
  return process.env.MAIL_FROM || "noreply@noxama.local";
}

export async function verifyMailer(): Promise<void> {
  await ensureTransporter().verify();
}
