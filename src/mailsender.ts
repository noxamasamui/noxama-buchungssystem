// src/mailsender.ts
import nodemailer, { type Transporter } from "nodemailer";

/** SMTP Konfiguration aus ENV */
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";

const FROM_EMAIL = process.env.FROM_EMAIL || SMTP_USER || "no-reply@noxama.local";
const FROM_NAME  = process.env.FROM_NAME  || "RÖSTILAND BY NOXAMA SAMUI";

/** Lazy-Singleton Transporter */
let _tx: Transporter | null = null;

function createTransport(): Transporter {
  if (_tx) return _tx;
  _tx = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465, // 465 = TLS, sonst STARTTLS
    auth: SMTP_USER && SMTP_PASS ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
  });
  return _tx;
}

/** Öffentliche API — GENAU diese beiden werden vom Server genutzt */
export function mailer(): Transporter {
  return createTransport();
}

export function fromAddress(): string {
  return `${FROM_NAME} <${FROM_EMAIL}>`;
}

/** Optionaler Health-Check */
export async function verifyMailer(): Promise<void> {
  await createTransport().verify();
}
