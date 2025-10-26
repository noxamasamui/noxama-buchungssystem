// src/mailer.ts
import nodemailer, { Transporter } from "nodemailer";

function bool(v: any, d=false) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return d;
}

function int(v: any, d: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

export function fromAddress() {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER || "noreply@example.com";
  return `${name} <${addr}>`;
}

/**
 * Transport mit sauberen Defaults:
 * - Port 465 -> secure:true, requireTLS:false (SMTPS)
 * - Port 587 -> secure:false, requireTLS:true (STARTTLS)
 * - Timeouts, Pooling für Stabilität
 */
export function mailer(): Transporter {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = int(process.env.SMTP_PORT, 587);
  // Falls explizit gesetzt, nehmen; sonst automatisch vom Port ableiten
  const secure = process.env.SMTP_SECURE != null
    ? bool(process.env.SMTP_SECURE)
    : (port === 465);

  const useStartTLS = !secure; // STARTTLS nur bei Port 587 etc.

  return nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Für 587 erzwingen wir TLS nach HELO
    requireTLS: useStartTLS,
    // etwas großzügigere Timeouts gegen Verbindungsprobleme
    connectionTimeout: int(process.env.SMTP_CONN_TIMEOUT_MS, 20000),
    greetingTimeout: int(process.env.SMTP_GREET_TIMEOUT_MS, 15000),
    socketTimeout: int(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000),
    // Pool hilft gegen sporadische Verbindungsfehler
    pool: true,
    maxConnections: 1,
    maxMessages: 50,
  });
}

/** Health-Check: prüft Server/Logins, ohne eine echte Mail zu schicken */
export async function verifyMailer() {
  const t = mailer();
  try {
    await t.verify();
    return true;
  } finally {
    // nichts
  }
}
