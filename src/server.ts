// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { format, addMinutes, addHours } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

// ------------------------------------------------------------------
//  App / Prisma / Static
// ------------------------------------------------------------------
const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

// ------------------------------------------------------------------
//  Config
// ------------------------------------------------------------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_EMAIL =
  process.env.MAIL_FROM_ADDRESS ||
  process.env.SMTP_USER ||
  "info@noxamasamui.com";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";

// UI Farben + Banner
const BG = "#d6c7b2"; // einheitlicher Hintergrund
const BANNER = process.env.MAIL_BANNER_URL || "https://i.imgur.com/LQ4nzwd.png";

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

// ------------------------------------------------------------------
//  Helpers (wie gehabt)
// ------------------------------------------------------------------
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
    .filter(r => !r.isWalkIn)
    .reduce((s, r) => s + r.guests, 0);
  const walkins = list
    .filter(r => r.isWalkIn)
    .reduce((s, r) => s + r.guests, 0);
  return { reserved, walkins, total: reserved + walkins };
}

async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok: false, reason: "Ungültige Zeit" };
  if (SUNDAY_CLOSED && isSundayYmd(norm))
    return { ok: false, reason: "Sonntag geschlossen" };

  const start = localDateFrom(norm, timeHHmm);
  if (isNaN(start.getTime())) return { ok: false, reason: "Ungültige Zeit" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y, m, d } = splitYmd(norm);
  const open = localDate(y, m, d, OPEN_HOUR, 0, 0);
  const close = localDate(y, m, d, CLOSE_HOUR, 0, 0);
  if (start < open) return { ok: false, reason: "Vor Öffnung" };
  if (end > close) return { ok: false, reason: "Nach Ladenschluss" };

  const blocked = await prisma.closure.findFirst({
    where: { AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }] },
  });
  if (blocked) return { ok: false, reason: "Blockiert" };

  return { ok: true, start, end, minutes, norm };
}

// ------------------------------------------------------------------
//  Mail (SMTP)
// ------------------------------------------------------------------
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
app.get("/", (_req, res) =>
  res.sendFile(path.join(publicDir, "index.html"))
);
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(publicDir, "admin.html"))
);

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
//  Reservations
// ------------------------------------------------------
app.post("/api/reservations", async (req: Request, res: Response) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    return res.status(400).json({ error: allow.reason || "Nicht verfügbar" });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
    return res.status(400).json({
      error: "Zu dieser Zeit sind alle Reservierungsplätze vergeben.",
    });
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({
      error: "Zu dieser Zeit sind wir leider voll.",
    });

  const token = nanoid();
  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!,
      time,
      startTs: allow.start!,
      endTs: allow.end!,
      firstName,
      name,
      email,
      phone,
      guests: Number(guests),
      notes,
      status: "confirmed",
      cancelToken: token,
      isWalkIn: false,
    },
  });

  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const html = reservationEmailHtml({
    firstName: created.firstName,
    name: created.name,
    date: created.date,
    time: created.time,
    guests: created.guests,
    cancelUrl,
    visits: await countVisits(created.email, created.id),
  });

  // Kunde
  try {
    await sendEmailSMTP(
      created.email,
      `${BRAND_NAME} — Reservation`,
      html
    );
  } catch (e) {
    console.error("Mail Fehler:", e);
  }

  // Admin FYI
  if (ADMIN_EMAIL) {
    const adminHtml = adminNewReservationHtml(created);
    try {
      await sendEmailSMTP(ADMIN_EMAIL, `New reservation — ${created.date} ${created.time} — ${created.guests}p`, adminHtml);
    } catch {}
  }

  res.json({ ok: true, reservation: created });
});

// ------------------------------------------------------
//  Cancel
// ------------------------------------------------------
app.get("/cancel/:token", async (req: Request, res: Response) => {
  const r = await prisma.reservation.findUnique({
    where: { cancelToken: req.params.token },
  });
  if (!r) return res.status(404).send("Not found");

  await prisma.reservation.update({
    where: { id: r.id },
    data: { status: "canceled" },
  });

  // E-Mails
  try {
    if (r.email) {
      await sendEmailSMTP(
        r.email,
        "We hope this goodbye is only for now 😢",
        cancelGuestHtml(r)
      );
    }
    if (ADMIN_EMAIL) {
      await sendEmailSMTP(
        ADMIN_EMAIL,
        "Guest canceled reservation — FYI",
        cancelAdminHtml(r)
      );
    }
  } catch {}

  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// ------------------------------------------------------
//  Reminder Job (unverändert, nur Template nutzt Design)
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
    try {
      await sendEmailSMTP(r.email, "Friendly reminder for your reservation", reminderHtml(r, cancelUrl));
      await prisma.reservation.update({ where: { id: r.id }, data: { reminderSent: true } });
    } catch (e) {
      console.error("Reminder mail Fehler:", e);
    }
  }
}
setInterval(sendReminders, 30 * 60 * 1000);

// ------------------------------------------------------
//  Start
// ------------------------------------------------------
async function start() {
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on ${PORT}`));
}
start().catch(err => { console.error("Fatal start error", err); process.exit(1); });

/* ======================================================
   EMAIL TEMPLATES — EIN DESIGN, KEIN doppeltes Logo
   ====================================================== */

type Resv = {
  firstName?: string | null;
  name?: string | null;
  date: string;
  time: string;
  guests: number;
};
function shell(body: string): string {
  return `
  <div style="background:${BG}; padding:24px 0; font-family: Georgia, 'Times New Roman', serif; color:#3a2f28;">
    <div style="max-width:640px;margin:0 auto;background:#fff6ec;border-radius:10px;box-shadow:0 2px 6px rgba(0,0,0,.08); overflow:hidden;">
      <img src="${BANNER}" alt="Banner" width="640" height="213" style="display:block;width:100%;height:auto;">
      <div style="padding:22px 22px 28px 22px;">
        ${body}
      </div>
    </div>
  </div>`;
}

function pill(label: string, value: string) {
  return `
  <div style="background:#f0e6d8;border-radius:8px;padding:10px 12px;margin:6px 0;">
    <div style="font-weight:bold">${label}</div>
    <div>${value}</div>
  </div>`;
}

function loyaltyBlock(visits: number) {
  // 5–9 => 5%, 10–14 => 10%, >=15 => 15%
  let reward = "";
  if (visits >= 15) reward = "15% loyalty thank-you.";
  else if (visits >= 10) reward = "10% loyalty thank-you.";
  else if (visits >= 5) reward = "5% loyalty thank-you.";

  if (!reward) return "";

  return `
  <div style="margin:16px 0 8px 0;padding:12px 14px;background:#f7efe2;border-left:4px solid #b08d57;border-radius:6px;">
    <div style="font-weight:700;margin-bottom:4px;">We love welcoming you back</div>
    <div>Please enjoy a ${reward}</div>
  </div>`;
}

function visitsLine(v: number) {
  if (v <= 0) return "";
  if (v < 5) {
    return `<div style="margin:10px 0 6px 0;">This is your <b>${v}${nth(v)}</b> visit. Thank you for coming back to us.</div>`;
  }
  return `<div style="margin:10px 0 6px 0;">This is your <b>${v}${nth(v)}</b> visit.</div>`;
}
function nth(n: number) {
  if (n % 10 === 1 && n % 100 !== 11) return "st";
  if (n % 10 === 2 && n % 100 !== 12) return "nd";
  if (n % 10 === 3 && n % 100 !== 13) return "rd";
  return "th";
}

async function countVisits(email: string, excludeId?: string): Promise<number> {
  if (!email) return 0;
  const all = await prisma.reservation.findMany({
    where: {
      email,
      status: { in: ["confirmed", "noshow", "canceled"] },
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
    select: { id: true },
  });
  return all.length + 1; // diese Buchung mitzählen
}

// --- Reservation confirmation (guest)
function reservationEmailHtml(p: {
  firstName?: string | null;
  name?: string | null;
  date: string;
  time: string;
  guests: number;
  cancelUrl: string;
  visits: number;
}): string {
  const body = `
  <h2 style="margin:0 0 10px 0;">Your Reservation at ${BRAND_NAME}</h2>

  ${pill("Date", p.date)}
  ${pill("Time", p.time)}
  ${pill("Guests", String(p.guests))}

  ${visitsLine(p.visits)}
  ${loyaltyBlock(p.visits)}

  <div style="margin:14px 0 10px 0;padding:12px;background:#fdeee6;border-radius:8px;">
    <div style="font-weight:bold;margin-bottom:4px;">Punctuality</div>
    <div>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.</div>
  </div>

  <p style="margin:18px 0 6px 0;"><a href="${p.cancelUrl}" style="display:inline-block;padding:10px 14px;background:#b08d57;color:#fff;text-decoration:none;border-radius:6px;">Cancel reservation</a></p>
  <p style="font-size:12px;opacity:.8;">If the button doesn’t work, copy this link:<br>${p.cancelUrl}</p>

  <p style="margin-top:18px;">We can’t wait to welcome you!<br/><b>Warm greetings from ${BRAND_NAME}</b></p>
  `;
  return shell(body);
}

// --- Reminder (guest)
function reminderHtml(r: Resv, cancelUrl: string): string {
  const body = `
  <h3 style="margin:0 0 10px 0;">Friendly reminder</h3>
  ${pill("Date", r.date)}
  ${pill("Time", r.time)}
  ${pill("Guests", String(r.guests))}

  <p style="margin:12px 0;">If your plans change, please cancel here:</p>
  <p><a href="${cancelUrl}" style="display:inline-block;padding:10px 14px;background:#b08d57;color:#fff;text-decoration:none;border-radius:6px;">Cancel reservation</a></p>
  `;
  return shell(body);
}

// --- Cancel (guest)
function cancelGuestHtml(r: any): string {
  const body = `
    <h2 style="margin:0 0 10px 0;">We’ll miss you this round 😢</h2>
    ${pill("Date", r.date)}
    ${pill("Time", r.time)}
    ${pill("Guests", String(r.guests))}
    <p style="margin-top:12px;">We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
    <p><a href="${BASE_URL}" style="display:inline-block;padding:10px 14px;background:#b08d57;color:#fff;text-decoration:none;border-radius:6px;">Book your comeback</a></p>
    <p style="margin-top:14px;">With warm regards,<br/><b>${BRAND_NAME}</b></p>
  `;
  return shell(body);
}

// --- Cancel (admin FYI)
function cancelAdminHtml(r: any): string {
  const body = `
    <h3 style="margin:0 0 10px 0;">Reservation canceled</h3>
    ${pill("Guest", `${r.firstName} ${r.name} (${r.email})`)}
    ${pill("Phone", r.phone || "-")}
    ${pill("Date", r.date)}${pill("Time", r.time)}${pill("Guests", String(r.guests))}
    <div style="margin-top:8px;font-size:12px;opacity:.8;">Total past visits ${"— n/a (FYI mail)"} </div>
  `;
  return shell(body);
}

// --- New reservation (admin FYI)
function adminNewReservationHtml(r: any): string {
  const body = `
    <h3 style="margin:0 0 10px 0;">New reservation ✔</h3>
    ${pill("Guest", `${r.firstName} ${r.name} (${r.email})`)}
    ${pill("Phone", r.phone || "-")}
    ${pill("Date", r.date)}${pill("Time", r.time)}${pill("Guests", String(r.guests))}
    ${r.notes ? pill("Notes", r.notes) : ""}
  `;
  return shell(body);
}
