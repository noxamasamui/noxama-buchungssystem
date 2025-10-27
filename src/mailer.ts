// src/mailer.ts
import nodemailer, { Transporter } from "nodemailer";
import SMTPTransport from "nodemailer/lib/smtp-transport";

function bool(v: any, d = false) {
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
  const addr =
    process.env.MAIL_FROM_ADDRESS ||
    process.env.SMTP_USER ||
    "noreply@example.com";
  return `${name} <${addr}>`;
}

export function mailer(): Transporter<SMTPTransport.SentMessageInfo> {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = int(process.env.SMTP_PORT, 587);

  // Wenn nicht explizit gesetzt: 465 => secure (SMTPS), sonst STARTTLS
  const secure =
    process.env.SMTP_SECURE != null
      ? bool(process.env.SMTP_SECURE)
      : port === 465;

  const options: SMTPTransport.Options = {
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    // Bei 587 erzwingen wir TLS nach HELO
    requireTLS: !secure,

    // etwas großzügigere Timeouts
    connectionTimeout: int(process.env.SMTP_CONN_TIMEOUT_MS, 20000),
    greetingTimeout: int(process.env.SMTP_GREET_TIMEOUT_MS, 15000),
    socketTimeout: int(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000),

    // Falls dein Provider self-signed Zert hat (meist nicht nötig):
    // tls: { rejectUnauthorized: false },
  };

  return nodemailer.createTransport(options);
}

export async function verifyMailer() {
  const t = mailer();
  try {
    await t.verify();
    return true;
  } catch {
    return false;
  }
}
