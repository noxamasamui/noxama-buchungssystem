// src/email.ts
// Rendert die Bestätigungsmail inkl. Buchungszähler & Loyalty-Botschaft.

export type BrandConfig = {
  brandName: string;
  baseUrl: string;
  cancelUrl: string;                 // z. B. `${BASE_URL}/cancelled.html`
  mailHeaderUrl?: string | null;
  mailLogoUrl?: string | null;
  venueAddress: string;
};

export type ReservationView = {
  id: string;
  date: string;     // yyyy-mm-dd
  time: string;     // HH:mm
  guests: number;
  firstName: string;
  lastName: string;
  email: string;
  phone?: string | null;
  cancelToken: string;
};

export type LoyaltyInfo = {
  countBefore: number;  // wie oft der Gast VOR dieser Reservierung bereits gebucht hat (Bestätigte)
  tierNow: 0 | 5 | 10 | 15;   // aktiver Rabatt ab dieser Buchung
  nextHint?: string;   // freundlicher Ausblick (z. B. “ab der 5. Buchung 5 % …”)
};

function loyaltyBlock(li: LoyaltyInfo): string {
  const lines: string[] = [];

  // 1) Buchungszähler
  const ordinal = li.countBefore + 1;
  lines.push(
    `<p style="margin:0 0 10px 0">This is your <strong>${ordinal}${ordinal === 1 ? "st" : ordinal === 2 ? "nd" : ordinal === 3 ? "rd" : "th"}</strong> reservation with us. Thank you for your loyalty!</p>`
  );

  // 2) Aktueller Vorteil
  if (li.tierNow > 0) {
    lines.push(
      `<p style="margin:0 0 6px 0">You now enjoy a <strong>${li.tierNow}% Loyalty Discount</strong> for this and all future visits.</p>`
    );
  }

  // 3) Ausblick
  if (li.nextHint) {
    lines.push(`<p style="margin:0">${li.nextHint}</p>`);
  }

  return lines.join("\n");
}

export function renderReservationEmail(
  brand: BrandConfig,
  r: ReservationView,
  loyalty: LoyaltyInfo
): { subject: string; html: string } {
  const headerImg = brand.mailHeaderUrl || brand.mailLogoUrl || "";
  const cancelHref = `${brand.baseUrl}/cancel?token=${encodeURIComponent(r.cancelToken)}`;

  const subject = `${brand.brandName} — Reservation #${r.id}`;

  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${subject}</title>
  </head>
  <body style="margin:0;padding:0;background:#efe7dc;">
    <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
      <tr><td align="center" style="padding:20px">
        <table cellpadding="0" cellspacing="0" width="100%" style="max-width:680px;background:#fff;border-radius:14px;overflow:hidden;font-family:Georgia,Times,serif;color:#3a2f28">
          <tr>
            <td style="padding:0">
              ${
                headerImg
                  ? `<img src="${headerImg}" alt="${brand.brandName}" style="width:100%;display:block"/>`
                  : ""
              }
            </td>
          </tr>
          <tr><td style="padding:22px">
            <h1 style="margin:0 0 12px 0;font-size:26px;line-height:1.25">Your Reservation at <span style="white-space:nowrap">${brand.brandName}</span></h1>
            <p style="margin:0 0 18px 0">Hi ${r.firstName} ${r.lastName},</p>
            <p style="margin:0 0 16px 0">Thank you for your reservation. We look forward to welcoming you.</p>

            <div style="border-radius:12px;background:#fbf7f1;border:1px solid #e8dccc;padding:14px 16px;margin:0 0 16px 0">
              <div style="margin:0 0 8px 0"><strong>Date</strong> ${r.date}</div>
              <div style="margin:0 0 8px 0"><strong>Time</strong> ${r.time}</div>
              <div style="margin:0 0 8px 0"><strong>Guests</strong> ${r.guests}</div>
              <div><strong>Address</strong> ${brand.venueAddress}</div>
            </div>

            <div style="border-radius:12px;background:#fff7f4;border:1px solid #f0d9d1;padding:12px 14px;margin:0 0 16px 0">
              ${loyaltyBlock(loyalty)}
            </div>

            <div style="text-align:center;margin:24px 0">
              <a href="${cancelHref}"
                 style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;font-weight:700;padding:12px 16px;border-radius:10px">
                Cancel reservation
              </a>
            </div>

            <p style="margin:8px 0 0 0">Warm regards from <strong>${brand.brandName}</strong></p>
          </td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;

  return { subject, html };
}

// Hilfsfunktion: Loyalty-Tiers berechnen
export function calcLoyalty(countBefore: number): LoyaltyInfo {
  // Schwellen: 5% ab 5., 10% ab 10., 15% ab 15. (und dann dauerhaft)
  let tier: 0 | 5 | 10 | 15 = 0;
  if (countBefore + 1 >= 15) tier = 15;
  else if (countBefore + 1 >= 10) tier = 10;
  else if (countBefore + 1 >= 5) tier = 5;

  let nextHint: string | undefined;
  if (countBefore + 1 === 4) {
    nextHint = "From your 5th reservation you will receive a 5% Loyalty Discount.";
  } else if (countBefore + 1 === 9) {
    nextHint = "From your 10th reservation you will receive a 10% Loyalty Discount.";
  } else if (countBefore + 1 === 14) {
    nextHint = "From your 15th reservation you will receive a 15% Loyalty Discount.";
  }

  return { countBefore, tierNow: tier, nextHint };
}
