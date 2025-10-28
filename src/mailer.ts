// src/mailer.ts
import nodemailer, { Transporter } from "nodemailer";

/* ----------------------------- env helpers ------------------------------ */

function getEnv(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

function getBool(name: string, fallback = false): boolean {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return fallback;
  return String(v).toLowerCase() === "true" || v === "1" || v === "yes";
}

function getInt(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v === undefined ? NaN : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/* ---------------------------- transporter ------------------------------- */

let _transporter: Transporter | null = null;

function buildTransport(): Transporter {
  // Pflichtwerte
  const host = getEnv("SMTP_HOST");                         // z. B. mail.webador.com
  const port = getInt("SMTP_PORT", 465);                    // 465=SMTPS (secure), 587=STARTTLS
  const user = getEnv("SMTP_USER");                         // info@noxamasamui.com
  const pass = getEnv("SMTP_PASS");                         // Mailbox-Passwort

  // Ableitung/Optionen
  const secure =
    process.env.SMTP_SECURE !== undefined
      ? getBool("SMTP_SECURE", true)
      : port === 465;                                       // 465 -> secure true, sonst false

  const usePool = getBool("MAIL_POOL", true);               // Pooling reduziert Verbindungsaufbau
  const maxConnections = getInt("MAIL_POOL_CONN", 3);
  const maxMessages    = getInt("MAIL_POOL_MSG", 100);

  // TLS-Optionen – standardmäßig sicher; bei exotischen Hosts kann man lockern
  const tlsRejectUnauthorized = getBool("SMTP_TLS_REJECT_UNAUTHORIZED", true);
  const ignoreTLS = getBool("SMTP_IGNORE_TLS", false);      // nur sinnvoll bei Port 587, selten nötig

  // Optionales DKIM (nur setzen, wenn alle 3 Werte da sind)
  const dkimDomain   = process.env.DKIM_DOMAIN;
  const dkimSelector = process.env.DKIM_SELECTOR;
  const dkimKey      = process.env.DKIM_PRIVATE_KEY;

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    pool: usePool,
    maxConnections,
    maxMessages,
    // Timeouts (ms)
    connectionTimeout: getInt("SMTP_CONNECTION_TIMEOUT", 20_000),
    greetingTimeout:   getInt("SMTP_GREETING_TIMEOUT",   20_000),
    socketTimeout:     getInt("SMTP_SOCKET_TIMEOUT",     30_000),
    // TLS
    ignoreTLS,
    tls: { rejectUnauthorized: tlsRejectUnauthorized },
    // Nodemailer setzt UTF-8/8BIT automatisch; nichts weiter nötig
  } as any);

  if (dkimDomain && dkimSelector && dkimKey) {
    // @ts-ignore – Typen in nodemailer erlauben dkim optional
    transporter.options.dkim = {
      domainName: dkimDomain,
      keySelector: dkimSelector,
      privateKey: dkimKey,
    };
  }

  return transporter;
}

/* ------------------------------ exports -------------------------------- */

export function mailer(): Transporter {
  if (!_transporter) _transporter = buildTransport();
  return _transporter;
}

export async function verifyMailer(): Promise<void> {
  try {
    await mailer().verify();
  } catch (err: any) {
    // Mehr Kontext für Logs
    const host = process.env.SMTP_HOST ?? "<unset>";
    const port = process.env.SMTP_PORT ?? "<unset>";
    const user = process.env.SMTP_USER ?? "<unset>";
    throw new Error(
      `SMTP verify failed (${host}:${port}, user=${user}): ${err?.message || err}`
    );
  }
}

export function fromAddress(): string {
  const name = process.env.MAIL_FROM_NAME || "RÖSTILAND BY NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || getEnv("SMTP_USER");
  return name ? `${name} <${addr}>` : addr;
}

/**
 * Komfortfunktion: eine Mail versenden.
 * (Optional – falls du direkt mailer().sendMail(...) nutzt, kannst du das weglassen.)
 */
export async function sendMail(opts: {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
}) {
  const info = await mailer().sendMail({
    from: fromAddress(),
    ...opts,
  });
  return info.messageId;
}
