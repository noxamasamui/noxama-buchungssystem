// server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { randomBytes, timingSafeEqual } from "crypto";
import XLSX from "xlsx";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { addMinutes, addHours, differenceInMinutes, format } from "date-fns";
import fs from "fs";
import { promisify } from "util";

const writeFile = promisify(fs.writeFile);
const readFile = promisify(fs.readFile);

dotenv.config();

/* ---------- Basic-Auth ENV (nur Admin) ---------- */
const ADMIN_BASIC_USER = String(process.env.ADMIN_BASIC_USER || "admin").trim();
// Schutz aktiv nur wenn Passwort gesetzt; leer lässt Admin offen (z. B. Dev)
const ADMIN_BASIC_PASS = String(process.env.ADMIN_BASIC_PASS || "").trim();
/* ------------------------------------------------ */

function generateId(size = 21): string {
  const buf = randomBytes(Math.ceil((size * 3) / 4));
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
    .slice(0, size);
}

const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

/* ---------- Admin-Gate (nur Admin, Notice-GET ausnehmen) ---------- */
function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
function requireAdminAuth(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  if (!ADMIN_BASIC_PASS) return next(); // Schutz aus, falls kein Passwort gesetzt
  const hdr = String(req.headers["authorization"] || "");
  if (!hdr.startsWith("Basic ")) {
    res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
    return res.status(401).send("Authentication required");
  }
  try {
    const decoded = Buffer.from(hdr.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    const user = idx >= 0 ? decoded.slice(0, idx) : "";
    const pass = idx >= 0 ? decoded.slice(idx + 1) : "";
    if (safeEqual(user, ADMIN_BASIC_USER) && safeEqual(pass, ADMIN_BASIC_PASS))
      return next();
  } catch {}
  res.setHeader("WWW-Authenticate", 'Basic realm="Admin"');
  return res.status(401).send("Unauthorized");
}

// WICHTIG: vor express.static() lassen
app.use((req, res, next) => {
  const p = req.path.toLowerCase();

  // Öffentliche Ausnahme: die Buchungsseite ruft GET /api/admin/notice?date=... auf
  const isPublicNoticeGet =
    req.method === "GET" &&
    (p === "/api/admin/notice" || p.startsWith("/api/admin/notice/"));

  if (isPublicNoticeGet) return next();

  // Geschützte Admin-Bereiche
  const isAdminPath =
    p === "/admin" ||
    p === "/admin.html" ||
    p.startsWith("/api/admin/") ||
    p === "/api/admin" ||
    p === "/api/export";

  if (isAdminPath) return requireAdminAuth(req, res, next);
  return next();
});
/* ------------------------------------------------------------------ */

app.use(express.static(publicDir));

const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const VENUE_ADDRESS =
  process.env.VENUE_ADDRESS || "Moo 4 Lamai Beach, 84310 Suratthani, Thailand";
const VENUE_PHONE = process.env.VENUE_PHONE || "+66 077 270 675";
const VENUE_EMAIL = process.env.VENUE_EMAIL || "info@noxamasamui.com";

const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || "/logo-hero.png";
const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || "";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_ADDR = process.env.MAIL_FROM_ADDRESS || VENUE_EMAIL;

const OPEN_HOUR = num(process.env.OPEN_HOUR, 10);
const CLOSE_HOUR = num(process.env.CLOSE_HOUR, 22);
const SLOT_INTERVAL = num(process.env.SLOT_INTERVAL, 15);
const SUNDAY_CLOSED = strBool(process.env.SUNDAY_CLOSED, true);
const RESERVATION_DURATION_MIN = num(
  process.env.RESERVATION_DURATION_MIN,
  90
);
const MAX_SEATS_TOTAL = num(process.env.MAX_SEATS_TOTAL, 48);
const MAX_SEATS_RESERVABLE = num(process.env.MAX_SEATS_RESERVABLE, 40);
const MAX_ONLINE_GUESTS = num(process.env.MAX_ONLINE_GUESTS, 10);
const WALKIN_BUFFER = num(process.env.WALKIN_BUFFER, 8);

const ADMIN_TO =
  String(process.env.ADMIN_EMAIL || "") ||
  String(process.env.MAIL_TO_ADMIN || "") ||
  String(process.env.SMTP_USER || "") ||
  FROM_ADDR;

const ADMIN_RESET_KEY = process.env.ADMIN_RESET_KEY || "";

/* ---------- Minimaler Fallback für Admin-Mail ---------- */
const EXTRA_ADMIN_EMAIL = String(
  process.env.EXTRA_ADMIN_EMAIL || "noxamasamui@gmail.com"
).trim();
/* ------------------------------------------------------ */

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
async function sendMail(to: string, subject: string, html: string) {
  await transporter.sendMail({
    from: `"${FROM_NAME}" <${FROM_ADDR}>`,
    to,
    subject,
    html,
  });
}

function num(v: any, fb: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fb;
}
function strBool(v: any, fb = false) {
  if (v == null) return fb;
  return String(v).trim().toLowerCase() === "true";
}
function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function normalizeYmd(input: string): string {
  const s = String(input || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const [dd, mm, yy] = s.split(".").map(Number);
    return `${yy}-${pad2(mm)}-${pad2(dd)}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime()))
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(
      d.getDate()
    )}`;
  return "";
}
function splitYmd(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
}
function localDate(
  y: number,
  m: number,
  d: number,
  hh = 0,
  mm = 0,
  ss = 0
) {
  return new Date(y, m - 1, d, hh, mm, ss);
}
function localDateFrom(ymd: string, hhmm: string) {
  const { y, m, d } = splitYmd(ymd);
  const [hh, mm] = hhmm.split(":").map(Number);
  return localDate(y, m, d, hh, mm, 0);
}
function isSunday(ymd: string) {
  const { y, m, d } = splitYmd(ymd);
  return localDate(y, m, d).getDay() === 0;
}

function slotListForDay() {
  const out: string[] = [];
  for (let h = OPEN_HOUR; h < CLOSE_HOUR; h++) {
    for (let m = 0; m < 60; m += SLOT_INTERVAL) {
      out.push(`${pad2(h)}:${pad2(m)}`);
    }
  }
  return out;
}

function capacityOnlineLeft(reserved: number, walkins: number) {
  const effectiveWalkins = Math.max(0, walkins - WALKIN_BUFFER);
  return Math.max(0, MAX_SEATS_RESERVABLE - reserved - effectiveWalkins);
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
    .reduce((s: any, r: any) => s + r.guests, 0);
  const walkins = list
    .filter((r) => r.isWalkIn)
    .reduce((s: any, r: any) => s + r.guests, 0);
  return { reserved, walkins, total: reserved + walkins };
}

function slotDuration(_date: string, _time: string) {
  return RESERVATION_DURATION_MIN;
}

async function slotAllowed(date: string, time: string) {
  const norm = normalizeYmd(date);
  if (!norm) return { ok: false, reason: "Invalid date" };
  if (SUNDAY_CLOSED && isSunday(norm))
    return { ok: false, reason: "Closed on Sunday" };

  const start = localDateFrom(norm, time);
  if (isNaN(start.getTime())) return { ok: false, reason: "Invalid time" };
  const minutes = Math.max(SLOT_INTERVAL, slotDuration(norm, time));
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

  return { ok: true, norm, start, end, open, close, minutes };
}

function loyaltyDiscountFor(visit: number): number {
  if (visit >= 15) return 15;
  if (visit >= 10) return 10;
  if (visit >= 5) return 5;
  return 0;
}
function loyaltyTeaseNext(visit: number): 0 | 5 | 10 | 15 {
  if (visit === 4) return 5;
  if (visit === 9) return 10;
  if (visit === 14) return 15;
  return 0;
}
function loyaltyUnlockedNow(visit: number): 0 | 5 | 10 | 15 {
  if (visit === 5) return 5;
  if (visit === 10) return 10;
  if (visit === 15) return 15;
  return 0;
}
function ordinal(n: number) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  const u = n % 10;
  if (u === 1) return `${n}st`;
  if (u === 2) return `${n}nd`;
  if (u === 3) return `${n}rd`;
  return `${n}th`;
}

function emailHeader(logoUrl: string) {
  if (MAIL_HEADER_URL) {
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:0">
          <img src="${MAIL_HEADER_URL}" alt="${BRAND_NAME}"
               style="display:block;width:100%;max-width:640px;height:auto;border:0;outline:none;">
        </td></tr>
      </table>`;
  }
  return `
    <div style="max-width:640px;margin:0 auto 10px auto;padding:28px 0;background:
      radial-gradient(ellipse at center, rgba(179,130,47,0.18) 0%, rgba(179,130,47,0.08) 40%, rgba(255,255,255,0) 72%);
      text-align:center;">
      <img src="${logoUrl}" alt="${BRAND_NAME}" style="width:190px;height:auto;border:0;outline:none;" />
    </div>`;
}

function confirmationHtml(p: {
  firstName: string;
  name: string;
  date: string;
  time: string;
  guests: number;
  cancelUrl: string;
  visitNo: number;
  currentDiscount: number;
}) {
  const header = emailHeader(MAIL_LOGO_URL);
  let reward = "";
  if (p.currentDiscount === 15) {
    reward = `<div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 Thank you so much! 🎉</div>
        <div style="font-size:16px;">From now on you enjoy a <b style="color:#b3822f;">15% loyalty thank-you</b>.</div>
      </div>`;
  } else if (p.currentDiscount === 10) {
    reward = `<div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 Great news! 🎉</div>
        <div style="font-size:16px;">From now on you enjoy a <b style="color:#b3822f;">10% loyalty thank-you</b>.</div>
      </div>`;
  } else if (p.currentDiscount === 5) {
    reward = `<div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 You made our day! 🎉</div>
        <div style="font-size:16px;">From now on you enjoy a <b style="color:#b3822f;">5% loyalty thank-you</b>.</div>
      </div>`;
  }

  const tease = loyaltyTeaseNext(p.visitNo);
  const teaser = tease
    ? `<div style="margin:16px 0;padding:12px 14px;background:#eef7ff;border:1px solid #cfe3ff;border-radius:10px;text-align:center;">
      <div style="font-size:18px;margin-bottom:6px;">Heads-up ✨</div>
      <div style="font-size:15px;">On your next visit you will receive a <b>${tease}% loyalty thank-you</b>.</div>
    </div>`
    : "";

  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 14px 0;">Your Reservation at ${BRAND_NAME}</h2>
    <p>Hi ${p.firstName} ${p.name},</p>
    <p>Thank you for your reservation. We look forward to welcoming you.</p>

    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Date</b> ${p.date}</p>
      <p style="margin:0;"><b>Time</b> ${p.time}</p>
      <p style="margin:0;"><b>Guests</b> ${p.guests}</p>
      <p style="margin:0;"><b>Address</b> ${VENUE_ADDRESS}</p>
    </div>

    <p style="margin:10px 0 0 0;text-align:center;opacity:.95;">This is your <b>${ordinal(
      p.visitNo
    )}</b> visit.</p>

    ${reward}
    ${teaser}

    <div style="margin-top:14px;padding:12px 14px;background:#fdeee9;border:1px solid #f3d0c7;border-radius:10px;">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>

    <p style="margin-top:18px;text-align:center;">
      <a href="${p.cancelUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Cancel reservation</a>
    </p>
    <p style="margin-top:16px;font-size:14px;text-align:center;">Warm regards from <b>${BRAND_NAME}</b></p>
  </div>`;
}

function canceledGuestHtml(p: {
  firstName: string;
  name: string;
  date: string;
  time: string;
  guests: number;
  rebookUrl: string;
}) {
  const header = emailHeader(MAIL_LOGO_URL);
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 14px 0;">We’ll miss you this round 😢</h2>
    <p>Hi ${p.firstName} ${p.name},</p>
    <p>Your reservation for <b>${p.guests}</b> on <b>${p.date}</b> at <b>${p.time}</b> has been canceled.</p>
    <p style="text-align:center;margin:16px 0;">
      <a href="${p.rebookUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Book your comeback</a>
    </p>
    <p>With warm regards,<br/><b>${BRAND_NAME}</b></p>
  </div>`;
}

function canceledAdminHtml(p: {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  guests: number;
  date: string;
  time: string;
  notes: string;
}) {
  const header = emailHeader(MAIL_LOGO_URL);
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 8px 0;">Reservation canceled</h2>
    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Guest</b> ${p.firstName} ${p.lastName} (${p.email})</p>
      <p style="margin:0;"><b>Phone</b> ${p.phone || "-"}</p>
      <p style="margin:0;"><b>Date</b> ${p.date} &nbsp; <b>Time</b> ${p.time}</p>
      <p style="margin:0;"><b>Guests</b> ${p.guests}</p>
      <p style="margin:0;"><b>Notes</b> ${p.notes || "-"}</p>
    </div>
    <p style="text-align:center;margin-top:10px;"><b>${BRAND_NAME}</b></p>
  </div>`;
}

app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) =>
  res.sendFile(path.join(publicDir, "admin.html"))
);

app.get("/api/config", (_req, res) => {
  res.json({
    brand: BRAND_NAME,
    address: VENUE_ADDRESS,
    phone: VENUE_PHONE,
    email: VENUE_EMAIL,
    maxOnlineGuests: MAX_ONLINE_GUESTS,
    mailLogoUrl: MAIL_LOGO_URL,
    mailHeaderUrl: MAIL_HEADER_URL,
  });
});

app.get("/api/slots", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  const guests = Number(req.query.guests || 1);
  if (!date) return res.json([]);

  const times = slotListForDay();
  const out: any[] = [];
  let anyOpen = false;
  for (const t of times) {
    const allow = await slotAllowed(date, t);
    if (!allow.ok) {
      out.push({
        time: t,
        canReserve: false,
        allowed: false,
        reason: allow.reason,
        left: 0,
      });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const leftOnline = capacityOnlineLeft(sums.reserved, sums.walkins);
    const canReserve =
      leftOnline >= guests && sums.total + guests <= MAX_SEATS_TOTAL;
    if (canReserve) anyOpen = true;
    out.push({
      time: t,
      canReserve,
      allowed: canReserve,
      reason: canReserve ? null : "Fully booked",
      left: leftOnline,
    });
  }

  if (!anyOpen && out.length > 0) {
    const sunday = SUNDAY_CLOSED && isSunday(date);
    if (sunday) {
      out.forEach((s) => (s.reason = "Closed on Sunday"));
    } else {
      out.forEach((s) => {
        if (s.reason === "Blocked" || s.reason == null) {
          s.reason =
            "Fully booked for this date. Please choose another day.";
        }
      });
    }
  }

  res.json(out);
});

app.post("/api/reservations", async (req, res) => {
  try {
    const { date, time, firstName, name, email, phone, guests, notes } =
      req.body;
    const g = Number(guests || 0);
    if (!date || !time || !firstName || !name || !email || !g || g < 1)
      return res.status(400).json({ error: "Missing or invalid fields" });
    if (g > MAX_ONLINE_GUESTS)
      return res.status(400).json({
        error: `Online bookings are limited to ${MAX_ONLINE_GUESTS} guests. Please contact us directly.`,
      });

    const allow = await slotAllowed(String(date), String(time));
    if (!allow.ok)
      return res
        .status(400)
        .json({ error: allow.reason || "Not available" });

    const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
    const leftOnline = capacityOnlineLeft(sums.reserved, sums.walkins);
    if (g > leftOnline)
      return res
        .status(400)
        .json({ error: "Fully booked at this time. Please select another slot." });
    if (sums.total + g > MAX_SEATS_TOTAL)
      return res
        .status(400)
        .json({ error: "Total capacity reached at this time." });

    const token = generateId();
    const created = await prisma.reservation.create({
      data: {
        date: allow.norm!,
        time,
        startTs: allow.start!,
        endTs: allow.end!,
        firstName,
        name,
        email,
        phone: String(phone || ""),
        guests: g,
        notes: String(notes || ""),
        status: "confirmed",
        cancelToken: token,
        isWalkIn: false,
      },
    });

    // Admin Info: ensure restaurant/admin address receives a well formatted notification
    try {
      // collect unique recipients (ADMIN_TO, VENUE_EMAIL and EXTRA_ADMIN_EMAIL)
      const recipients = Array.from(
        new Set([ADMIN_TO, VENUE_EMAIL, EXTRA_ADMIN_EMAIL].filter(Boolean))
      );
      if (recipients.length > 0) {
        const aHtml = `
          <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28;">
            <div style="max-width:640px;margin:0 auto;padding:10px 0;">
              <h3 style="margin:0 0 8px 0;">New reservation — ${BRAND_NAME}</h3>
              <div style="background:#f7efe2;padding:12px;border-radius:8px;border:1px solid #ead6b6;">
                <p style="margin:6px 0;"><strong>Date</strong> ${created.date}</p>
                <p style="margin:6px 0;"><strong>Time</strong> ${created.time}</p>
                <p style="margin:6px 0;"><strong>Guests</strong> ${created.guests}</p>
                <p style="margin:6px 0;"><strong>Guest</strong> ${created.firstName} ${created.name}</p>
                <p style="margin:6px 0;"><strong>Email</strong> ${created.email || '-'}</p>
                <p style="margin:6px 0;"><strong>Phone</strong> ${created.phone || '-'}</p>
                <p style="margin:6px 0;"><strong>Notes</strong> ${created.notes || '-'}</p>
              </div>
              <p style="margin-top:10px;font-size:13px;color:#6b5b4a;">This is an automated notification.</p>
            </div>
          </div>
        `;
        await Promise.all(
          recipients.map((to) =>
            sendMail(
              to,
              `[NEW] ${created.date} ${created.time} — ${created.guests}p`,
              aHtml
            )
          )
        );
      }
    } catch (e) {
      console.error("admin mail failed", e);
    }

    // Loyalty
    const visitNo = await prisma.reservation.count({
      where: { email: created.email, status: { in: ["confirmed", "noshow"] } },
    });
    const currentDiscount = loyaltyDiscountFor(visitNo);
    const unlocked = loyaltyUnlockedNow(visitNo);
    const teaseNext = loyaltyTeaseNext(visitNo);

    const cancelUrl = `${BASE_URL}/cancel/${token}`;
    const html = confirmationHtml({
      firstName: created.firstName,
      name: created.name,
      date: created.date,
      time: created.time,
      guests: created.guests,
      cancelUrl,
      visitNo,
      currentDiscount,
    });
    try {
      await sendMail(created.email, `${BRAND_NAME} — Reservation`, html);
    } catch (e) {
      console.error("mail guest", e);
    }

// admin mail (legacy) – nur senden, wenn ADMIN_TO nicht schon oben enthalten war
if (
  ADMIN_TO &&
  ADMIN_TO !== VENUE_EMAIL &&
  ADMIN_TO !== EXTRA_ADMIN_EMAIL
) {
  const aHtml = `<div style="font-family:Georgia,serif;color:#3a2f28">
    <p><b>New reservation</b></p>
    <p>${created.date} ${created.time} — ${created.guests}p — ${created.firstName} ${created.name} (${created.email})</p>
  </div>`;
  try {
    await sendMail(
      ADMIN_TO,
      `[NEW] ${created.date} ${created.time} — ${created.guests}p`,
      aHtml
    );
  } catch (e) {
    console.error("admin mail failed", e);
  }
}


    const showLoyaltyPopup = visitNo >= 5;
    const loyaltyPopupHtml = showLoyaltyPopup
      ? createLoyaltyPopupHtml(visitNo, currentDiscount)
      : null;

    res.json({
      ok: true,
      reservation: created,
      visitNo,
      discount: currentDiscount,
      nowUnlockedTier: unlocked,
      nextMilestone: teaseNext,
      showLoyaltyPopup,
      loyaltyPopupHtml,
    });
  } catch (err) {
    console.error("reservation error:", err);
    let details: string;
    if (err instanceof Error) {
      details = err.stack || err.message || String(err);
    } else {
      try {
        details = JSON.stringify(err);
      } catch {
        details = String(err);
      }
    }
    res.status(500).json({ error: "Failed to create reservation", details });
  }
});

function createLoyaltyPopupHtml(visitNo: number, discount: number) {
  const title =
    discount >= 15
      ? "Unbelievable — 15% for you!"
      : discount >= 10
      ? "Awesome — 10% for you!"
      : "Nice — 5% for you!";
  const message =
    discount >= 15
      ? `As of now you get ${discount}% off on every visit — thank you!`
      : `You've reached ${visitNo} visits — enjoy ${discount}% off on your next meal!`;
  return `
    <div style="font-family:Georgia,serif;color:#3a2f28;padding:18px;border-radius:12px;background:linear-gradient(180deg,#fffefc,#fff7ea);border:1px solid #ead6b6;max-width:640px;">
      <div style="font-size:22px;margin-bottom:8px;">${title}</div>
      <div style="font-size:15px;margin-bottom:12px;">${message}</div>
      <div style="font-size:13px;color:#6b5b4a;">Show this message at the host stand or mention your email to redeem</div>
    </div>`;
}

app.get("/cancel/:token", async (req, res) => {
  const r = await prisma.reservation.findUnique({
    where: { cancelToken: req.params.token },
  });
  if (!r) return res.status(404).send("Not found");
  const already = r.status === "canceled";
  if (!already) {
    await prisma.reservation.update({
      where: { id: r.id },
      data: { status: "canceled" },
    });
    if (r.email && r.email !== "walkin@noxama.local") {
      const gHtml = canceledGuestHtml({
        firstName: r.firstName,
        name: r.name,
        date: r.date,
        time: r.time,
        guests: r.guests,
        rebookUrl: `${BASE_URL}/`,
      });
      try {
        await sendMail(
          r.email,
          "We hope this goodbye is only for now 😢",
          gHtml
        );
      } catch {}
    }

    // Admin-Mail an alle konfigurierten Empfänger (ADMIN_TO, VENUE_EMAIL, EXTRA_ADMIN_EMAIL)
    {
      const aHtml = canceledAdminHtml({
        firstName: r.firstName,
        lastName: r.name,
        email: r.email || "",
        phone: r.phone || "",
        guests: r.guests,
        date: r.date,
        time: r.time,
        notes: r.notes || "",
      });

      const recipients = Array.from(
        new Set([ADMIN_TO, VENUE_EMAIL, EXTRA_ADMIN_EMAIL].filter(Boolean))
      );

      if (recipients.length) {
        try {
          await Promise.all(
            recipients.map((to) =>
              sendMail(
                to,
                `[CANCELED] ${r.date} ${r.time} — ${r.guests}p`,
                aHtml
              )
            )
          );
        } catch (e) {
          console.error("admin cancel mail failed", e);
        }
      }
    }
  }
  res.sendFile(path.join(publicDir, "cancelled.html"));
});

app.get("/api/admin/reservations", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  const view = String(req.query.view || "day");

  let list: any[] = [];
  if (view === "week" && date) {
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base);
    to.setDate(to.getDate() + 7);
    list = await prisma.reservation.findMany({
      where: { startTs: { gte: from, lt: to } },
      orderBy: [{ startTs: "asc" }, { date: "asc" }, { time: "asc" }],
    });
  } else if (view === "month" && date) {
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base);
    to.setMonth(to.getMonth() + 1);
    list = await prisma.reservation.findMany({
      where: { startTs: { gte: from, lt: to } },
      orderBy: [{ startTs: "asc" }, { date: "asc" }, { time: "asc" }],
    });
  } else {
    const where: any = date ? { date } : {};
    list = await prisma.reservation.findMany({
      where,
      orderBy: [{ date: "asc" }, { time: "asc" }],
    });
  }

  const emails = Array.from(
    new Set(list.map((r) => r.email).filter(Boolean))
  ) as string[];
  const counts = new Map<string, number>();
  await Promise.all(
    emails.map(async (em) => {
      const c = await prisma.reservation.count({
        where: { email: em, status: { in: ["confirmed", "noshow"] } },
      });
      counts.set(em, c);
    })
  );

  const enriched = list.map((r) => {
    const vc = r.email ? counts.get(r.email) || 0 : 0;
    const disc = loyaltyDiscountFor(vc);
    return { ...r, visitCount: vc, discount: disc };
  });

  res.json(enriched);
});
app.delete("/api/admin/reservations/:id", async (req, res) => {
  await prisma.reservation.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});
app.post("/api/admin/reservations/:id/noshow", async (req, res) => {
  const r = await prisma.reservation.update({
    where: { id: req.params.id },
    data: { status: "noshow" },
  });
  res.json(r);
});

app.post("/api/admin/walkin", async (req, res) => {
  try {
    const { date, time, guests, notes } = req.body;
    const g = Number(guests || 0);
    if (!date || !time || !g || g < 1)
      return res.status(400).json({ error: "Invalid input" });

    const norm = normalizeYmd(String(date));
    const allow = await slotAllowed(norm, String(time));

    let startTs: Date, endTs: Date, open: Date, close: Date;
    if (allow.ok) {
      startTs = allow.start!;
      endTs = allow.end!;
      open = allow.open!;
      close = allow.close!;
    } else {
      const start = localDateFrom(norm, String(time));
      const { y, m, d } = splitYmd(norm);
      open = localDate(y, m, d, OPEN_HOUR, 0, 0);
      close = localDate(y, m, d, CLOSE_HOUR, 0, 0);
      if (isNaN(start.getTime()) || start < open)
        return res.status(400).json({ error: "Slot not available." });
      const minutes = Math.max(
        15,
        Math.min(
          slotDuration(norm, String(time)),
          differenceInMinutes(close, start)
        )
      );
      startTs = start;
      endTs = addMinutes(start, minutes);
      if (endTs > close) endTs = close;
    }

    const sums = await sumsForInterval(norm, startTs, endTs);
    if (sums.total + g > MAX_SEATS_TOTAL)
      return res.status(400).json({ error: "Total capacity reached" });

    const r = await prisma.reservation.create({
      data: {
        date: norm,
        time: String(time),
        startTs,
        endTs,
        firstName: "Walk",
        name: "In",
        email: "walkin@noxama.local",
        phone: "",
        guests: g,
        notes: String(notes || ""),
        status: "confirmed",
        cancelToken: generateId(),
        isWalkIn: true,
      },
    });

    res.json(r);
  } catch (err) {
    console.error("walkin error:", err);
    res.status(500).json({ error: "Failed to save walk-in" });
  }
});

app.post("/api/admin/closure", async (req, res) => {
  try {
    // Accept optional 'title' from admin UI. To avoid changing DB schema, we map title -> reason
    let { startTs, endTs, reason, title } = req.body;
    if (title && String(title).trim()) reason = String(title).trim();
    const s = new Date(String(startTs).replace(" ", "T"));
    const e = new Date(String(endTs).replace(" ", "T"));
    if (isNaN(s.getTime()) || isNaN(e.getTime()))
      return res.status(400).json({ error: "Invalid time range" });
    if (e <= s) return res.status(400).json({ error: "End must be after start" });
    const c = await prisma.closure.create({
      data: { startTs: s, endTs: e, reason: String(reason || "Closed") },
    });
    res.json(c);
  } catch (err) {
    console.error("Create closure error:", err);
    res.status(500).json({ error: "Failed to create block" });
  }
});
app.post("/api/admin/closure/day", async (req, res) => {
  try {
    // Accept optional title; map to reason if provided
    let date = normalizeYmd(String(req.body.date || ""));
    const title = String(req.body.title || "").trim();
    let reason = String(req.body.reason || "Closed");
    if (title) reason = title;
    if (!date) return res.status(400).json({ error: "Invalid date" });
    const { y, m, d } = splitYmd(date);
    const s = localDate(y, m, d, OPEN_HOUR, 0, 0);
    const e = localDate(y, m, d, CLOSE_HOUR, 0, 0);
    const c = await prisma.closure.create({
      data: { startTs: s, endTs: e, reason },
    });
    res.json(c);
  } catch (err) {
    console.error("Block day error:", err);
    res.status(500).json({ error: "Failed to block day" });
  }
});
app.get("/api/admin/closure", async (_req, res) => {
  try {
    const list = await prisma.closure.findMany({ orderBy: { startTs: "desc" } });
    // Return title for compatibility with admin UI: title = reason
    const out = list.map((x) => ({ ...x, title: x.reason }));
    res.json(out);
  } catch (err) {
    console.error("List closure error:", err);
    res.status(500).json({ error: "Failed to load blocks" });
  }
});
app.delete("/api/admin/closure/:id", async (req, res) => {
  try {
    await prisma.closure.delete({ where: { id: req.params.id } });
    res.json({ ok: true });
  } catch (err) {
    console.error("Delete closure error:", err);
    res.status(500).json({ error: "Failed to delete block" });
  }
});

// ---- Simple persistent notices storage (file-based) ----
const NOTICES_FILE = path.join(publicDir, "notices.json");

async function readNoticesFile(): Promise<any[]> {
  try {
    if (!fs.existsSync(NOTICES_FILE)) {
      await writeFile(NOTICES_FILE, JSON.stringify([]), "utf8");
      return [];
    }
    const txt = await readFile(NOTICES_FILE, "utf8");
    return JSON.parse(txt || "[]");
  } catch (err) {
    console.error("readNoticesFile error", err);
    return [];
  }
}
async function writeNoticesFile(list: any[]) {
  try {
    await writeFile(NOTICES_FILE, JSON.stringify(list, null, 2), "utf8");
  } catch (err) {
    console.error("writeNoticesFile error", err);
  }
}

app.get("/api/admin/notice", async (_req, res) => {
  try {
    const list = await readNoticesFile();
    res.json(list);
  } catch (err) {
    console.error("GET /api/admin/notice error", err);
    res.status(500).json([]);
  }
});

app.post("/api/admin/notice", async (req, res) => {
  try {
    const { date, title, message } = req.body || {};
    if (!date || !message)
      return res.status(400).json({ error: "Missing date or message" });
    const list = await readNoticesFile();
    const id = `n_${Date.now().toString(36)}`;
    const rec = { id, date, title: title || "", message };
    list.push(rec);
    await writeNoticesFile(list);
    res.json(rec);
  } catch (err) {
    console.error("POST /api/admin/notice error", err);
    res.status(500).json({ error: "Failed to save notice" });
  }
});

app.delete("/api/admin/notice/:id", async (req, res) => {
  try {
    const id = String(req.params.id || "");
    let list = await readNoticesFile();
    const before = list.length;
    list = list.filter((x: any) => String(x.id) !== String(id));
    if (list.length === before) return res.status(404).json({ error: "Not found" });
    await writeNoticesFile(list);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/admin/notice/:id error", err);
    res.status(500).json({ error: "Failed to delete notice" });
  }
});

app.post("/api/admin/reset", async (req, res) => {
  try {
    const { key } = req.body || {};
    if (!ADMIN_RESET_KEY || key !== ADMIN_RESET_KEY)
      return res.status(403).json({ error: "Forbidden" });
    await prisma.reservation.deleteMany({});
    res.json({ ok: true });
  } catch (err) {
    console.error("reset error:", err);
    res.status(500).json({ error: "Failed to reset" });
  }
});

app.get("/api/export", async (req, res) => {
  try {
    const period = String(req.query.period || "weekly");
    const date = normalizeYmd(String(req.query.date || ""));
    const base = date ? new Date(date + "T00:00:00") : new Date();
    const from = new Date(base);
    const to = new Date(base);

    switch (period) {
      case "daily":
        to.setDate(to.getDate() + 1);
        break;
      case "weekly":
        to.setDate(to.getDate() + 7);
        break;
      case "monthly":
        to.setMonth(to.getMonth() + 1);
        break;
      case "yearly":
        to.setFullYear(to.getFullYear() + 1);
        break;
      default:
        to.setDate(to.getDate() + 7);
        break;
    }

    const list = await prisma.reservation.findMany({
      where: { startTs: { gte: from, lt: to } },
      orderBy: [{ startTs: "asc" }, { date: "asc" }, { time: "asc" }],
    });

    const rows = list.map((r) => ({
      Date: r.date,
      Time: r.time,
      FirstName: r.firstName,
      LastName: r.name,
      Email: r.email,
      Phone: r.phone || "",
      Guests: r.guests,
      Status: r.status,
      Notes: r.notes || "",
      WalkIn: r.isWalkIn ? "yes" : "",
      CreatedAt: r.createdAt ? format(r.createdAt, "yyyy-MM-dd HH:mm") : "",
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reservations");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const fname = `reservations_${format(from, "yyyyMMdd")}_${period}.xlsx`;
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${fname}"`
    );
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.send(buf);
  } catch (err) {
    console.error("Export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

setInterval(async () => {
  try {
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
      const html = confirmationHtml({
        firstName: r.firstName,
        name: r.name,
        date: r.date,
        time: r.time,
        guests: r.guests,
        cancelUrl: `${BASE_URL}/cancel/${r.cancelToken}`,
        visitNo: await prisma.reservation.count({
          where: { email: r.email, status: { in: ["confirmed", "noshow"] } },
        }),
        currentDiscount: 0,
      });
      try {
        await sendMail(r.email, `Reminder — ${BRAND_NAME}`, html);
        await prisma.reservation.update({
          where: { id: r.id },
          data: { reminderSent: true },
        });
      } catch (e) {
        console.error("reminder mail", e);
      }
    }
  } catch (e) {
    console.error("reminder job", e);
  }
}, 30 * 60 * 1000);

async function start() {
  await prisma.$connect();
  try {
    await transporter.verify();
  } catch (e) {
    console.warn("SMTP verify failed:", (e as Error).message);
  }
  app.listen(PORT, "0.0.0.0", () =>
    console.log(`Server running on ${PORT}`)
  );
}
start().catch((err) => {
  console.error("Fatal start error", err);
  process.exit(1);
});
