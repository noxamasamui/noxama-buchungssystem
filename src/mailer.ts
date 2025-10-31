// src/mailer.ts
import nodemailer from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

export function fromAddress() {
  const brand = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
  const email =
    process.env.MAIL_FROM_ADDRESS ||
    process.env.SMTP_USER ||
    "info@noxamasamui.com";
  return `"${brand}" <${email}>`;
}

let _transporter: nodemailer.Transporter | null = null;

export function mailer() {
  if (_transporter) return _transporter;
  _transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return _transporter;
}

export async function verifyMailer() {
  const tr = mailer();
  await tr.verify();
}
