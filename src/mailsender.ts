// src/mailsender.ts
// SMTP-Transport (Nodemailer) – einfache Wrapper-Funktionen.
// Erwartete ENV-Variablen:
// SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM
//
// Empfohlen:
// MAIL_FROM=RÖSTILAND BY NOXAMA SAMUI <info@noxamasamui.com>

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

function htmlToText(html: string): string {
  return String(html || "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<\/h[1-6]>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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

export async function sendMail(
  to: string,
  subject: string,
  html: string
): Promise<void> {
  const text = htmlToText(html);

  await ensureTransporter().sendMail({
    from: fromAddress(),
    to,
    subject,
    text,
    html,
  });
}
