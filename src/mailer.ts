import nodemailer from "nodemailer";
import SMTPTransport from "nodemailer/lib/smtp-transport";

const FROM_NAME = process.env.MAIL_FROM_NAME || process.env.BRAND_NAME || "Restaurant";
export const fromAddress =
  process.env.MAIL_FROM_ADDRESS || process.env.VENUE_EMAIL || "noreply@example.com";

// Wichtig: explizit als SMTPTransport.Options typisieren
const transportOptions: SMTPTransport.Options = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
  auth: process.env.SMTP_USER && process.env.SMTP_PASS ? {
    user: process.env.SMTP_USER!,
    pass: process.env.SMTP_PASS!,
  } : undefined,
  pool: String(process.env.MAIL_POOL || "false").toLowerCase() === "true",
};

export const mailer = nodemailer.createTransport(transportOptions);

export async function sendMail(to: string, subject: string, html: string) {
  await mailer.sendMail({ from: `"${FROM_NAME}" <${fromAddress}>`, to, subject, html });
}

export async function verifyMailer() {
  try { await mailer.verify(); } catch { /* ignore */ }
}
