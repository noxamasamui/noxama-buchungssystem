// src/mailer.ts
import nodemailer from "nodemailer";

// kleine Helfer
function b(v: any, d = false) {
  const s = String(v ?? "").trim().toLowerCase();
  if (["true","1","yes","on"].includes(s)) return true;
  if (["false","0","no","off"].includes(s)) return false;
  return d;
}
function n(v: any, d: number) {
  const x = Number(v);
  return Number.isFinite(x) ? x : d;
}
function fmtFrom(addr?: string, name?: string) {
  const a = (addr ?? "").trim();
  const nn = (name ?? "").trim();
  if (!a) return undefined;
  return nn ? `${nn} <${a}>` : a;
}
function fromDomain(from: string) {
  const m = from.match(/@([^>]+?)(?:>|$)/);
  return m?.[1]?.toLowerCase() || "example.com";
}

export function fromAddress() {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || "noreply@example.com";
  return fmtFrom(addr, name) || "noreply@example.com";
}

/** SMTP Transport nur als Fallback ausserhalb Render Free */
export function createSmtp(): nodemailer.Transporter {
  const host = process.env.SMTP_HOST || "smtp.mailersend.net";
  const port = n(process.env.SMTP_PORT, 587);
  const secure = process.env.SMTP_SECURE != null ? b(process.env.SMTP_SECURE) : port === 465;

  const opts: any = {
    host,
    port,
    secure,
    auth: process.env.SMTP_USER && process.env.SMTP_PASS
      ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
      : undefined,
    requireTLS: !secure,

    // Pool aktiv, darum KEINE smtp-transport Generics verwenden
    pool: b(process.env.SMTP_POOL, true),
    maxConnections: n(process.env.SMTP_MAX_CONNECTIONS, 3),
    maxMessages: n(process.env.SMTP_MAX_MESSAGES, 100),

    connectionTimeout: n(process.env.SMTP_CONN_TIMEOUT_MS, 20000),
    greetingTimeout: n(process.env.SMTP_GREET_TIMEOUT_MS, 15000),
    socketTimeout: n(process.env.SMTP_SOCKET_TIMEOUT_MS, 30000),
  };

  return nodemailer.createTransport(opts);
}

/** Rueckwaertskompatibel fuer server.ts */
export function mailer(): nodemailer.Transporter {
  return createSmtp();
}

export type SendEmailArgs = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
  cc?: string | string[];
  bcc?: string | string[];
  replyTo?: string;
  headers?: Record<string, string>;
  attachments?: any[];
  unsubscribeUrl?: string;
  idempotencyKey?: string;
  transactional?: boolean;
};

/** bevorzugt MailerSend HTTP API, faellt sonst auf SMTP */
export async function sendEmail(args: SendEmailArgs) {
  const from = fromAddress();
  const apiToken = process.env.MAILERSEND_API_TOKEN;

  const baseHeaders: Record<string, string> = {
    "X-Mailer": "NOXAMA-Mailer",
    ...(args.transactional ? { "Precedence": "bulk", "X-Transactional": "true" } : {}),
    ...(args.unsubscribeUrl ? { "List-Unsubscribe": `<${args.unsubscribeUrl}>` } : {}),
    ...(args.idempotencyKey ? { "X-Idempotency-Key": args.idempotencyKey } : {}),
    ...(args.headers || {}),
  };

  if (apiToken) {
    const messageId = args.idempotencyKey
      ? `${args.idempotencyKey}@${fromDomain(from)}`
      : undefined;

    const body: any = {
      from: { email: from.replace(/^.*<|>$/g, ""), name: (process.env.MAIL_FROM_NAME || "").trim() || undefined },
      to: (Array.isArray(args.to) ? args.to : [args.to]).map(e => ({ email: e })),
      subject: args.subject,
      html: args.html,
      text: args.text,
      cc: args.cc ? (Array.isArray(args.cc) ? args.cc : [args.cc]).map(e => ({ email: e })) : undefined,
      bcc: args.bcc ? (Array.isArray(args.bcc) ? args.bcc : [args.bcc]).map(e => ({ email: e })) :
           process.env.MAIL_ARCHIVE_BCC ? [{ email: process.env.MAIL_ARCHIVE_BCC }] : undefined,
      reply_to: args.replyTo ? { email: args.replyTo } : undefined,
      headers: baseHeaders,
      message_id: messageId,
    };

    const res = await fetch("https://api.mailersend.com/v1/email", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`MailerSend API Error ${res.status}: ${text}`);
    }

    const data = await res.json().catch(() => ({}));
    return { api: "mailersend", data };
  }

  const t = createSmtp();
  const info = await t.sendMail({
    from,
    to: args.to,
    cc: args.cc,
    bcc: args.bcc ?? process.env.MAIL_ARCHIVE_BCC,
    subject: args.subject,
    html: args.html,
    text: args.text,
    replyTo: args.replyTo,
    headers: baseHeaders,
    messageId: args.idempotencyKey ? `${args.idempotencyKey}@${fromDomain(from)}` : undefined,
    attachments: args.attachments,
  });
  return { api: "smtp", info };
}

export async function verifyMailer() {
  if (process.env.MAILERSEND_API_TOKEN) {
    return { ok: true as const, api: "mailersend" };
  }
  try {
    const t = createSmtp();
    await t.verify();
    return { ok: true as const, api: "smtp" };
  } catch (err: any) {
    return { ok: false as const, api: "smtp", error: { code: err?.code, message: err?.message } };
  }
}

