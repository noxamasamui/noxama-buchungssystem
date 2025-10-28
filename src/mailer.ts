// src/mailer.ts
import nodemailer, { type Transporter } from "nodemailer";

let transporterRef: Transporter | null = null;
let initPromise: Promise<Transporter> | null = null;

function env(name: string, fallback?: string): string {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

type Dial = { host: string; port: number; secure: boolean; requireTLS?: boolean };

function createTransport(d: Dial): Transporter {
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");
  const debug = String(process.env.MAIL_DEBUG || "0") === "1";

  return nodemailer.createTransport({
    name: process.env.SMTP_EHLO_NAME || undefined, // optional, z.B. deine Domain
    host: d.host,
    port: d.port,
    secure: d.secure,           // 465 true, 587 false (STARTTLS)
    requireTLS: d.requireTLS,   // fuer 587 erzwingen
    auth: { user, pass },       // Webador: volle Mailadresse + Mailbox Passwort
    authMethod: process.env.SMTP_AUTH_METHOD || undefined, // optional: "PLAIN"
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: {
      minVersion: "TLSv1.2",
      // rejectUnauthorized: false, // nur temporaer, wenn Provider ein kaputtes Zert hat
    },
    logger: debug,
    debug,
  });
}

async function buildTransportAuto(): Promise<Transporter> {
  const host = env("SMTP_HOST", "mail.webador.com");
  // erste Wahl: was in ENV steht
  const firstPort = Number(env("SMTP_PORT", "587"));
  const firstSecure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

  const attempts: Dial[] = [
    { host, port: firstPort, secure: firstSecure, requireTLS: !firstSecure },
    // solide Fallbacks in der Praxis
    { host, port: 587, secure: false, requireTLS: true }, // STARTTLS
    { host, port: 465, secure: true },                    // SMTPS
  ];

  let lastErr: any;
  const tried = new Set<string>();

  for (const d of attempts) {
    const key = `${d.host}:${d.port}/${d.secure ? "ssl" : "starttls"}`;
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      const t = createTransport(d);
      await t.verify();          // baut Verbindung auf und beendet sie
      return t;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

async function initOnce(): Promise<Transporter> {
  if (transporterRef) return transporterRef;
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const t = await buildTransportAuto();
    transporterRef = t;
    return t;
  })();
  return initPromise;
}

export async function verifyMailer(): Promise<void> {
  await initOnce();
}

export function mailer(): Transporter {
  if (!transporterRef) {
    throw new Error("Mailer not initialized. Call await verifyMailer() once during startup.");
  }
  return transporterRef;
}

export function fromAddress(): string {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || env("SMTP_USER");
  return name ? `${name} <${addr}>` : addr;
}
