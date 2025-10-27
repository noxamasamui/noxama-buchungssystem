// src/mailer.ts
type SendArgs = {
  to: string;
  subject: string;
  html?: string;
  text?: string;
  transactional?: boolean;
  idempotencyKey?: string;
};

function bool(v: any, d = false) {
  const s = String(v ?? "").trim().toLowerCase();
  if (s === "true") return true;
  if (s === "false") return false;
  return d;
}

export function fromAddress() {
  const name = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";
  const addr =
    process.env.MAIL_FROM_ADDRESS ||
    "noreply@noxamasamui.com";
  return `${name} <${addr}>`;
}

function envStr(name: string, req = true) {
  const v = process.env[name];
  if (!v && req) throw new Error(`Missing env ${name}`);
  return String(v || "");
}

export async function verifyMailer(): Promise<boolean> {
  // minimal Token-Check (optional: leichte API-Abfrage)
  return !!process.env.MAILERSEND_API_TOKEN;
}

export async function sendEmail(args: SendArgs): Promise<void> {
  const token = envStr("MAILERSEND_API_TOKEN");
  const fromEmail =
    (process.env.MAIL_FROM_ADDRESS || "noreply@noxamasamui.com").trim();
  const fromName = process.env.MAIL_FROM_NAME || "NOXAMA SAMUI";

  const body = {
    from: { email: fromEmail, name: fromName },
    to: [{ email: args.to }],
    subject: args.subject,
    html: args.html || undefined,
    text: args.text || undefined,
  };

  const res = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(args.idempotencyKey ? { "Idempotency-Key": args.idempotencyKey } : {})
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`MailerSend error ${res.status}: ${txt}`);
  }
}
