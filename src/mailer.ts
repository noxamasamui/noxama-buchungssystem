import nodemailer, { Transporter } from "nodemailer";

let _transporter: Transporter | null = null;

function env(name: string, fallback?: string) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing env ${name}`);
  }
  return v;
}

type Dial = {
  host: string;
  port: number;
  secure: boolean;
  requireTLS?: boolean;
};

function createTransport(d: Dial, user: string, pass: string): Transporter {
  return nodemailer.createTransport({
    host: d.host,
    port: d.port,
    secure: d.secure,            // 465 = true, 587 = false (mit STARTTLS)
    requireTLS: d.requireTLS,    // für 587 erzwingen wir TLS nach HELO
    auth: { user, pass },
    connectionTimeout: 15000,    // 15s
    greetingTimeout: 15000,
    socketTimeout: 20000,
    tls: {
      minVersion: "TLSv1.2",     // etwas strenger
      // rejectUnauthorized: false, // nur setzen, wenn wirklich nötig
    },
  });
}

async function verify(t: Transporter) {
  // verify() baut eine Verbindung auf und beendet sie wieder
  await t.verify();
}

async function buildTransportAuto(): Promise<Transporter> {
  const host = env("SMTP_HOST");
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");

  // 1) zuerst das, was in den ENVs steht
  const firstPort = Number(env("SMTP_PORT", "587"));
  const firstSecure = String(process.env.SMTP_SECURE || "false").toLowerCase() === "true";

  const attempts: Dial[] = [
    { host, port: firstPort, secure: firstSecure, requireTLS: !firstSecure },
    // Fallbacks in sinnvoller Reihenfolge
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
      const t = createTransport(d, user, pass);
      await verify(t);
      return t;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

export function mailer(): Transporter {
  if (!_transporter) {
    // lazy, aber synchrones Getter: wir erstellen async im Hintergrund
    // und werfen Fehler erst beim ersten sendMail/verify
    // (alternativ: server-start await buildTransportAuto())
    throw new Error(
      "Mailer not initialized. Call await verifyMailer() at startup once."
    );
  }
  return _transporter;
}

export async function verifyMailer(): Promise<void> {
  _transporter = await buildTransportAuto();
}

export function fromAddress(): string {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || env("SMTP_USER");
  return name ? `${name} <${addr}>` : addr;
}
