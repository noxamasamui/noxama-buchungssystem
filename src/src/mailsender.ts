// SMTP-basierter Ersatz für das frühere MailerSend-API.

import { mailer, fromAddress, verifyMailer } from "./mailer";

export type SendOptions = {
  fromName?: string;
  fromEmail?: string;
  to: string;
  subject: string;
  html: string;
};

// Kompatibilitäts-Helper – immer false.
export function isTrial422(_err: unknown): boolean {
  return false;
}

// Healthcheck: prüft den Transport
export async function healthMailMS(): Promise<boolean> {
  try {
    await verifyMailer();
    return true;
  } catch {
    return false;
  }
}

// Senden per Nodemailer (SMTP)
export async function sendMailMS(opts: SendOptions): Promise<void> {
  const from =
    opts.fromName && opts.fromEmail
      ? `"${opts.fromName}" <${opts.fromEmail}>`
      : fromAddress; // <- fromAddress ist eine Zeichenkette, kein Aufruf!

  await mailer.sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });
}
