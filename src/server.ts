// src/server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { addHours, addMinutes } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

// ------------------------------------------------------
// App, Prisma, Static
// ------------------------------------------------------
const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

// ------------------------------------------------------
// Konfiguration
// ------------------------------------------------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_EMAIL =
  process.env.MAIL_FROM_ADDRESS ||
  process.env.SMTP_USER ||
  "info@noxamasamui.com";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";

// Sitzplatzlogik
const MAX_SEATS_TOTAL = Number(
  process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48
);
const MAX_SEATS_RESERVABLE = Number(
  process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40
);

// Gäste-Limit online
const MAX_GUESTS_ONLINE = 10;

// Öffnungszeiten
function hourFrom(v: string | undefined, fallback: number) {
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}
const OPEN_HOUR = hourFrom(process.env.OPEN_HOUR || "10", 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || "22", 22);
const SUNDAY_CLOSED =
  String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// ------------------------------------------------------
// Hilfsfunktionen
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;
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
  const reserved = list
    .filter((r) => !r.isWalkIn)
    .reduce((s, r) => s + r.guests, 0);
  const walkins = list
    .filter((r) => r.isWalkIn)
    .reduce((s, r) => s + r.guests, 0);
  return { reserved, walkins, total: reserved + walkins };
}

async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok: false, reason: "Invalid time" };
  if (SUNDAY_CLOSED && isSundayYmd(norm))
    return { ok: false, reason: "Sunday closed" };

  const start = localDateFrom(norm, timeHHmm);
  if (isNaN(start.getTime())) return { ok: false, reason: "Invalid time" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y, m, d } = splitYmd(norm);
  const open = localDate(y, m, d, OPEN_HOUR, 0, 0);
  const close = localDate(y, m, d, CLOSE_HOUR, 0, 0);
  if (start < open) return { ok: false, reason: "Before opening hours" };
  if (end > close) return { ok: false, reason: "After closing hours" };

  const blocked = await prisma.closure.findFirst({
    where: { AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }] },
  });
  if (blocked) return { ok: false, reason: "Blocked" };

  return { ok: true, start, end, minutes, norm };
}

function loyaltyForVisit(n: number) {
  // n = Anzahl vergangener Besuche (ohne aktuelle)
  // Belohnung für 5–9 -> 5%, 10–14 -> 10%, ab 15 -> 15%
  let percent = 0;
  if (n >= 4 && n <= 8) percent = 5; // bei 5. bis 9. Buchung
  if (n >= 9 && n <= 13) percent = 10; // 10. bis 14.
  if (n >= 14) percent = 15; // ab 15.
  return percent;
}

// ------------------------------------------------------
// Mailer (SMTP) – Strings erzwingen um TS2322 zu vermeiden
// ------------------------------------------------------
async function sendEmailSMTP(to: string, subject: string, html: string) {
  await mailer().sendMail({
    from: fromAddress(), // bereits string
    to: String(to),
    subject: String(subject),
    html: String(html),
  });
}

// ------------------------------------------------------
// Seiten
// ------------------------------------------------------
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(publicDir, "admin.html"))
);

// ------------------------------------------------------
// Health / Test-Mail
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
// Public Config (Kontakt)
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
// Slots
// ------------------------------------------------------
app.get("/api/slots", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  const guests = Number(req.query.guests || 0);
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

    // Optionale Filterung: nur Slots zurückgeben, die für die gewünschte Gästezahl passen
    const enoughLeft =
      guests > 0
        ? sums.reserved + guests <= MAX_SEATS_RESERVABLE &&
          sums.total + guests <= MAX_SEATS_TOTAL
        : true;

    out.push({
      time: t,
      allowed: true,
      reason: null,
      minutes: allow.minutes,
      canReserve: canReserve && enoughLeft,
      reserved: sums.reserved,
      walkins: sums.walkins,
      total: sums.total,
    });
  }
  res.json(out);
});

// ------------------------------------------------------
// Reservationen
// ------------------------------------------------------
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;

  if (Number(guests) > MAX_GUESTS_ONLINE) {
    return res.status(400).json({
      error:
        "For groups larger than 10 guests, please contact us by phone or email.",
    });
  }

  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    return res.status(400).json({ error: allow.reason || "Not available" });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
    return res.status(400).json({
      error: "All reservable seats are taken at this time.",
    });
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({
      error: "We are fully booked at this time.",
    });

  const token = nanoid();
  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!,
      time: String(time),
      startTs: allow.start!,
      endTs: allow.end!,
      firstName: String(firstName || ""),
      name: String(name || ""),
      email: String(email || ""),
      phone: String(phone || ""),
      guests: Number(guests),
      notes: String(notes || ""),
      status: "confirmed",
      cancelToken: token,
      isWalkIn: false,
    },
  });

  // Besuche zählen (nur bestätigte, keine Walk-ins)
  const past = await prisma.reservation.count({
    where: {
      email: created.email,
      status: "confirmed",
      isWalkIn: false,
      startTs: { lt: created.startTs },
    },
  });
  const reward = loyaltyForVisit(past);

  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const html = confirmationHtml(
    created.firstName,
    created.name,
    created.date,
    created.time,
    created.guests,
    past + 1, // dies ist der n-te Besuch inkl. aktuellem
    reward,
    cancelUrl
  );

  try {
    await sendEmailSMTP(
      created.email,
      `${BRAND_NAME} — Reservation`,
      html
    );
  } catch (e) {
    console.error("Mail Fehler (guest):", e);
  }

  // Admin Info
  try {
    if (ADMIN_EMAIL) {
      const adminHtml = adminNewReservationHtml(created, past + 1, reward);
      await sendEmailSMTP(
        ADMIN_EMAIL,
        `New reservation — ${created.date} ${created.time} — ${String(
          created.guests
        )}p`,
        adminHtml
      );
    }
  } catch (e) {
    console.error("Mail Fehler (admin):", e);
  }

  res.json({ ok: true, reservation: created });
});

// ------------------------------------------------------
// Walk-in (Admin)
// ------------------------------------------------------
app.post("/api/walkin", async (req, res) => {
  const { date, time, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    return res.status(400).json({ error: allow.reason || "Not available" });
  }
  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "Capacity exceeded." });

  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!,
      time: String(time),
      startTs: allow.start!,
      endTs: allow.end!,
      firstName: "",
      name: "Walk-in",
      email: "",
      phone: "",
      guests: Number(guests),
      notes: String(notes || ""),
      status: "confirmed",
      cancelToken: "",
      isWalkIn: true,
    },
  });

  res.json({ ok: true, reservation: created });
});

// ------------------------------------------------------
// Cancel
// ------------------------------------------------------
app.get("/cancel/:token", async (req, res) => {
  const r = await prisma.reservation.findUnique({
    where: { cancelToken: req.params.token },
  });
  if (!r) return res.status(404).send("Not found");

  await prisma.reservation.update({
    where: { id: r.id },
    data: { status: "canceled" },
  });

  // Mails (Gast & Admin)
  try {
    const guestHtml = cancelGuestHtml(
      r.firstName,
      r.name,
      r.date,
      r.time,
      r.guests
    );
    if (r.email) {
      await sendEmailSMTP(
        r.email,
        "We hope this goodbye is only for now 😢",
        guestHtml
      );
    }
  } catch (e) {
    console.error("Cancel mail to guest failed:", e);
  }

  try {
    if (ADMIN_EMAIL) {
      const adminHtml = cancelAdminHtml(r);
      await sendEmailSMTP(
        ADMIN_EMAIL,
        "Guest canceled reservation — FYI",
        adminHtml
      );
    }
  } catch (e) {
    console.error("Cancel mail to admin failed:", e);
  }

  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// ------------------------------------------------------
// Mail HTML – Confirmation
// ------------------------------------------------------
function confirmationHtml(
  firstName: string,
  name: string,
  date: string,
  time: string,
  guests: number,
  visitIndex: number, // inkl. aktuellem
  rewardPercent: number,
  cancelUrl: string
) {
  const site = BRAND_NAME;
  const logo = process.env.MAIL_BANNER_URL || "/logo.png";

  // Loyalitätszeilen
  const visitLine = `This is your <b>${String(visitIndex)}</b> visit.`;
  let teaser = "";
  if (rewardPercent > 0) {
    teaser = `We love welcoming you back — please enjoy a <b>${String(
      rewardPercent
    )}%</b> loyalty thank-you.`;
  }

  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28; background:#fff; padding:0 0 24px;">
    <div style="text-align:center;padding:0 0 14px;">
      <img src="${logo}" alt="Logo" style="width:100%;max-width:1200px;height:auto;display:block;margin:0 auto;border-radius:10px" />
    </div>
    <div style="max-width:720px;margin:0 auto;background:#fff; border-radius:10px; padding:24px;">
      <h2 style="margin:0 0 16px 0;">Your Reservation at ${site}</h2>
      <p style="margin:0 0 10px 0;">Hi ${firstName} ${name},</p>
      <p style="margin:0 0 16px 0;">Thank you for choosing <b>${site}</b>. We value loyalty deeply — regular guests are the heart of our little community.</p>

      <div style="background:#f9efe6;border-radius:10px;padding:12px 14px;margin:0 0 12px;">
        <div><b>Date</b><div style="margin-top:4px;">${date}</div></div>
      </div>
      <div style="background:#f9efe6;border-radius:10px;padding:12px 14px;margin:0 0 12px;">
        <div><b>Time</b><div style="margin-top:4px;">${time}</div></div>
      </div>
      <div style="background:#f9efe6;border-radius:10px;padding:12px 14px;margin:0 0 12px;">
        <div><b>Guests</b><div style="margin-top:4px;">${String(guests)}</div></div>
      </div>

      <p style="margin:14px 0 8px 0;">${visitLine}</p>
      ${teaser ? `<p style="margin:0 0 12px 0;">${teaser}</p>` : ""}

      <div style="background:#fdeae3;border-radius:10px;padding:12px 14px;margin:10px 0 16px;">
        <b>Punctuality</b>
        <div style="margin-top:6px;">Please arrive on time — tables may be released after <b>15 minutes</b> of delay.</div>
      </div>

      <p style="text-align:center;margin:18px 0;">
        <a href="${cancelUrl}" style="display:inline-block;padding:10px 14px;background:#b68656;color:#fff;text-decoration:none;border-radius:6px;">Cancel reservation</a>
      </p>
      <p style="font-size:12px;color:#6b5b51;word-break:break-all;text-align:center;margin:0 0 18px;">
        If the button doesn’t work, copy this link:<br/>${cancelUrl}
      </p>

      <p style="margin:12px 0 0 0;text-align:center;">We can’t wait to welcome you!</p>
      <p style="margin:4px 0 0 0;text-align:center;"><b>Warm greetings from ${site}</b></p>
    </div>
  </div>`;
}

// ------------------------------------------------------
// Mail HTML – Admin New Reservation
// ------------------------------------------------------
function adminNewReservationHtml(
  r: {
    firstName: string;
    name: string;
    email: string;
    phone: string;
    date: string;
    time: string;
    guests: number;
    notes: string | null;
  },
  visitIndex: number,
  rewardPercent: number
) {
  const site = BRAND_NAME;
  return `
  <div style="font-family:Georgia,serif;color:#3a2f28;">
    <h2 style="margin:0 0 12px 0;">New reservation ✅</h2>
    <div style="background:#f9efe6;border-radius:10px;padding:12px 14px;">
      <div><b>Guest</b> ${r.firstName} ${r.name} (${r.email})</div>
      <div><b>Phone</b> ${r.phone}</div>
      <div><b>Date</b> ${r.date} &nbsp; <b>Time</b> ${r.time}</div>
      <div><b>Guests</b> ${String(r.guests)}</div>
      <div><b>Notes</b> ${r.notes ? r.notes : "-"}</div>
      <div><b>Total past visits</b> ${String(visitIndex)}</div>
      <div><b>Discount</b> ${rewardPercent > 0 ? `${String(rewardPercent)}%` : "—"}</div>
    </div>
    <p style="margin-top:12px;">${site}</p>
  </div>`;
}

// ------------------------------------------------------
// Mail HTML – Guest Cancel
// ------------------------------------------------------
function cancelGuestHtml(
  firstName: string,
  name: string,
  date: string,
  time: string,
  guests: number
) {
  const site = BRAND_NAME;
  const banner = process.env.MAIL_BANNER_URL || "/logo.png";
  const bookUrl = process.env.PUBLIC_BOOK_URL || BASE_URL;
  return `
  <div style="font-family:Georgia,serif;color:#3a2f28;background:#fff;">
    <div style="text-align:center;padding:0 0 14px;">
      <img src="${banner}" alt="Logo" style="width:100%;max-width:1200px;height:auto;display:block;margin:0 auto;border-radius:10px" />
    </div>
    <div style="max-width:720px;margin:0 auto; background:#fff;border-radius:10px;padding:24px;">
      <h2 style="margin:0 0 10px 0;">We’ll miss you this round 😢</h2>
      <p>Hi ${firstName} ${name},</p>
      <p>Your reservation for <b>${String(guests)}</b> on <b>${date}</b> at <b>${time}</b> has been canceled.</p>
      <p>We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
      <p style="text-align:center;margin:18px 0;">
        <a href="${bookUrl}" style="display:inline-block;padding:10px 14px;background:#b68656;color:#fff;text-decoration:none;border-radius:6px;">Book your comeback</a>
      </p>
      <p>With warm regards,<br/><b>${site}</b></p>
    </div>
  </div>`;
}

// ------------------------------------------------------
// Mail HTML – Admin Cancel
// ------------------------------------------------------
function cancelAdminHtml(r: any) {
  const site = BRAND_NAME;
  return `
  <div style="font-family:Georgia,serif;color:#3a2f28;">
    <h2 style="margin:0 0 12px 0;">Reservation canceled 🫤</h2>
    <div style="background:#f9efe6;border-radius:10px;padding:12px 14px;">
      <div><b>Guest</b> ${r.firstName} ${r.name} (${r.email})</div>
      <div><b>Phone</b> ${r.phone}</div>
      <div><b>Date</b> ${r.date} &nbsp; <b>Time</b> ${r.time}</div>
      <div><b>Guests</b> ${String(r.guests)}</div>
      <div><b>Notes</b> ${r.notes ? r.notes : "-"}</div>
      <div><b>Total past visits</b> (admin can check)</div>
    </div>
    <p style="margin-top:12px;">${site}</p>
  </div>`;
}

// ------------------------------------------------------
// Reminder Job (24h vorher)
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
        <p><b>Date</b> ${r.date} — <b>Time</b> ${r.time} — <b>Guests</b> ${String(
      r.guests
    )}</p>
        <p>If your plans change, please cancel here:<br/>
        <a href="${cancelUrl}">${cancelUrl}</a></p>
        <p>See you soon,<br/>${BRAND_NAME}</p>
      </div>`;
    try {
      if (r.email) {
        await sendEmailSMTP(r.email, "Reservation reminder", html);
        await prisma.reservation.update({
          where: { id: r.id },
          data: { reminderSent: true },
        });
      }
    } catch (e) {
      console.error("Reminder mail Fehler:", e);
    }
  }
}
setInterval(sendReminders, 30 * 60 * 1000);

// ------------------------------------------------------
// Start
// ------------------------------------------------------
async function start() {
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on ${PORT}`);
  });
}

start().catch((err) => {
  console.error("Fatal start error", err);
  process.exit(1);
});
