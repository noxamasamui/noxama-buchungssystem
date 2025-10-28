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
//  Configuration
// ------------------------------------------------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTINALND BY NOXAMA SAMUI";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_EMAIL =
  process.env.MAIL_FROM_ADDRESS ||
  process.env.SMTP_USER ||
  "info@noxamasamui.com";

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";

// Seating logic
const MAX_SEATS_TOTAL = Number(
  process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48
);
const MAX_SEATS_RESERVABLE = Number(
  process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40
);

// Opening hours
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
//  Helper functions
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
    .filter(r => !r.isWalkIn)
    .reduce((s, r) => s + r.guests, 0);
  const walkins = list
    .filter(r => r.isWalkIn)
    .reduce((s, r) => s + r.guests, 0);
  return { reserved, walkins, total: reserved + walkins };
}

async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok: false, reason: "Invalid time" };
  if (SUNDAY_CLOSED && isSundayYmd(norm))
    return { ok: false, reason: "Closed on Sunday" };

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

// Loyalty: discount by visit count
function discountFromCount(n: number): number {
  if (n >= 15) return 15;
  if (n >= 5) return 10;
  if (n >= 3) return 5;
  return 0;
}

// ------------------------------------------------------
//  Email via SMTP
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
//  Pages
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
//  Public Config
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
        left: 0,
      });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const left =
      Math.min(MAX_SEATS_RESERVABLE, MAX_SEATS_TOTAL) - sums.total;
    const canReserve = left > 0;
    out.push({
      time: t,
      allowed: true,
      reason: null,
      minutes: allow.minutes,
      canReserve,
      reserved: sums.reserved,
      walkins: sums.walkins,
      total: sums.total,
      left,
    });
  }
  res.json(out);
});

// ------------------------------------------------------
//  Reservations
// ------------------------------------------------------
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;

  const GUEST_CAP = 10;
  const g = Number(guests);
  if (g > GUEST_CAP) {
    const contact = `${process.env.VENUE_EMAIL || FROM_EMAIL}${
      process.env.VENUE_PHONE ? " or " + process.env.VENUE_PHONE : ""
    }`;
    return res.status(400).json({
      error: `Online bookings are limited to ${GUEST_CAP} guests. For larger groups, please contact us via ${contact}.`,
    });
  }

  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    return res.status(400).json({ error: allow.reason || "Not available" });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + g > MAX_SEATS_RESERVABLE)
    return res
      .status(400)
      .json({ error: "We are fully booked at this time. Please choose another slot." });
  if (sums.total + g > MAX_SEATS_TOTAL)
    return res
      .status(400)
      .json({ error: "We are fully booked at this time. Please choose another slot." });

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
      guests: g,
      notes,
      status: "confirmed",
      cancelToken: token,
      isWalkIn: false,
    },
  });

  // loyalty info
  const visitCount = await prisma.reservation.count({
    where: { email: created.email, status: { in: ["confirmed", "noshow"] } },
  });
  const discount = discountFromCount(visitCount);

  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const html = confirmationHtml(
    created.firstName,
    created.name,
    created.date,
    created.time,
    created.guests,
    cancelUrl,
    visitCount,
    discount
  );

  try {
    await sendEmailSMTP(created.email, `${BRAND_NAME} — Reservation confirmed`, html);
  } catch (e) {
    console.error("Mail error:", e);
  }

  res.json({ ok: true, reservation: created, visitCount, discount });
});

// ------------------------------------------------------
//  Cancel
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
  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// ------------------------------------------------------
//  Confirmation Email Template
// ------------------------------------------------------
function confirmationHtml(
  firstName: string,
  name: string,
  date: string,
  time: string,
  guests: number,
  cancelUrl: string,
  visitCount: number,
  discount: number
) {
  const logo = process.env.MAIL_LOGO_URL || "/logo.png";
  const site = BRAND_NAME;

  const loyaltyHtml =
    discount > 0
      ? `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;line-height:1.2;margin-bottom:6px;">🎉 <b>Fantastic news!</b> 🎉</div>
        <div style="font-size:16px;">
          This is your <b>${visitCount}${visitCount === 1 ? "st" : "th"}</b> visit.<br/>
          You’ve unlocked a <b style="color:#b3822f;">${discount}% loyalty discount</b> for your next reservation! 🥂
        </div>
      </div>`
      : `
      <div style="margin:16px 0 6px 0;font-size:15px;text-align:center;">
        You’ve visited us <b>${visitCount}</b> ${visitCount === 1 ? "time" : "times"} so far.
        After 3 visits you get <b>5%</b>, after 5 visits <b>10%</b> and after 15 visits <b>15%</b> off!
      </div>`;

  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    <div style="text-align:center;margin-bottom:10px;">
      <img src="${logo}" alt="Logo" style="width:150px;height:auto;"/>
    </div>

    <h2 style="text-align:center;margin:6px 0 14px 0;letter-spacing:.5px;">Your Reservation at ${site}</h2>

    <p style="font-size:16px;margin:0 0 10px 0;">Hi ${firstName} ${name},</p>
    <p style="font-size:16px;margin:0 0 12px 0;">Thank you for choosing <b>${site}</b>! We’ve saved your table:</p>

    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Date</b> ${date}</p>
      <p style="margin:0;"><b>Time</b> ${time}</p>
      <p style="margin:0;"><b>Guests</b> ${guests}</p>
    </div>

    ${loyaltyHtml}

    <div style="margin-top:14px;padding:12px 14px;background:#fdeee9;border:1px solid #f3d0c7;border-radius:10px;">
      <b>Punctuality</b><br/>
      Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>

    <p style="margin-top:18px;text-align:center;">
      <a href="${cancelUrl}"
         style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">
        Cancel reservation
      </a>
    </p>

    <p style="margin-top:16px;font-size:14px;text-align:center;">
      We can’t wait to welcome you!<br/><b>Warm greetings from ${site}</b>
    </p>
  </div>`;
}

// ------------------------------------------------------
//  Reminder Job
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
      <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28;">
        <p>Friendly reminder for your reservation tomorrow:</p>
        <p><b>Date</b> ${r.date} — <b>Time</b> ${r.time} — <b>Guests</b> ${r.guests}</p>
        <p>Please arrive on time — tables may be released after 15 minutes of delay.</p>
        <p>If your plans change, please cancel here:<br/><a href="${cancelUrl}">${cancelUrl}</a></p>
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
//  Start
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
