// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { addHours, addMinutes, isAfter, isBefore } from "date-fns";
import { nanoid } from "nanoid";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

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

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "info@noxamasamui.com";

// Sitzplätze
const MAX_SEATS_TOTAL = Number(
  process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48
);
const MAX_SEATS_RESERVABLE = Number(
  process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40
);

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
// Hilfen
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
  const reserved = list.filter(r => !r.isWalkIn).reduce((s, r) => s + r.guests, 0);
  const walkins = list.filter(r => r.isWalkIn).reduce((s, r) => s + r.guests, 0);
  return { reserved, walkins, total: reserved + walkins };
}

async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok: false, reason: "Invalid time" };
  if (SUNDAY_CLOSED && isSundayYmd(norm))
    return { ok: false, reason: "Closed on Sundays" };

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

function loyaltyVisitInfo(pastVisits: number) {
  // Past visits = abgeschlossene vorherige Reservierungen (status confirmed/noshow)
  // Rabatt: 5% für Besuch 5-9, 10% für 10-14, 15% ab 15
  let discount = 0;
  if (pastVisits >= 4 && pastVisits <= 8) discount = 5;
  if (pastVisits >= 9 && pastVisits <= 13) discount = 10;
  if (pastVisits >= 14) discount = 15;

  // Teaser für 4./9./14. Buchung
  let teaser = "";
  if (pastVisits === 4) teaser = "Next visit comes with a 5% loyalty thank-you.";
  if (pastVisits === 9) teaser = "Your 10th visit comes with a 10% loyalty thank-you.";
  if (pastVisits === 14) teaser = "From your 15th visit on you enjoy 15% loyalty thank-you.";

  return { discount, teaser };
}

// ------------------------------------------------------
// Mail
// ------------------------------------------------------
async function sendEmailSMTP(to: string, subject: string, html: string) {
  await mailer().sendMail({
    from: fromAddress(),
    to,
    subject,
    html,
  });
}

function htmlEscape(s: string) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// E-Mail Templates
function confirmationHtml(
  r: {
    firstName: string;
    name: string;
    date: string;
    time: string;
    guests: number;
  },
  visitIndex: number,
  discount: number,
  teaser: string,
  cancelUrl: string
) {
  const banner =
    process.env.MAIL_BANNER_URL && process.env.MAIL_BANNER_URL.trim().length > 0
      ? process.env.MAIL_BANNER_URL
      : "/logo.png";
  const site = BRAND_NAME;

  const visitLine =
    visitIndex <= 4
      ? `This is your ${visitIndex}th visit. Thank you for coming back to us.`
      : `This is your ${visitIndex}th visit.`;

  const reward =
    discount > 0
      ? `<div style="font-weight:600;margin:14px 0 10px 0;">🎉 Thank you for coming back! — enjoy a ${discount}% loyalty thank-you.</div>`
      : "";

  const tease = teaser
    ? `<div style="color:#6b513f;margin-top:6px;">${htmlEscape(teaser)}</div>`
    : "";

  return `
  <div style="background:#fff;padding:0;margin:0;font-family:Georgia,'Times New Roman',serif;color:#3a2f28">
    <div style="max-width:720px;margin:0 auto">
      <img src="${banner}" alt="Banner" style="width:100%;height:auto;display:block;border:0;margin:0 0 14px 0"/>
      <h1 style="font-size:26px;margin:8px 0 18px 0;">Your Reservation at ${site}</h1>
      <p>Hi ${htmlEscape(r.firstName)} ${htmlEscape(r.name)},</p>
      <p>Thank you for choosing <b>${site}</b>. We value loyalty deeply — regular guests are the heart of our little community.</p>

      <div style="background:#fff6ee;border:1px solid #e8d8c7;border-radius:8px;padding:16px;margin:16px 0;">
        <div><b>Date</b><br/>${htmlEscape(r.date)}</div>
        <div style="margin-top:10px;"><b>Time</b><br/>${htmlEscape(r.time)}</div>
        <div style="margin-top:10px;"><b>Guests</b><br/>${r.guests}</div>
      </div>

      <div style="margin:10px 0 6px 0;">${visitLine}</div>
      ${reward}
      ${tease}

      <div style="background:#fff0ea;border:1px solid #f1d6c9;border-radius:8px;padding:14px;margin:18px 0;">
        <div style="font-weight:700;margin-bottom:6px;">Punctuality</div>
        <div>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.</div>
      </div>

      <div style="margin:20px 0;">
        <a href="${cancelUrl}" style="display:inline-block;padding:10px 14px;background:#a6753a;color:#fff;text-decoration:none;border-radius:8px">Cancel reservation</a>
      </div>

      <p style="margin-top:26px;">We can’t wait to welcome you!<br/><b>Warm greetings from ${site}</b></p>
    </div>
  </div>`;
}

function adminNewReservationHtml(r: any, pastVisits: number, discount: number) {
  const site = BRAND_NAME;
  const logo = "/logo.png";
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28">
    <div style="max-width:700px;margin:0 auto;">
      <img src="${logo}" alt="Logo" style="width:160px;height:auto;display:block;margin:12px auto 10px"/>
      <h2 style="text-align:center;margin:6px 0 18px 0;">New reservation ✅</h2>
      <div style="background:#fff6ee;border:1px solid #e8d8c7;border-radius:8px;padding:14px">
        <div><b>Guest</b> ${htmlEscape(r.firstName)} ${htmlEscape(r.name)} (${htmlEscape(
    r.email
  )})</div>
        <div><b>Phone</b> ${htmlEscape(r.phone || "-")}</div>
        <div><b>Date</b> ${htmlEscape(r.date)}  <b>Time</b> ${htmlEscape(
    r.time
  )}</div>
        <div><b>Guests</b> ${r.guests}</div>
        <div><b>Notes</b> ${htmlEscape(r.notes || "-")}</div>
        <div><b>Total past visits</b> ${pastVisits}</div>
        <div><b>Discount</b> ${discount > 0 ? discount + "%" : "-"}</div>
      </div>
      <p style="text-align:center;margin-top:18px;">${site}</p>
    </div>
  </div>`;
}

function guestCanceledHtml(r: any) {
  const site = BRAND_NAME;
  const banner =
    process.env.MAIL_BANNER_URL && process.env.MAIL_BANNER_URL.trim().length > 0
      ? process.env.MAIL_BANNER_URL
      : "/logo.png";
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28">
    <div style="max-width:720px;margin:0 auto;">
      <img src="${banner}" alt="Banner" style="width:100%;height:auto;display:block;margin:0 0 12px 0"/>
      <h1 style="margin:8px 0 12px 0;">We’ll miss you this round 😢</h1>
      <p>Hi ${htmlEscape(r.firstName)} ${htmlEscape(r.name)},</p>
      <p>Your reservation for ${r.guests} on <b>${htmlEscape(
    r.date
  )}</b> at <b>${htmlEscape(r.time)}</b> has been canceled.</p>
      <p>We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
      <p style="margin-top:20px;">
        <a href="${BASE_URL}" style="display:inline-block;padding:10px 14px;background:#a6753a;color:#fff;text-decoration:none;border-radius:8px">Book your comeback</a>
      </p>
      <p style="margin-top:18px;">With warm regards,<br/><b>${site}</b></p>
    </div>
  </div>`;
}

function adminCanceledHtml(r: any, totalVisits: number) {
  const site = BRAND_NAME;
  const logo = "/logo.png";
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28">
    <div style="max-width:680px;margin:0 auto;">
      <img src="${logo}" alt="Logo" style="width:140px;height:auto;display:block;margin:12px auto 8px"/>
      <h2 style="text-align:center;margin:6px 0 18px 0;">Reservation canceled 🥺</h2>
      <div style="background:#fff6ee;border:1px solid #e8d8c7;border-radius:8px;padding:14px">
        <div><b>Guest</b> ${htmlEscape(r.firstName)} ${htmlEscape(r.name)} (${htmlEscape(
    r.email
  )})</div>
        <div><b>Phone</b> ${htmlEscape(r.phone || "-")}</div>
        <div><b>Date</b> ${htmlEscape(r.date)}  <b>Time</b> ${htmlEscape(
    r.time
  )}</div>
        <div><b>Guests</b> ${r.guests}</div>
        <div><b>Notes</b> ${htmlEscape(r.notes || "-")}</div>
        <div><b>Total past visits</b> ${totalVisits}</div>
      </div>
      <p style="text-align:center;margin-top:18px;">${site}</p>
    </div>
  </div>`;
}

// ------------------------------------------------------
// Pages
// ------------------------------------------------------
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(publicDir, "admin.html"))
);

// ------------------------------------------------------
// Health
// ------------------------------------------------------
app.get("/__health/email", async (_req, res) => {
  try {
    await verifyMailer();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// ------------------------------------------------------
// Public Config
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
// Slots (kapazitätsgefiltert)
// ------------------------------------------------------
app.get("/api/slots", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  const want = Number(req.query.guests || 0) || 1;
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
        seatsLeft: 0,
      });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const seatsReservableLeft = Math.max(
      0,
      MAX_SEATS_RESERVABLE - sums.reserved
    );
    const seatsTotalLeft = Math.max(0, MAX_SEATS_TOTAL - sums.total);
    const canReserve =
      seatsReservableLeft >= want && seatsTotalLeft >= want;

    out.push({
      time: t,
      allowed: true,
      minutes: allow.minutes,
      canReserve,
      seatsLeft: Math.min(seatsReservableLeft, seatsTotalLeft),
    });
  }
  res.json(out);
});

// ------------------------------------------------------
// Reservationen (public)
// ------------------------------------------------------
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;

  // Max 10 online
  if (Number(guests) > 10) {
    return res.status(400).json({
      error:
        "For groups larger than 10 please contact us by phone or email. Thank you.",
    });
  }

  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    const msg =
      allow.reason === "Blocked"
        ? "We are fully booked on this date. Please choose another day."
        : "Not available";
    return res.status(400).json({ error: msg });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
    return res.status(400).json({
      error: "All reservable seats are taken at this time.",
    });
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({
      error: "We are full at this time.",
    });

  // vergangene Besuche zählen (bestätigt/noshow, nicht walk-in)
  const past = await prisma.reservation.count({
    where: {
      email: String(email || "").toLowerCase(),
      status: { in: ["confirmed", "noshow"] },
      isWalkIn: false,
    },
  });
  const { discount, teaser } = loyaltyVisitInfo(past);
  const visitIndex = past + 1;

  const token = nanoid();
  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!,
      time,
      startTs: allow.start!,
      endTs: allow.end!,
      firstName: String(firstName || ""),
      name: String(name || ""),
      email: String(email || "").toLowerCase(),
      phone: String(phone || ""),
      guests: Number(guests) || 1,
      notes: String(notes || ""),
      status: "confirmed",
      cancelToken: token,
      isWalkIn: false,
    },
  });

  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const guestHtml = confirmationHtml(
    {
      firstName: created.firstName,
      name: created.name,
      date: created.date,
      time: created.time,
      guests: created.guests,
    },
    visitIndex,
    discount,
    teaser,
    cancelUrl
  );

  try {
    await sendEmailSMTP(
      created.email,
      `${BRAND_NAME} — Reservation`,
      guestHtml
    );

    // Admin FYI (separat; landet nicht beim Gast)
    await sendEmailSMTP(
      ADMIN_EMAIL,
      `New reservation — ${created.date} ${created.time} — ${created.guests}p`,
      adminNewReservationHtml(created, past, discount)
    );
  } catch (e) {
    console.error("Mail error:", e);
  }

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

  // Für “Zähler” vorherige Besuche erneut holen
  const past = await prisma.reservation.count({
    where: {
      email: String(r.email || "").toLowerCase(),
      status: { in: ["confirmed", "noshow"] },
      isWalkIn: false,
    },
  });

  await prisma.reservation.update({
    where: { id: r.id },
    data: { status: "canceled" },
  });

  // Gast + Admin getrennt versenden (kein Duplikat an denselben Empfänger, außer du testest mit derselben Adresse)
  try {
    await sendEmailSMTP(
      r.email,
      "We hope this goodbye is only for now 😢",
      guestCanceledHtml(r)
    );
    await sendEmailSMTP(
      ADMIN_EMAIL,
      "Guest canceled reservation — FYI",
      adminCanceledHtml(r, past)
    );
  } catch (e) {
    console.error("Cancel mail error:", e);
  }

  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// ------------------------------------------------------
// Admin API
// ------------------------------------------------------
function assertAdminKey(req: Request) {
  // optional: einfache Absicherung via Header X-Admin-Key
  const need = process.env.ADMIN_KEY?.trim();
  if (!need) return true;
  const got = String(req.header("x-admin-key") || "");
  return got === need;
}

// Liste (day/week)
app.get("/api/admin/reservations", async (req, res) => {
  if (!assertAdminKey(req)) return res.status(401).json({ error: "unauthorized" });

  const date = normalizeYmd(String(req.query.date || ""));
  const view = String(req.query.view || "day");
  if (!date) return res.json([]);

  const { y, m, d } = splitYmd(date);
  const start = localDate(y, m, d, 0, 0, 0);
  const end =
    view === "week"
      ? addHours(localDate(y, m, d + 7, 0, 0, 0), 0)
      : addHours(localDate(y, m, d + 1, 0, 0, 0), 0);

  const list = await prisma.reservation.findMany({
    where: {
      startTs: { gte: start, lt: end },
    },
    orderBy: [{ startTs: "asc" }],
  });
  res.json(list);
});

// Walk-in anlegen (frei, aber Öffnungszeiten + Block prüfen)
app.post("/api/admin/walkin", async (req, res) => {
  if (!assertAdminKey(req)) return res.status(401).json({ error: "unauthorized" });

  const { date, time, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) return res.status(400).json({ error: allow.reason || "not allowed" });

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
      guests: Number(guests) || 1,
      notes: String(notes || ""),
      status: "confirmed",
      cancelToken: "",
      isWalkIn: true,
    },
  });
  res.json({ ok: true, reservation: created });
});

// Block erstellen
app.post("/api/admin/block", async (req, res) => {
  if (!assertAdminKey(req)) return res.status(401).json({ error: "unauthorized" });

  const { start, end, reason } = req.body; // ISO strings
  const s = new Date(start);
  const e = new Date(end);
  if (!(s instanceof Date) || !(e instanceof Date) || isNaN(s.getTime()) || isNaN(e.getTime()) || !isBefore(s, e)) {
    return res.status(400).json({ error: "invalid range" });
  }
  const created = await prisma.closure.create({
    data: { startTs: s, endTs: e, reason: String(reason || "") },
  });
  res.json({ ok: true, block: created });
});

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
      <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28">
        <p>Friendly reminder for your reservation tomorrow:</p>
        <p><b>Date</b> ${r.date}<br/><b>Time</b> ${r.time}<br/><b>Guests</b> ${r.guests}</p>
        <p>If your plans change, please cancel here:<br/>
        <a href="${cancelUrl}">${cancelUrl}</a></p>
        <p>See you soon,<br/>${BRAND_NAME}</p>
      </div>`;
    try {
      await sendEmailSMTP(r.email, "Reservation reminder", html);
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
// Start
// ------------------------------------------------------
async function start() {
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on ${PORT}`);
  });
}

start().catch(err => {
  console.error("Fatal start error", err);
  process.exit(1);
});
