// src/mailer.ts
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

function buildTransport(): Transporter {
  const host = env("SMTP_HOST");
  const port = Number(env("SMTP_PORT", "465"));
  const secure = String(process.env.SMTP_SECURE || "true").toLowerCase() === "true";
  const user = env("SMTP_USER");
  const pass = env("SMTP_PASS");

  return nodemailer.createTransport({
    host,
    port,
    secure, // 465 = true, 587 = false (mit STARTTLS)
    auth: { user, pass },
  });
}

export function mailer(): Transporter {
  if (!_transporter) _transporter = buildTransport();
  return _transporter;
}

export async function verifyMailer(): Promise<void> {
  await mailer().verify();
}

export function fromAddress(): string {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || env("SMTP_USER");
  return name ? `${name} <${addr}>` : addr;
}
