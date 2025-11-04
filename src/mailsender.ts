// src/mailer.ts
import nodemailer, { Transporter } from "nodemailer";

const SMTP_HOST = process.env.SMTP_HOST || process.env.MAIL_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || process.env.MAIL_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || process.env.MAIL_PASS || "";
const SMTP_SECURE = String(process.env.SMTP_SECURE || "").toLowerCase() === "true";

const FROM_EMAIL = process.env.FROM_EMAIL || process.env.VENUE_EMAIL || "no-reply@noxama.local";
const FROM_NAME  = process.env.FROM_NAME  || process.env.BRAND_NAME  || "RÖSTILAND BY NOXAMA SAMUI";

// Singleton Transporter
let transporter: Transporter | null = null;

function createTransport(): Transporter {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP config missing: set SMTP_HOST/SMTP_USER/SMTP_PASS");
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE, // true=465, false=587/25
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

export function mailer(): Transporter {
  if (!transporter) transporter = createTransport();
  return transporter;
}

export function fromAddress(): string {
  return `${FROM_NAME} <${FROM_EMAIL}>`;
}

export async function verifyMailer(): Promise<void> {
  try {
    await mailer().verify();
  } catch (err) {
    // ins Log, aber Build nicht abbrechen
    console.warn("SMTP verify failed:", (err as Error).message);
  }
}
