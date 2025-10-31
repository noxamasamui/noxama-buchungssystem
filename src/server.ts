// src/server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { addHours, addMinutes } from "date-fns";
import { nanoid } from "nanoid";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

// ------------------------------------------------------
//  App, Prisma, Static
// ------------------------------------------------------
const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

// ------------------------------------------------------
//  Konfiguration
// ------------------------------------------------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_EMAIL =
  process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER || "info@noxamasamui.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";

// Sitzplatzlogik
const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48);
const MAX_SEATS_RESERVABLE = Number(
  process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40
);

// Max Gäste pro Online Buchung
const MAX_GUESTS_PER_BOOKING = Number(process.env.MAX_GUESTS_PER_BOOKING || 10);

// Öffnungszeiten
function hourFrom(v: string | undefined, fallback: number) {
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}
const OPEN_HOUR = hourFrom(process.env.OPEN_HOUR || "10", 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || "22", 22);
const SUNDAY_CLOSED = String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// ------------------------------------------------------
//  Hilfsfunktionen
// ------------------------------------------------------
function normalizeYmd(input: string): string {
  const s = String(input || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const [dd, mm, yy] = s.split(".").map(Number);
    return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [mm, dd, yy] = s.split("/").map(Number);
    return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime()))
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
  return "";
}

function isSundayYmd(ymd: string) {
  const { y, m, d } = splitYmd(ymd);
  return localDate(y, m, d).getDay() === 0;
}

async function overlapping(dateYmd: string, start: Date, end: Date) {
  return prisma.reservation.findMany({
    where: {
      date: dateYmd,
      status: { in: ["confirmed", "noshow"] },
      AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }],
    },
  });
}

async function sumsForInterval(dateYmd: string, start: Date, end: Date) {
  const list = await overlapping(dateYmd, start, end);
  const reserved = list.filter(r => !r.isWalkIn).reduce((s, r) => s + r.guests, 0);
  const walkins = list.filter(r => r.isWalkIn).reduce((s, r) => s + r.guests, 0);
  return { reserved, walkins, total: reserved + walkins };
}

async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok: false, reason: "Invalid time" };
  if (SUNDAY_CLOSED && isSundayYmd(norm)) return { ok: false, reason: "Sunday closed" };

  const start = localDateFrom(norm, timeHHmm);
  if (isNaN(start.getTime())) return { ok: false, reason: "Invalid time" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y, m, d } = splitYmd(norm);
  const open = localDate(y, m, d, OPEN_HOUR, 0, 0);
  const close = localDate(y, m, d, CLOSE_HOUR, 0, 0);
  if (start < open) return { ok: false, reason: "Before opening" };
  if (end > close) return { ok: false, reason: "After closing" };

  const blocked = await prisma.closure.findFirst({
    where: { AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }] },
  });
  if (blocked) return { ok: false, reason: "Blocked" };

  return { ok: true, start, end, minutes, norm };
}

// Loyalty Berechnung
function loyaltyForVisit(visitIndex: number) {
  // 5..9 -> 5%, 10..14 -> 10%, >=15 -> 15%
  if (visitIndex >= 15) return 15;
  if (visitIndex >= 10) return 10;
  if (visitIndex >= 5) return 5;
  return 0;
}

// ------------------------------------------------------
//  E-Mail-Funktion via SMTP (immer Strings übergeben!)
// ------------------------------------------------------
async function sendEmailSMTP(to: string, subject: string, html: string) {
  await mailer().sendMail({
    from: fromAddress(),
    to,
    subject,
    html,
  });
}

// ------------------------------------------------------
//  Seiten
// ------------------------------------------------------
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));

// ------------------------------------------------------
//  Health / Test-Mail
// ------------------------------------------------------
app.get("/__health/email", async (_req, res) => {
  try {
    await verifyMailer();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

app.get("/api/test-mail", async (req, res) => {
  try {
    const to = String(req.query.to || ADMIN_EMAIL || FROM_EMAIL);
    await sendEmailSMTP(to, `${BRAND_NAME} — Test`, "<p>SMTP ok.</p>");
    res.send("OK");
  } catch (e: any) {
    res.status(500).send("SMTP error: " + String(e?.message || e));
  }
});

// ------------------------------------------------------
//  Public Config (Kontakt)
// ------------------------------------------------------
app.get("/api/config", (_req, res) => {
  res.json({
    brand: BRAND_NAME,
    address: process.env.VENUE_ADDRESS || "",
    phone: process.env.VENUE_PHONE || "",
    email: process.env.VENUE_EMAIL || "",
  });
});

// ------------------------------------------------------
//  Slots
// ------------------------------------------------------
app.get("/api/slots", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  if (!date) return res.json([]);

  const times = generateSlots(date, OPEN_HOUR, CLOSE_HOUR);
  const out: any[] = [];

  for (const t of times) {
    const allow = await slotAllowed(date, t);
    if (!allow.ok) {
      out.push({
        time: t,
        allowed: false,
        reason: allow.reason,
        minutes: 0,
        canReserve: false,
        reserved: 0,
        walkins: 0,
        total: 0,
      });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const canReserve =
      sums.reserved < MAX_SEATS_RESERVABLE && sums.total < MAX_SEATS_TOTAL;
    out.push({
      time: t,
      allowed: true,
      reason: null,
      minutes: allow.minutes,
      canReserve,
      reserved: sums.reserved,
      walkins: sums.walkins,
      total: sums.total,
    });
  }
  res.json(out);
});

// ------------------------------------------------------
//  Reservationen
// ------------------------------------------------------
app.post("/api/reservations", async (req, res) => {
  try {
    const { date, time, firstName, name, email, phone, guests, notes } = req.body;

    if (Number(guests) > MAX_GUESTS_PER_BOOKING) {
      return res.status(400).json({
        error:
          "For groups larger than 10 guests, please contact us by phone or email.",
      });
    }

    const allow = await slotAllowed(String(date), String(time));
    if (!allow.ok) {
      // spezieller Text für Sonntag/Blockierung
      if (allow.reason === "Blocked") {
        return res
          .status(400)
          .json({ error: "We are fully booked on this date. Please choose another day." });
      }
      if (allow.reason === "Sunday closed") {
        return res
          .status(400)
          .json({ error: "We are closed on Sundays. Please select another day." });
      }
      return res.status(400).json({ error: "This time is not available." });
    }

    const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
    if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
      return res.status(400).json({
        error: "At this time all reservable seats are taken.",
      });
    if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
      return res.status(400).json({
        error: "We are full at this time.",
      });

    // bisherige bestätigte Besuche der Person (per E-Mail)
    const pastConfirmed = await prisma.reservation.count({
      where: {
        email: String(email || "").toLowerCase(),
        status: "confirmed",
      },
    });
    const visitIndex = pastConfirmed + 1;
    const rewardPercent = loyaltyForVisit(visitIndex);

    const token = nanoid();
    const created = await prisma.reservation.create({
      data: {
        date: allow.norm!,
        time: String(time),
        startTs: allow.start!,
        endTs: allow.end!,
        firstName: String(firstName || ""),
        name: String(name || ""),
        email: String(email || "").toLowerCase(),
        phone: String(phone || ""),
        guests: Number(guests || 0),
        notes: String(notes || ""),
        status: "confirmed",
        cancelToken: token,
        isWalkIn: false,
      },
    });

    const cancelUrl = `${BASE_URL}/cancel/${token}`;

    // Bestätigungs-Mail an Gast
    const guestHtml = confirmationHtml(
      String(created.firstName || ""),
      String(created.name || ""),
      String(created.date || ""),
      String(created.time || ""),
      Number(created.guests || 0),
      visitIndex,
      rewardPercent,
      cancelUrl
    );

    try {
      await sendEmailSMTP(String(created.email), `${BRAND_NAME} — Reservation`, guestHtml);
    } catch (e) {
      console.error("Mail error (guest):", e);
    }

    // Admin-Mail (neue Reservation)
    if (ADMIN_EMAIL) {
      const adminHtml = adminNewReservationHtml(
        {
          firstName: String(created.firstName || ""),
          name: String(created.name || ""),
          email: String(created.email || ""),
          phone: String(created.phone || ""),
          date: String(created.date || ""),
          time: String(created.time || ""),
          guests: Number(created.guests || 0),
          notes: String(created.notes || ""),
        },
        visitIndex,
        rewardPercent
      );
      try {
        await sendEmailSMTP(ADMIN_EMAIL, `New reservation — ${created.date} ${created.time}`, adminHtml);
      } catch (e) {
        console.error("Mail error (admin new):", e);
      }
    }

    res.json({ ok: true, reservation: created });
  } catch (e: any) {
    console.error("POST /api/reservations error:", e);
    res.status(500).json({ error: "Reservation failed" });
  }
});

// ------------------------------------------------------
//  Cancel
// ------------------------------------------------------
app.get("/cancel/:token", async (req, res) => {
  try {
    const r = await prisma.reservation.findUnique({
      where: { cancelToken: req.params.token },
    });
    if (!r) return res.status(404).send("Not found");

    await prisma.reservation.update({
      where: { id: r.id },
      data: { status: "canceled" },
    });

    // Gast: Cancel-Email
    try {
      const html = cancelGuestEmailHtml(
        String(r.firstName || ""),
        String(r.name || ""),
        Number(r.guests || 0),
        String(r.date || ""),
        String(r.time || "")
      );
      await sendEmailSMTP(String(r.email || ""), `We hope this goodbye is only for now`, html);
    } catch (e) {
      console.error("Mail error (guest cancel):", e);
    }

    // Admin: FYI
    if (ADMIN_EMAIL) {
      try {
        const adminHtml = adminCancelEmailHtml({
          firstName: String(r.firstName || ""),
          name: String(r.name || ""),
          email: String(r.email || ""),
          phone: String(r.phone || ""),
          guests: Number(r.guests || 0),
          date: String(r.date || ""),
          time: String(r.time || ""),
          notes: String(r.notes || ""),
          visits: await prisma.reservation.count({
            where: { email: String(r.email || "").toLowerCase(), status: "confirmed" },
          }),
        });
        await sendEmailSMTP(ADMIN_EMAIL, "Guest canceled reservation — FYI", adminHtml);
      } catch (e) {
        console.error("Mail error (admin cancel):", e);
      }
    }

    res.sendFile(path.join(publicDir, "cancelled.html"));
  } catch (e: any) {
    console.error("GET /cancel/:token error:", e);
    res.status(500).send("Cancel failed");
  }
});

// ------------------------------------------------------
//  Mail HTML
// ------------------------------------------------------

// Hinweis: KEINE nulls — alles Strings/Zahlen
function confirmationHtml(
  firstName: string,
  name: string,
  date: string,
  time: string,
  guests: number,
  visitIndex: number,
  rewardPercent: number,
  cancelUrl: string
) {
  const logo = process.env.MAIL_LOGO_URL || "/logo-email.png"; // 1200x400 Banner empfohlen
  const site = BRAND_NAME;

  // Teaser für nächste Stufe (4., 9., 14. Buchung)
  let teaser = "";
  if (visitIndex === 4) teaser = "One more visit and you unlock 5% off on your bill.";
  if (visitIndex === 9) teaser = "Your next visit unlocks 10% off.";
  if (visitIndex === 14) teaser = "From your next visit onward you will enjoy 15% off.";

  const loyaltyBlock =
    rewardPercent > 0
      ? `<div style="padding:14px 16px;border-radius:10px;background:#fff3e6;margin:16px 0;">
           <div style="font-size:18px;"><strong>Thank you for coming back!</strong></div>
           <div>Your loyalty means the world to us — please enjoy a <strong>${rewardPercent}% loyalty thank-you.</strong></div>
         </div>`
      : teaser
        ? `<div style="padding:14px 16px;border-radius:10px;background:#fff3e6;margin:16px 0;">
             <div>${teaser}</div>
           </div>`
        : "";

  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28; background:#fff8f0; padding:0; margin:0;">
    <div style="max-width:660px;margin:0 auto;">
      <img src="${logo}" alt="Logo" style="width:100%;height:auto;display:block;border:0" />
      <div style="background:#fff8f0;padding:24px 24px 32px;">
        <h2 style="margin:0 0 12px 0;">Your Reservation at ${site}</h2>
        <p style="margin:0 0 16px 0;">Hi ${firstName} ${name},</p>
        <p style="margin:0 0 18px 0;">Thank you for choosing <strong>${site}</strong>. We value loyalty deeply — regular guests are the heart of our little community.</p>

        <div style="background:#fff;border-radius:10px;padding:14px 16px;border:1px solid #eadac6;">
          <div><strong>Date</strong> ${date}</div>
          <div><strong>Time</strong> ${time}</div>
          <div><strong>Guests</strong> ${guests}</div>
        </div>

        <p style="margin:12px 0 0 0;">This is your <strong>${visitIndex}th</strong> visit.</p>

        ${loyaltyBlock}

        <div style="background:#fff3f3;border:1px solid #f5c2c2;border-radius:10px;padding:12px 14px;margin:16px 0;">
          <strong>Punctuality</strong><br/>
          Please arrive on time — tables may be released after <strong>15 minutes</strong> of delay.
        </div>

        <div style="margin:18px 0;">
          <a href="${cancelUrl}" style="display:inline-block;padding:10px 16px;background:#a6753b;color:#fff;text-decoration:none;border-radius:8px;">Cancel reservation</a>
        </div>
        <div style="font-size:12px;color:#6b5b51;">If the button does not work, copy this link:<br/>${cancelUrl}</div>

        <p style="margin:20px 0 0 0;">We can’t wait to welcome you!<br/><strong>Warm greetings from ${site}</strong></p>
      </div>
    </div>
  </div>`;
}

function adminNewReservationHtml(
  r: {
    firstName: string;
    name: string;
    email: string;
    phone: string;
    date: string;
    time: string;
    guests: number;
    notes: string;
  },
  visitIndex: number,
  rewardPercent: number
) {
  const logo = process.env.MAIL_LOGO_URL || "/logo-email.png";
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28; background:#fff8f0;">
    <div style="max-width:680px;margin:0 auto;">
      <img src="${logo}" alt="Logo" style="width:100%;height:auto;display:block;border:0" />
      <div style="background:#fff8f0;padding:18px 22px;">
        <h2 style="margin-top:0">New reservation ✅</h2>
        <div style="background:#fff;border:1px solid #eadac6;border-radius:10px;padding:12px 14px;">
          <div><strong>Guest</strong> ${r.firstName} ${r.name} (${r.email})</div>
          <div><strong>Phone</strong> ${r.phone}</div>
          <div><strong>Date</strong> ${r.date} — <strong>Time</strong> ${r.time}</div>
          <div><strong>Guests</strong> ${r.guests}</div>
          <div><strong>Notes</strong> ${r.notes || "-"}</div>
          <div><strong>Total past visits</strong> ${visitIndex - 1} — <strong>Discount</strong> ${rewardPercent}%</div>
        </div>
        <p style="margin:16px 0 0 0;"><strong>${BRAND_NAME}</strong></p>
      </div>
    </div>
  </div>`;
}

function cancelGuestEmailHtml(
  firstName: string,
  name: string,
  guests: number,
  date: string,
  time: string
) {
  const logo = process.env.MAIL_LOGO_URL || "/logo-email.png";
  const site = BRAND_NAME;
  const bookUrl = process.env.PUBLIC_BOOKING_URL || BASE_URL;

  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28; background:#fff8f0;">
    <div style="max-width:680px;margin:0 auto;">
      <img src="${logo}" alt="Logo" style="width:100%;height:auto;display:block;border:0" />
      <div style="background:#fff8f0;padding:20px 22px;">
        <h2 style="margin-top:0">We’ll miss you this round 😢</h2>
        <p>Hi ${firstName} ${name},</p>
        <p>Your reservation for <strong>${guests}</strong> on <strong>${date}</strong> at <strong>${time}</strong> has been canceled.</p>
        <p>We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
        <div style="margin:16px 0;">
          <a href="${bookUrl}" style="display:inline-block;padding:10px 16px;background:#a6753b;color:#fff;text-decoration:none;border-radius:8px;">Book your comeback</a>
        </div>
        <p style="margin:18px 0 0 0;">With warm regards,<br/><strong>${site}</strong></p>
      </div>
    </div>
  </div>`;
}

function adminCancelEmailHtml(r: {
  firstName: string;
  name: string;
  email: string;
  phone: string;
  guests: number;
  date: string;
  time: string;
  notes: string;
  visits: number;
}) {
  const logo = process.env.MAIL_LOGO_URL || "/logo-email.png";
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28; background:#fff8f0;">
    <div style="max-width:680px;margin:0 auto;">
      <img src="${logo}" alt="Logo" style="width:100%;height:auto;display:block;border:0" />
      <div style="background:#fff8f0;padding:18px 22px;">
        <h2 style="margin-top:0">Reservation canceled 😢</h2>
        <div style="background:#fff;border:1px solid #eadac6;border-radius:10px;padding:12px 14px;">
          <div><strong>Guest</strong> ${r.firstName} ${r.name} (${r.email})</div>
          <div><strong>Phone</strong> ${r.phone}</div>
          <div><strong>Date</strong> ${r.date} — <strong>Time</strong> ${r.time}</div>
          <div><strong>Guests</strong> ${r.guests}</div>
          <div><strong>Notes</strong> ${r.notes || "-"}</div>
          <div><strong>Total past visits</strong> ${r.visits}</div>
        </div>
        <p style="margin:16px 0 0 0;"><strong>${BRAND_NAME}</strong></p>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------
//  Reminder Job (24h vor Start)
// ------------------------------------------------------
async function sendReminders() {
  const now = new Date();
  const from = addHours(now, 24);
  const to = addHours(now, 25);
  const list = await prisma.reservation.findMany({
    where: {
      status: "confirmed",
      isWalkIn: false,
      reminderSent: false,
      startTs: { gte: from, lt: to },
    },
  });
  for (const r of list) {
    const cancelUrl = `${BASE_URL}/cancel/${r.cancelToken}`;
    const html = `
      <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28;">
        <p>Friendly reminder for your reservation tomorrow:</p>
        <p><b>Date</b> ${String(r.date)} — <b>Time</b> ${String(r.time)} — <b>Guests</b> ${Number(
      r.guests || 0
    )}</p>
        <p>If your plans change, please cancel here:<br/>
        <a href="${cancelUrl}">${cancelUrl}</a></p>
        <p>See you soon,<br/>${BRAND_NAME}</p>
      </div>`;
    try {
      await sendEmailSMTP(String(r.email || ""), "Reservation reminder", html);
      await prisma.reservation.update({
        where: { id: r.id },
        data: { reminderSent: true },
      });
    } catch (e) {
      console.error("Reminder mail error:", e);
    }
  }
}
setInterval(sendReminders, 30 * 60 * 1000);

// ------------------------------------------------------
//  Start
// ------------------------------------------------------
async function start() {
  await prisma.$connect();
  await verifyMailer(); // wichtig: vor dem ersten Mail-Versand
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on ${PORT}`);
  });
}

start().catch(err => {
  console.error("Fatal start error", err);
  process.exit(1);
});
