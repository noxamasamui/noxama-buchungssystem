// src/mailer.ts
import nodemailer from "nodemailer";

const HOST = process.env.SMTP_HOST || "";
const PORT = Number(process.env.SMTP_PORT || 587);
const USER = process.env.SMTP_USER || "";
const PASS = process.env.SMTP_PASS || "";
const SECURE = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

export function fromAddress() {
  const brand = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
  const addr =
    process.env.MAIL_FROM_ADDRESS ||
    process.env.SMTP_USER ||
    "info@noxamasamui.com";
  return `"${brand}" <${addr}>`;
}

let _tx: nodemailer.Transporter | null = null;

export function mailer() {
  if (_tx) return _tx;
  _tx = nodemailer.createTransport({
    host: HOST,
    port: PORT,
    secure: SECURE,
    auth: USER && PASS ? { user: USER, pass: PASS } : undefined,
  });
  return _tx!;
}

export async function verifyMailer() {
  await mailer().verify();
}
