// src/mailsender.ts
// Shim, der die bisherigen MailerSend-Exports bereitstellt,
// intern aber den SMTP-Transport aus mailer.ts verwendet.

import { mailer, fromAddress, verifyMailer } from "./mailer";

export type SendOptions = {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  html: string;
};

// MailerSend-spezifisch – bei uns immer false.
export function isTrial422(_err: any): boolean {
  return false;
}

/**
 * Healthcheck: wir prüfen einfach, ob der SMTP-Transport bereit ist.
 * Liefert true, wenn verify() erfolgreich ist.
 */
export async function healthMailMS(): Promise<boolean> {
  try {
    await verifyMailer();
    return true;
  } catch {
    return false;
  }
}

/**
 * Ersatz für das frühere Senden via MailerSend-HTTP-API.
 * Sendet jetzt direkt per SMTP (nodemailer).
 */
export async function sendMailMS(opts: SendOptions): Promise<void> {
  const from =
    opts.fromName && opts.fromEmail
      ? `${opts.fromName} <${opts.fromEmail}>`
      : fromAddress();

  await mailer().sendMail({
    from,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });
}
