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
//  Helpers
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
  const walkins  = list.filter(r => r.isWalkIn).reduce((s, r) => s + r.guests, 0);
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

// ---------------- Loyalty mapping exactly per your spec ----------------
type Loyalty = { current: number; nextAt?: number; nextPercent?: number };
function loyaltyFromVisitCount(vc: number): Loyalty {
  // vc = total visits INCLUDING this newly created reservation
  if (vc >= 15) return { current: 15 };
  if (vc >= 10) return { current: 10, nextAt: 15, nextPercent: 15 }; // at 14 we'll show explicit hint in mail
  if (vc >= 5)  return { current: 5,  nextAt: 10, nextPercent: 10 }; // at 9 we'll show explicit hint
  // vc <= 4 -> still no discount; at 4 we hint next one
  return { current: 0, nextAt: 5, nextPercent: 5 };
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
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));

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
//  Slots (returns left; UI should gray out when left===0)
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
    const left = Math.max(0, MAX_SEATS_RESERVABLE - sums.reserved);
    const canReserve = left > 0 && sums.total < MAX_SEATS_TOTAL;

    if (!canReserve) {
      out.push({
        time: t,
        allowed: false,
        reason: "Fully booked",
        minutes: allow.minutes,
        canReserve: false,
        reserved: sums.reserved,
        walkins: sums.walkins,
        total: sums.total,
        left: 0,
      });
    } else {
      out.push({
        time: t,
        allowed: true,
        reason: null,
        minutes: allow.minutes,
        canReserve: true,
        reserved: sums.reserved,
        walkins: sums.walkins,
        total: sums.total,
        left,
      });
    }
  }
  res.json(out);
});

// ------------------------------------------------------
//  Reservations (cap 10; loyalty messaging)
// ------------------------------------------------------
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;

  // hard cap per booking
  const GUEST_CAP = 10;
  const g = Number(guests);
  if (g > GUEST_CAP) {
    const contact = `${process.env.VENUE_EMAIL || FROM_EMAIL}${process.env.VENUE_PHONE ? " or " + process.env.VENUE_PHONE : ""}`;
    return res.status(400).json({
      error: `Online bookings are limited to ${GUEST_CAP} guests. For larger groups, please contact us via ${contact}.`,
    });
  }

  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    const msg =
      allow.reason === "Blocked" ? "We are closed at that time. Please pick a different day."
      : allow.reason === "Before opening hours" || allow.reason === "After closing hours" ? "This time is outside of our opening hours."
      : allow.reason === "Closed on Sunday" ? "We are closed on Sundays."
      : "This time slot is not available.";
    return res.status(400).json({ error: msg });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + g > MAX_SEATS_RESERVABLE)
    return res.status(400).json({ error: "We are fully booked at this time. Please choose another slot." });
  if (sums.total + g > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "We are fully booked at this time. Please choose another slot." });

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

  // loyalty info (including this visit)
  const visitCount = await prisma.reservation.count({
    where: { email: created.email, status: { in: ["confirmed", "noshow"] } },
  });
  const loyalty = loyaltyFromVisitCount(visitCount);
  const discount = loyalty.current;

  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const html = confirmationHtml(
    created.firstName,
    created.name,
    created.date,
    created.time,
    created.guests,
    cancelUrl,
    visitCount,
    loyalty
  );

  try {
    await sendEmailSMTP(created.email, `${BRAND_NAME} — Reservation confirmed`, html);
  } catch (e) {
    console.error("Mail error:", e);
  }

  res.json({ ok: true, reservation: created, visitCount, discount });
});

// ------------------------------------------------------
//  Admin: list + loyalty fields
// ------------------------------------------------------
app.get("/api/admin/reservations", async (req: Request, res: Response) => {
  const date = normalizeYmd(String(req.query.date || ""));
  const view = String(req.query.view || "day");

  let list: any[] = [];
  if (view === "week" && date) {
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base);
    to.setDate(to.getDate() + 7);
    list = await prisma.reservation.findMany({
      where: { startTs: { gte: from }, endTs: { lt: to } },
      orderBy: [{ date: "asc" }, { time: "asc" }],
    });
  } else {
    const where: any = date ? { date } : {};
    list = await prisma.reservation.findMany({
      where,
      orderBy: [{ date: "asc" }, { time: "asc" }],
    });
  }

  // collect distinct emails and count visits
  const emails = Array.from(new Set(list.map(r => r.email).filter(Boolean))) as string[];
  const counts = new Map<string, number>();
  await Promise.all(
    emails.map(async (em) => {
      const c = await prisma.reservation.count({
        where: { email: em, status: { in: ["confirmed", "noshow"] } },
      });
      counts.set(em, c);
    })
  );

  const withLoyalty = list.map(r => {
    const vc = counts.get(r.email || "") || 1;
    const d = loyaltyFromVisitCount(vc).current;
    return { ...r, visitCount: vc, discount: d };
  });

  res.json(withLoyalty);
});

// ------------------------------------------------------
//  Admin actions
// ------------------------------------------------------
app.delete("/api/admin/reservations/:id", async (req: Request, res: Response) => {
  await prisma.reservation.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

app.post("/api/admin/reservations/:id/noshow", async (req: Request, res: Response) => {
  const r = await prisma.reservation.update({
    where: { id: req.params.id },
    data: { status: "noshow" },
  });
  res.json(r);
});

// ------------------------------------------------------
//  Walk-in
// ------------------------------------------------------
app.post("/api/walkin", async (req: Request, res: Response) => {
  const { date, time, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) return res.status(400).json({ error: "This time is not available." });

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL) return res.status(400).json({ error: "We are full at that time." });

  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!, time, startTs: allow.start!, endTs: allow.end!,
      firstName: "Walk", name: "In", email: "walkin@noxama.local",
      guests: Number(guests), notes, status: "confirmed", cancelToken: nanoid(), isWalkIn: true,
    },
  });
  res.json(created);
});

// ------------------------------------------------------
//  Closures
// ------------------------------------------------------
app.post("/api/admin/closure", async (req: Request, res: Response) => {
  const { startTs, endTs, reason } = req.body;
  const s = new Date(String(startTs).replace(" ", "T"));
  const e = new Date(String(endTs).replace(" ", "T"));
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({ error: "Invalid time range" });
  if (e <= s) return res.status(400).json({ error: "End must be after start" });
  const c = await prisma.closure.create({ data: { startTs: s, endTs: e, reason: String(reason || "Closed") } });
  res.json(c);
});

app.post("/api/admin/closure/day", async (req: Request, res: Response) => {
  const date = normalizeYmd(String(req.body.date || ""));
  if (!date) return res.status(400).json({ error: "Invalid date" });
  const { y, m, d } = splitYmd(date);
  const s = localDate(y, m, d, OPEN_HOUR, 0, 0);
  const e = localDate(y, m, d, CLOSE_HOUR, 0, 0);
  const c = await prisma.closure.create({ data: { startTs: s, endTs: e, reason: String(req.body.reason || "Closed") } });
  res.json(c);
});

app.get("/api/admin/closure", async (_req: Request, res: Response) => {
  const list = await prisma.closure.findMany({ orderBy: { startTs: "desc" } });
  res.json(list);
});

app.delete("/api/admin/closure/:id", async (req: Request, res: Response) => {
  await prisma.closure.delete({ where: { id: req.params.id } });
  res.json({ ok: true });
});

// ------------------------------------------------------
//  Export (Excel)
// ------------------------------------------------------
app.get("/api/export", async (req: Request, res: Response) => {
  const period = String(req.query.period || "daily");
  const norm = normalizeYmd(
    String(req.query.date || format(new Date(), "yyyy-MM-dd"))
  );
  const base = new Date(norm + "T00:00:00");
  const start = new Date(base), end = new Date(base);
  if (period === "daily") end.setDate(end.getDate() + 1);
  else if (period === "weekly") end.setDate(end.getDate() + 7);
  else if (period === "monthly") end.setMonth(end.getMonth() + 1);
  else if (period === "yearly") end.setFullYear(end.getFullYear() + 1);

  const list = await prisma.reservation.findMany({
    where: { startTs: { gte: start }, endTs: { lt: end } },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });

  const rows = list.map((r: any) => ({
    Date: r.date,
    Time: r.time,
    DurationMin: (r.endTs.getTime() - r.startTs.getTime()) / 60000,
    FirstName: r.firstName,
    Name: r.name,
    Email: r.email,
    Phone: r.phone || "",
    Guests: r.guests,
    Status: r.status,
    Notes: r.notes || "",
    WalkIn: r.isWalkIn ? "yes" : "no",
  }));

  const wb = XLSX.utils.book_new();
  const ws1 = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws1, "Reservations");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const fname = `export_${period}_${format(base, "yyyyMMdd")}.xlsx`;
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ------------------------------------------------------
//  Cancel page
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
//  - celebratory
//  - punctuality note
//  - exact tier messages incl. "next visit" hints at 4, 9, 14
// ------------------------------------------------------
function confirmationHtml(
  firstName: string,
  name: string,
  date: string,
  time: string,
  guests: number,
  cancelUrl: string,
  visitCount: number,
  loyalty: Loyalty
) {
  const logo = process.env.MAIL_LOGO_URL || "/logo.png";
  const site = BRAND_NAME;

  // Compose loyalty block according to exact rules
  let loyaltyBlock = "";
  if (loyalty.current >= 15) {
    loyaltyBlock = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 <b>Legendary loyalty!</b> 🎉</div>
        <div style="font-size:16px;">You enjoy a <b style="color:#b3822f;">15% loyalty discount</b>. Thank you for being with us!</div>
      </div>`;
  } else if (loyalty.current >= 10) {
    const nextHint = visitCount === 14
      ? `<div style="margin-top:8px;font-size:14px;opacity:.8;">You’re one visit away from <b>15%</b> — starting with your next reservation.</div>`
      : "";
    loyaltyBlock = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 <b>Wonderful!</b> 🎉</div>
        <div style="font-size:16px;">You enjoy a <b style="color:#b3822f;">10% loyalty discount</b> on this reservation.</div>
        ${nextHint}
      </div>`;
  } else if (loyalty.current >= 5) {
    const nextHint = visitCount === 9
      ? `<div style="margin-top:8px;font-size:14px;opacity:.8;">You’re one visit away from <b>10%</b> — starting with your 10th reservation.</div>`
      : "";
    loyaltyBlock = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 <b>Great news!</b> 🎉</div>
        <div style="font-size:16px;">You enjoy a <b style="color:#b3822f;">5% loyalty discount</b> on this reservation.</div>
        ${nextHint}
      </div>`;
  } else {
    // current = 0; at vc=4 we show the "next will be 5%"
    const next5 = visitCount === 4
      ? `<div style="margin-top:8px;font-size:14px;opacity:.9;"><b>Almost there:</b> your next reservation will include <b>5% off</b>!</div>`
      : `<div style="margin-top:8px;font-size:14px;opacity:.85;">Collect visits to unlock rewards — 5% from your 5th visit, 10% from your 10th, and 15% from your 15th.</div>`;
    loyaltyBlock = `
      <div style="margin:16px 0 6px 0;text-align:center;">
        <div style="font-size:16px;">This is your <b>${visitCount}${visitCount === 1 ? "st" : "th"}</b> visit — thank you!</div>
        ${next5}
      </div>`;
  }

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

    ${loyaltyBlock}

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
      We can’t wait to celebrate with you!<br/><b>Warm greetings from ${site}</b>
    </p>
  </div>`;
}

// ------------------------------------------------------
//  Reminder Job (unchanged, with punctuality note)
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
