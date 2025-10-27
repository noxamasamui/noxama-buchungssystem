// MailerSend – sehr kleine Wrapper-Funktionen für das Senden per HTTP API.
// Keine zusätzlichen Packages nötig (Node 20 hat fetch eingebaut).

type Json = Record<string, any>;

export type SendOptions = {
  fromName: string;
  fromEmail: string;
  to: string;
  subject: string;
  html: string;
};

const API_TOKEN = process.env.MAILERSEND_API_TOKEN || "";

/**
 * Prüft, ob der Fehler vom Trial-Limit kommt (#MS42225).
 */
export function isTrial422(err: any): boolean {
  try {
    const status = err?.status;
    const msg: string =
      typeof err?.body === "string"
        ? err.body
        : JSON.stringify(err?.body || {});
    return status === 422 && /Trial accounts can only send emails/i.test(msg);
  } catch {
    return false;
  }
}

/**
 * Einfache Health-Prüfung: Token vorhanden und eine HEAD-Anfrage gegen die API.
 * (MailerSend hat kein echtes "ping"-Endpoint – das reicht für unser Healthcheck.)
 */
export async function healthMailMS(): Promise<boolean> {
  if (!API_TOKEN) return false;
  try {
    const r = await fetch("https://api.mailersend.com/v1/email", {
      method: "HEAD",
      headers: { Authorization: `Bearer ${API_TOKEN}` },
    } as any);
    // 200/204/405 sind ok für HEAD hier – wichtig ist: kein 401/403
    return r.status < 400 || r.status === 405;
  } catch {
    return false;
  }
}

/**
 * Sendet eine E-Mail über die MailerSend API.
 * Wirf bei Status ≠ 202 einen Fehler mit {status, body}.
 */
export async function sendMailMS(opts: SendOptions): Promise<void> {
  if (!API_TOKEN) {
    throw new Error("MAILERSEND_API_TOKEN is missing");
  }

  const payload: Json = {
    from: { email: opts.fromEmail, name: opts.fromName },
    to: [{ email: opts.to }],
    subject: opts.subject,
    html: opts.html,
  };

  const resp = await fetch("https://api.mailersend.com/v1/email", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  } as any);

  if (resp.status === 202) return;

  let body: any = "";
  try {
    body = await resp.json();
  } catch {
    try { body = await resp.text(); } catch { /* ignore */ }
  }

  const err: any = new Error(`MailerSend HTTP ${resp.status}`);
  err.status = resp.status;
  err.body = body;
  throw err;
}
