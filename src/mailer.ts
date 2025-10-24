import nodemailer from "nodemailer";

export function mailer() {
  const host = process.env.SMTP_HOST || "smtp.gmail.com";
  const port = Number(process.env.SMTP_PORT || 465);
  const user = process.env.SMTP_USER!;
  const pass = process.env.SMTP_PASS!;
  const secure = port === 465;           // 465 = SSL, 587 = STARTTLS

  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass }
  });
}

export function fromAddress() {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER || "";
  return `${name} <${addr}>`;            // muss = SMTP_USER sein
}

export async function verifyMailer() {
  const tr = mailer();
  await tr.verify();
  return true;
}
