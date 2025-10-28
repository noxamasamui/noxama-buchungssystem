import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { addMinutes, addHours, format } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

// ---------------- Config ----------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "ROESTILAND BY NOXAMA SAMUI";

const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || 48);
const MAX_SEATS_RESERVABLE = Number(process.env.MAX_SEATS_RESERVABLE || 40);
const MAX_ONLINE_GUESTS = 10;

function hourFrom(v?: string, fb = 0) {
  if (!v) return fb;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fb;
}
const OPEN_HOUR = hourFrom(process.env.OPEN_HOUR || "10", 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || "22", 22);
const SUNDAY_CLOSED =
  String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// ---------------- Helpers ----------------
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  if (SUNDAY_CLOSED && isSundayYmd(norm)) return { ok: false, reason: "Closed on Sunday" };

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

async function sendEmailSMTP(to: string, subject: string, html: string) {
  await mailer().sendMail({ from: fromAddress(), to, subject, html });
}

// ---------------- Pages ----------------
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));

// ---------------- Public Config ----------------
app.get("/api/config", (_req, res) => {
  res.json({
    brand: BRAND_NAME,
    address: process.env.VENUE_ADDRESS || "",
    phone: process.env.VENUE_PHONE || "",
    email: process.env.VENUE_EMAIL || "",
  });
});

// ---------------- Slots API ----------------
app.get("/api/slots", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  if (!date) return res.json([]);
  const times = generateSlots(date, OPEN_HOUR, CLOSE_HOUR);
  const out: any[] = [];
  for (const t of times) {
    const allow = await slotAllowed(date, t);
    if (!allow.ok) {
      out.push({ time: t, allowed: false, reason: allow.reason, canReserve: false, left: 0 });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const left = Math.max(0, MAX_SEATS_RESERVABLE - sums.reserved);
    const canReserve = left > 0 && sums.total < MAX_SEATS_TOTAL;
    out.push({
      time: t,
      allowed: canReserve,
      reason: canReserve ? null : "Fully booked",
      canReserve,
      reserved: sums.reserved,
      total: sums.total,
      left,
    });
  }
  res.json(out);
});

// ---------------- Reservation API ----------------
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;
  const g = Number(guests);

  if (g > MAX_ONLINE_GUESTS) {
    return res.status(400).json({
      error: "Online bookings are limited to 10 guests. Please contact us directly.",
    });
  }

  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) return res.status(400).json({ error: allow.reason || "Not available" });

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + g > MAX_SEATS_RESERVABLE)
    return res.status(400).json({ error: "Fully booked at this time. Please select another slot." });
  if (sums.total + g > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "Fully booked at this time. Please select another slot." });

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

  // Visits for this guest (includes the created reservation)
  const visitCount = await prisma.reservation.count({
    where: { email: created.email, status: { in: ["confirmed", "noshow"] } },
  });

  const discount = discountForVisit(visitCount);
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
    await sendEmailSMTP(created.email, `${BRAND_NAME} — Reservation`, html);
  } catch (e) {
    console.error("Mail Error:", e);
  }

  res.json({ ok: true, reservation: created, visitCount, discount });
});

// ---------------- NEW: Walk-in API ----------------
app.post("/api/walkin", async (req, res) => {
  try {
    const { date, time, guests, notes } = req.body;
    const g = Number(guests || 0);
    if (!date || !time || !g || g < 1) return res.status(400).json({ error: "Invalid input" });

    const allow = await slotAllowed(String(date), String(time));
    if (!allow.ok) {
      const msg =
        allow.reason === "Blocked"
          ? "This date/time is blocked."
          : "Slot not available.";
      return res.status(400).json({ error: msg });
    }

    // Walk-ins zählen nur gegen die Gesamt-Kapazität
    const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
    if (sums.total + g > MAX_SEATS_TOTAL) {
      return res.status(400).json({ error: "Total capacity reached" });
    }

    const r = await prisma.reservation.create({
      data: {
        date: allow.norm!,
        time,
        startTs: allow.start!,
        endTs: allow.end!,
        firstName: "Walk",
        name: "In",
        email: "walkin@noxama.local",
        phone: "",
        guests: g,
        notes: String(notes || ""),
        status: "confirmed",
        cancelToken: nanoid(),
        isWalkIn: true,
      },
    });

    res.json(r);
  } catch (err) {
    console.error("walkin error:", err);
    res.status(500).json({ error: "Failed to save walk-in" });
  }
});

// ---------------- Cancel ----------------
app.get("/cancel/:token", async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { cancelToken: req.params.token } });
  if (!r) return res.status(404).send("Not found");
  await prisma.reservation.update({ where: { id: r.id }, data: { status: "canceled" } });
  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// ---------------- Admin List (with loyalty) ----------------
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

  // Count visits per email (confirmed + noshow)
  const emails = Array.from(new Set(list.map(r => r.email).filter(Boolean))) as string[];
  const counts = new Map<string, number>();
  await Promise.all(
    emails.map(async em => {
      const c = await prisma.reservation.count({
        where: { email: em, status: { in: ["confirmed", "noshow"] } },
      });
      counts.set(em, c);
    })
  );

  const withLoyalty = list.map(r => {
    const vc = counts.get(r.email || "") || 0;
    const d = discountForVisit(vc);
    return { ...r, visitCount: vc, discount: d };
  });

  res.json(withLoyalty);
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

// ---------------- Closures ----------------
app.post("/api/admin/closure", async (req, res) => {
  try {
    const { startTs, endTs, reason } = req.body;
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
    const date = normalizeYmd(String(req.body.date || ""));
    if (!date) return res.status(400).json({ error: "Invalid date" });
    const { y, m, d } = splitYmd(date);
    const s = localDate(y, m, d, OPEN_HOUR, 0, 0);
    const e = localDate(y, m, d, CLOSE_HOUR, 0, 0);
    const reason = String(req.body.reason || "Closed");
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
    res.json(list);
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

// ---------------- Export (Excel) ----------------
app.get("/api/export", async (req, res) => {
  try {
    const period = String(req.query.period || "weekly");
    const date = normalizeYmd(String(req.query.date || ""));
    const base = date ? new Date(date + "T00:00:00") : new Date();
    const from = new Date(base);
    const to = new Date(base);

    switch (period) {
      case "daily": to.setDate(to.getDate() + 1); break;
      case "weekly": to.setDate(to.getDate() + 7); break;
      case "monthly": to.setMonth(to.getMonth() + 1); break;
      case "yearly": to.setFullYear(to.getFullYear() + 1); break;
    }

    const list = await prisma.reservation.findMany({
      where: { startTs: { gte: from, lt: to } },
      orderBy: [{ startTs: "asc" }, { date: "asc" }, { time: "asc" }],
    });

    const prog = new Map<string, number>();
    const rows = list.map(r => {
      const key = (r.email || "").toLowerCase();
      const prev = prog.get(key) || 0;
      const isCountable = r.status === "confirmed" || r.status === "noshow";
      const nowCount = isCountable ? prev + 1 : prev;
      prog.set(key, nowCount);

      const disc = discountForVisit(nowCount);

      return {
        Date: r.date,
        Time: r.time,
        Name: `${r.firstName} ${r.name}`,
        Email: r.email,
        Phone: r.phone || "",
        Guests: r.guests,
        Status: r.status,
        Notes: r.notes || "",
        WalkIn: r.isWalkIn ? "yes" : "",
        VisitCount: nowCount,
        "Discount%": disc,
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reservations");

    const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
    const fname = `reservations_${format(from, "yyyyMMdd")}_${period}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
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

// ---------------- Email template & helpers ----------------
function ordinalSuffix(n: number) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return "th";
  switch (n % 10) {
    case 1: return "st";
    case 2: return "nd";
    case 3: return "rd";
    default: return "th";
  }
}
function discountForVisit(visitCount: number): number {
  if (visitCount >= 15) return 15;  // 15+
  if (visitCount >= 10) return 10;  // 10..14
  if (visitCount >= 5)  return 5;   // 5..9
  return 0;
}
function teaserBox(title: string, line: string) {
  return `
  <div style="margin:16px 0;padding:12px 14px;background:#eef7ff;border:1px solid #cfe3ff;border-radius:10px;text-align:center;">
    <div style="font-size:18px;margin-bottom:6px;">${title} ✨</div>
    <div style="font-size:15px;">${line}</div>
  </div>`;
}
function nextMilestoneTeaser(visitCount: number): string {
  if (visitCount === 4)  return teaserBox("Heads-up","On your next visit you’ll receive a <b>5% loyalty thank-you</b>.");
  if (visitCount === 9)  return teaserBox("Almost there","On your next visit you’ll receive a <b>10% loyalty thank-you</b>.");
  if (visitCount === 14) return teaserBox("Big milestone ahead","From your next visit you’ll receive a <b>15% loyalty thank-you</b>.");
  return "";
}
function confirmationHtml(
  firstName: string,
  name: string,
  date: string,
  time: string,
  guests: number,
  cancelUrl: string,
  visitCount: number,
  currentDiscount: number
) {
  const logo = process.env.MAIL_LOGO_URL || "/logo.png";
  const site = BRAND_NAME;
  const suffix = ordinalSuffix(visitCount);

  const visitLine =
    visitCount < 5
      ? `<div style="margin-top:8px;font-size:14px;text-align:center;opacity:.9;">
           This is your <b>${visitCount}${suffix}</b> visit. Thank you for coming back to us.
         </div>`
      : `<div style="margin-top:8px;font-size:14px;text-align:center;opacity:.9;">
           This is your <b>${visitCount}${suffix}</b> visit.
         </div>`;

  let reward = "";
  if (currentDiscount === 15) {
    reward = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 A heartfelt thank-you! 🎉</div>
        <div style="font-size:16px;">As a token of appreciation for your continued support, you enjoy a <b style="color:#b3822f;">15% loyalty thank-you</b>.</div>
      </div>`;
  } else if (currentDiscount === 10) {
    reward = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 Thank you for coming back! 🎉</div>
        <div style="font-size:16px;">Your loyalty means the world to us — please enjoy a <b style="color:#b3822f;">10% loyalty thank-you</b>.</div>
      </div>`;
  } else if (currentDiscount === 5) {
    reward = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 You make our day! 🎉</div>
        <div style="font-size:16px;">We love welcoming you back — please enjoy a <b style="color:#b3822f;">5% loyalty thank-you</b>.</div>
      </div>`;
  }

  const teaser = nextMilestoneTeaser(visitCount);

  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    <div style="text-align:center;margin-bottom:10px;">
      <img src="${logo}" alt="Logo" style="width:150px;height:auto;"/>
    </div>
    <h2 style="text-align:center;margin:6px 0 14px 0;letter-spacing:.5px;">Your Reservation at ${site}</h2>

    <p style="font-size:16px;margin:0 0 10px 0;">Hi ${firstName} ${name},</p>
    <p style="font-size:16px;margin:0 0 12px 0;">Thank you for choosing <b>${site}</b>. We value loyalty deeply — regular guests are the heart of our little community.</p>

    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Date</b> ${date}</p>
      <p style="margin:0;"><b>Time</b> ${time}</p>
      <p style="margin:0;"><b>Guests</b> ${guests}</p>
    </div>

    ${visitLine}
    ${reward}
    ${teaser}

    <div style="margin-top:14px;padding:12px 14px;background:#fdeee9;border:1px solid #f3d0c7;border-radius:10px;">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>

    <p style="margin-top:18px;text-align:center;">
      <a href="${cancelUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Cancel reservation</a>
    </p>

    <p style="margin-top:16px;font-size:14px;text-align:center;">We can’t wait to welcome you!<br/><b>Warm greetings from ${site}</b></p>
  </div>`;
}

// ---------------- Reminders ----------------
setInterval(async () => {
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
      await prisma.reservation.update({ where: { id: r.id }, data: { reminderSent: true } });
    } catch (e) {
      console.error("Reminder mail error:", e);
    }
  }
}, 30 * 60 * 1000);

// ---------------- Start ----------------
async function start() {
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on ${PORT}`));
}
start().catch(err => {
  console.error("Fatal start error", err);
  process.exit(1);
});
