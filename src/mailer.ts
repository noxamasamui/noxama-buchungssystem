import nodemailer from "nodemailer";

const FROM_NAME = process.env.MAIL_FROM_NAME || process.env.BRAND_NAME || "Restaurant";
const FROM_ADDR = process.env.MAIL_FROM_ADDRESS || process.env.VENUE_EMAIL || "noreply@example.com";

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
  pool: String(process.env.MAIL_POOL || "false").toLowerCase() === "true",
});

export async function sendMail(to: string, subject: string, html: string) {
  await transporter.sendMail({ from: `"${FROM_NAME}" <${FROM_ADDR}>`, to, subject, html });
}

export async function verifyMailer() {
  try { await transporter.verify(); } catch { /* ignore in prod */ }
}
