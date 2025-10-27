// src/mailer.ts
type SendArgs = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  idempotencyKey?: string;
};

export function fromAddress() {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr = process.env.MAIL_FROM_ADDRESS || "noreply@noxamasamui.com";
  return `${name} <${addr}>`;
}

function need(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return String(v);
}

export async function verifyMailer(): Promise<boolean> {
  return !!process.env.MAILERSEND_API_TOKEN;
}

export async function sendEmail(a: SendArgs): Promise<void> {
  const token = need("MAILERSEND_API_TOKEN");
  const fromEmail = (process.env.MAIL_FROM_ADDRESS || "noreply@noxamasamui.com").trim();
  const fromName  = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";

  const body = {
    from: { email: fromEmail, name: fromName },
    to: [{ email: a.to }],
    subject: a.subject,
    html: a.html,
    text: a.text,
  };

  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(a.idempotencyKey ? { "Idempotency-Key": a.idempotencyKey } : {})
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`MailerSend error ${res.status}: ${txt}`);
  }
}
