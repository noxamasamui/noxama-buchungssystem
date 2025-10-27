// src/mailer.ts
import nodemailer, { Transporter } from "nodemailer";

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
  const name =
    process.env.MAIL_FROM_NAME?.trim() || "NOXAMA SAMUI";
  // bevorzugt eigene Absender-Adresse, fallback SMTP_USER
  const addr =
    process.env.MAIL_FROM_ADDRESS?.trim() ||
    process.env.SMTP_USER?.trim() ||
    "noreply@example.com";
  return `"${name}" <${addr}>`;
}

/**
 * Transport mit robusten Defaults:
 * - Port 465  -> secure:true (SMTPS)
 * - Port 587  -> secure:false + requireTLS:true (STARTTLS)
 * - IPv4 erzwingen (family: 4) gegen IPv6-Timeouts
 * - Timeouts & optionale Pool-Einstellungen
 * - Debug/Logger via MAIL_DEBUG
 */
export function mailer(): Transporter {
  const host = process.env.SMTP_HOST?.trim() || "smtp.gmail.com";
  const port = int(process.env.SMTP_PORT, 587);

  // Wenn SMTP_SECURE gesetzt ist, nehmen wir das; sonst nach Port ableiten
  const secure =
    process.env.SMTP_SECURE != null
      ? bool(process.env.SMTP_SECURE)
      : port === 465;

  // STARTTLS nur, wenn nicht secure (typisch 587)
  const requireTLS = !secure;

  const pool = bool(process.env.MAIL_POOL, false);
  const debug = bool(process.env.MAIL_DEBUG, false);

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },

    // STARTTLS-Modus für 587
    requireTLS,

    // *** WICHTIG GEGEN TIMEOUTS ***
    family: 4, // zwingt IPv4, verhindert IPv6-Hänger

    // Timeouts (ms)
    connectionTimeout: int(process.env.SMTP_CONN_TIMEOUT_MS, 15000),
    greetingTimeout: int(process.env.SMTP_GREET_TIMEOUT_MS, 10000),
    socketTimeout: int(process.env.SMTP_SOCKET_TIMEOUT_MS, 20000),

    // Pool optional (bei Free-Instanzen oft stabiler ohne Pool)
    pool,
    maxConnections: int(process.env.MAIL_MAX_CONN, 1),
    maxMessages: int(process.env.MAIL_MAX_MSG, 50),

    // TLS-Details
    tls: {
      rejectUnauthorized: true,
      minVersion: "TLSv1.2",
      servername: host,
    },

    // Debug/Logger
    logger: debug,
    debug,
  });

  return transporter;
}

/** Health-Check (keine echte Mail) */
export async function verifyMailer(): Promise<boolean> {
  const t = mailer();
  try {
    await t.verify();
    return true;
  } catch {
    return false;
  } finally {
    // nichts
  }
}
