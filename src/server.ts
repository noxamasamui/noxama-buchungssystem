// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { addMinutes, addHours, format } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

// -------------------- App / Prisma / Static --------------------
const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

// -------------------- Config --------------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "info@noxamasamui.com").trim();

const OPEN_HOUR = numFromHH(process.env.OPEN_HOUR, 10);
const CLOSE_HOUR = numFromHH(process.env.CLOSE_HOUR, 22);
const SUNDAY_CLOSED =
  String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

const MAX_SEATS_TOTAL = Number(
  process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48
);
const MAX_SEATS_RESERVABLE = Number(
  process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40
);

// E-Mail Theme (nur für Mails!)
const EMAIL_BG = "#d6c7b2";
const EMAIL_PANEL = "#fff6ee";
const EMAIL_MUTED = "#ead9c9";
const EMAIL_BANNER =
  process.env.MAIL_BANNER_URL || "https://i.imgur.com/LQ4nzwd.png";

// -------------------- helpers --------------------
function numFromHH(v: string | undefined, fb: number) {
  if (!v) return fb;
  const n = Number(String(v).split(":")[0]);
  return Number.isFinite(n) ? n : fb;
}

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
  const walkins = list.filter((r) => r.isWalkIn).reduce((s, r) => s + r.guests, 0);
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
  if (end > close) return { ok: false, reason: "After closing time" };

  const blocked = await prisma.closure.findFirst({
    where: { AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }] },
  });
  if (blocked) return { ok: false, reason: "Blocked" };

  return { ok: true, start, end, minutes, norm };
}

// -------------------- mail helpers --------------------
async function sendMail(to: string, subject: string, html: string) {
  await mailer().sendMail({
    from: fromAddress(),
    to,
    subject,
    html,
  });
}

function loyaltyBlock(visits: number) {
  // 5–9 = 5%, 10–14 = 10%, 15+ = 15%
  let line = "";
  if (visits >= 15) {
    line =
      `<div style="padding:12px 14px;border-radius:8px;background:${EMAIL_MUTED};margin-top:8px">` +
      `<b>Your loyalty means the world to us — enjoy 15% loyalty thank-you.</b>` +
      `</div>`;
  } else if (visits >= 10) {
    line =
      `<div style="padding:12px 14px;border-radius:8px;background:${EMAIL_MUTED};margin-top:8px">` +
      `<b>Your loyalty means the world to us — enjoy 10% loyalty thank-you.</b>` +
      `</div>`;
  } else if (visits >= 5) {
    line =
      `<div style="padding:12px 14px;border-radius:8px;background:${EMAIL_MUTED};margin-top:8px">` +
      `<b>Your loyalty means the world to us — enjoy 5% loyalty thank-you.</b>` +
      `</div>`;
  } else if (visits === 4) {
    line =
      `<div style="padding:12px 14px;border-radius:8px;background:${EMAIL_MUTED};margin-top:8px">` +
      `One more visit to unlock <b>5% loyalty</b> on your next bill.</div>`;
  } else if (visits === 9) {
    line =
      `<div style="padding:12px 14px;border-radius:8px;background:${EMAIL_MUTED};margin-top:8px">` +
      `Next visit is your <b>10% loyalty</b> milestone.</div>`;
  } else if (visits === 14) {
    line =
      `<div style="padding:12px 14px;border-radius:8px;background:${EMAIL_MUTED};margin-top:8px">` +
      `Next visit reaches <b>15% loyalty</b> forever.</div>`;
  }
  return line;
}

function emailShell(inner: string) {
  return `
  <div style="background:${EMAIL_BG};padding:0;margin:0">
    <div style="max-width:720px;margin:0 auto;background:${EMAIL_PANEL};box-shadow:0 6px 24px rgba(0,0,0,.08)">
      <img src="${EMAIL_BANNER}" alt="Banner" style="display:block;width:100%;height:auto;border:0;"/>
      <div style="padding:24px 22px;font-family:Georgia,'Times New Roman',serif;color:#3a2f28;line-height:1.45">
        ${inner}
      </div>
    </div>
  </div>`;
}

function reservationHtml(args: {
  firstName: string;
  name: string;
  date: string;
  time: string;
  guests: number;
  visits: number;
  cancelUrl: string;
}) {
  const { firstName, name, date, time, guests, visits, cancelUrl } = args;

  const body = `
  <h2 style="margin:0 0 14px 0">Your Reservation at ${BRAND}</h2>
  <p>Hi ${firstName} ${name},</p>
  <p>Thank you for choosing <b>${BRAND}</b>. We value loyalty deeply — regular guests are the heart of our little community.</p>

  <div style="background:#f3e6d9;border-radius:10px;padding:12px 14px;margin:14px 0">
    <div><b>Date</b><br>${date}</div>
    <div style="margin-top:8px"><b>Time</b><br>${time}</div>
    <div style="margin-top:8px"><b>Guests</b><br>${guests}</div>
  </div>

  <div style="margin:10px 0 2px 0;">This is your <b>${visits}th</b> visit.</div>
  ${loyaltyBlock(visits)}

  <div style="padding:12px 14px;border-radius:10px;background:#f7efe7;margin:16px 0">
    <b>Punctuality</b><br/>
    Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
  </div>

  <p style="margin-top:18px">
    <a href="${cancelUrl}" style="display:inline-block;padding:10px 14px;background:#7b5b33;color:#fff;border-radius:8px;text-decoration:none">Cancel reservation</a>
  </p>

  <p style="font-size:13px;color:#6d594a">If the button doesn’t work, copy this link:<br/>${cancelUrl}</p>

  <p style="margin-top:16px">We can’t wait to welcome you!<br/><b>Warm greetings from ${BRAND}</b></p>
  `;
  return emailShell(body);
}

function cancelHtmlGuest(args: {
  firstName: string;
  name: string;
  guests: number;
  date: string;
  time: string;
}) {
  const { firstName, name, guests, date, time } = args;
  const body = `
  <h2 style="margin:0 0 14px 0">We’ll miss you this round 😢</h2>
  <p>Hi ${firstName} ${name},</p>
  <p>Your reservation for <b>${guests}</b> on <b>${date}</b> at <b>${time}</b> has been canceled.</p>
  <p>We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
  <p style="margin-top:18px">
    <a href="${BASE_URL}" style="display:inline-block;padding:10px 14px;background:#7b5b33;color:#fff;border-radius:8px;text-decoration:none">Book your comeback</a>
  </p>
  <p style="margin-top:16px"><b>Warm greetings from ${BRAND}</b></p>`;
  return emailShell(body);
}

function cancelHtmlAdmin(args: {
  firstName: string;
  name: string;
  email: string;
  phone?: string | null;
  guests: number;
  date: string;
  time: string;
  visits: number;
  notes?: string | null;
}) {
  const { firstName, name, email, phone, guests, date, time, visits, notes } =
    args;
  const body = `
  <h2 style="margin:0 0 14px 0">Reservation canceled 😢</h2>
  <div style="background:#f3e6d9;border-radius:10px;padding:12px 14px;margin:14px 0">
    <div><b>Guest</b><br/>${firstName} ${name} (${email})</div>
    <div style="margin-top:8px"><b>Phone</b><br/>${phone || "-"}</div>
    <div style="margin-top:8px"><b>Date</b> ${date} &nbsp;&nbsp; <b>Time</b> ${time}</div>
    <div style="margin-top:8px"><b>Guests</b> ${guests}</div>
    <div style="margin-top:8px"><b>Total past visits</b> ${visits}</div>
    <div style="margin-top:8px"><b>Notes</b> ${notes || "-"}</div>
  </div>
  <p><b>${BRAND}</b></p>`;
  return emailShell(body);
}

// -------------------- pages --------------------
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));

// -------------------- health --------------------
app.get("/__health/email", async (_req, res) => {
  try {
    await verifyMailer();
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
});

// -------------------- config for client --------------------
app.get("/api/config", (_req, res) => {
  res.json({
    brand: BRAND,
    address: process.env.VENUE_ADDRESS || "",
    phone: process.env.VENUE_PHONE || "",
    email: process.env.VENUE_EMAIL || "",
  });
});

// -------------------- slots --------------------
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

// -------------------- reservations --------------------
app.post("/api/reservations", async (req: Request, res: Response) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;

  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    const r =
      allow.reason === "Blocked"
        ? "We are fully booked on this day. Please choose another day."
        : allow.reason === "Closed on Sunday"
        ? "We are closed on Sundays."
        : allow.reason === "Before opening hours" ||
          allow.reason === "After closing time"
        ? "This time is outside our opening hours."
        : "This slot is not available.";
    return res.status(400).json({ error: r });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE) {
    return res.status(400).json({
      error:
        "We are fully booked at that time. Please select another time or day.",
    });
  }
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL) {
    return res.status(400).json({
      error:
        "We are at capacity at that time. Please select another time or day.",
    });
  }
  if (Number(guests) > 10) {
    return res.status(400).json({
      error:
        "Online bookings are limited to 10 guests. For larger groups please call or email us.",
    });
  }

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

  const visits = await prisma.reservation.count({
    where: {
      email: created.email,
      status: { in: ["confirmed", "noshow"] },
      id: { not: created.id },
    },
  });
  const cancelUrl = `${BASE_URL}/cancel/${token}`;

  // send to guest
  try {
    await sendMail(
      created.email,
      `${BRAND} — Reservation`,
      reservationHtml({
        firstName: created.firstName,
        name: created.name,
        date: created.date,
        time: created.time,
        guests: created.guests,
        visits: visits + 1,
        cancelUrl,
      })
    );
  } catch (e) {
    console.error("send guest confirmation failed:", e);
  }

  // FYI to admin only if different address
  if (
    ADMIN_EMAIL &&
    ADMIN_EMAIL.toLowerCase() !== created.email.toLowerCase()
  ) {
    try {
      await sendMail(
        ADMIN_EMAIL,
        `New reservation — ${created.date} ${created.time} — ${created.guests}p`,
        emailShell(
          `<p>A guest just booked a table.</p>
           <div style="background:#f3e6d9;border-radius:10px;padding:12px 14px;margin:14px 0">
             <div><b>Guest</b> ${created.firstName} ${created.name} (${created.email})</div>
             <div style="margin-top:8px"><b>Phone</b> ${created.phone || "-"}</div>
             <div style="margin-top:8px"><b>Date</b> ${created.date} &nbsp;&nbsp; <b>Time</b> ${created.time}</div>
             <div style="margin-top:8px"><b>Guests</b> ${created.guests}</div>
             <div style="margin-top:8px"><b>Total past visits</b> ${visits + 1}</div>
             <div style="margin-top:8px"><b>Notes</b> ${created.notes || "-"}</div>
           </div>
           <p><b>${BRAND}</b></p>`
        )
      );
    } catch (e) {
      console.error("send admin FYI failed:", e);
    }
  }

  res.json({ ok: true, reservation: created });
});

// -------------------- walk-in --------------------
app.post("/api/walkin", async (req, res) => {
  const { date, time, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    const msg =
      allow.reason === "Blocked"
        ? "Closed on this day."
        : "Slot not available.";
    return res.status(400).json({ error: msg });
  }
  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "Total seats are full." });

  const r = await prisma.reservation.create({
    data: {
      date: allow.norm!,
      time,
      startTs: allow.start!,
      endTs: allow.end!,
      firstName: "Walk",
      name: "In",
      email: "walkin@noxama.local",
      guests: Number(guests),
      notes,
      status: "confirmed",
      cancelToken: nanoid(),
      isWalkIn: true,
    },
  });
  res.json(r);
});

// -------------------- admin list/actions --------------------
app.get("/api/admin/reservations", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  const view = String(req.query.view || "day");
  if (view === "week" && date) {
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base);
    to.setDate(to.getDate() + 7);
    const list = await prisma.reservation.findMany({
      where: { startTs: { gte: from }, endTs: { lt: to } },
      orderBy: [{ date: "asc" }, { time: "asc" }],
    });
    return res.json(list);
  }
  const where: any = date ? { date } : {};
  const list = await prisma.reservation.findMany({
    where,
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
  res.json(list);
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

// -------------------- closures --------------------
app.post("/api/admin/closure", async (req, res) => {
  const { startTs, endTs, reason } = req.body;
  const s = new Date(String(startTs).replace(" ", "T"));
  const e = new Date(String(endTs).replace(" ", "T"));
  if (isNaN(s.getTime()) || isNaN(e.getTime()))
    return res.status(400).json({ error: "Invalid times" });
  if (e <= s) return res.status(400).json({ error: "Start after end" });
  const c = await prisma.closure.create({
    data: { startTs: s, endTs: e, reason: String(reason || "Closed") },
  });
  res.json(c);
});

app.post("/api/admin/closure/day", async (req, res) => {
  const date = normalizeYmd(String(req.body.date || ""));
  if (!date) return res.status(400).json({ error: "Invalid date" });
  const { y, m, d } = splitYmd(date);
  const s = localDate(y, m, d, OPEN_HOUR, 0, 0);
  const e = localDate(y, m, d, CLOSE_HOUR, 0, 0);
  const c = await prisma.closure.create({
    data: { startTs: s, endTs: e, reason: String(req.body.reason || "Closed") },
  });
  res.json(c);
});

// -------------------- export --------------------
app.get("/api/export", async (req, res) => {
  const period = String(req.query.period || "daily");
  const norm = normalizeYmd(
    String(req.query.date || format(new Date(), "yyyy-MM-dd"))
  );
  const base = new Date(norm + "T00:00:00");
  const start = new Date(base),
    end = new Date(base);
  if (period === "daily") end.setDate(end.getDate() + 1);
  else if (period === "weekly") end.setDate(end.getDate() + 7);
  else if (period === "monthly") end.setMonth(end.getMonth() + 1);
  else if (period === "yearly") end.setFullYear(end.getFullYear() + 1);

  const list = await prisma.reservation.findMany({
    where: { startTs: { gte: start }, endTs: { lt: end } },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });

  const rows = list.map((r: any) => {
    const visits = Math.max(
      1,
      list.filter(
        (x: any) =>
          x.email === r.email &&
          x.status !== "canceled" &&
          x.startTs <= r.startTs
      ).length
    );
    const discount =
      visits >= 15 ? "15%" : visits >= 10 ? "10%" : visits >= 5 ? "5%" : "";
    return {
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
      VisitCountAtBooking: visits,
      LoyaltyDiscount: discount,
    };
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Reservations");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const fname = `export_${period}_${format(base, "yyyyMMdd")}.xlsx`;
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fname}"`
  );
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );
  res.send(buf);
});

// -------------------- cancel --------------------
app.get("/cancel/:token", async (req, res) => {
  const r = await prisma.reservation.findUnique({
    where: { cancelToken: req.params.token },
  });
  if (!r) return res.status(404).send("Not found");
  if (r.status !== "canceled") {
    await prisma.reservation.update({
      where: { id: r.id },
      data: { status: "canceled" },
    });

    const visits = await prisma.reservation.count({
      where: {
        email: r.email,
        status: { in: ["confirmed", "noshow"] },
        id: { not: r.id },
      },
    });

    // Mail to guest
    try {
      await sendMail(
        r.email,
        "We hope this goodbye is only for now 😢",
        cancelHtmlGuest({
          firstName: r.firstName,
          name: r.name,
          guests: r.guests,
          date: r.date,
          time: r.time,
        })
      );
    } catch (e) {
      console.error("cancel guest mail failed:", e);
    }

    // FYI admin (only if different)
    if (ADMIN_EMAIL && ADMIN_EMAIL.toLowerCase() !== r.email.toLowerCase()) {
      try {
        await sendMail(
          ADMIN_EMAIL,
          "Guest canceled reservation — FYI",
          cancelHtmlAdmin({
            firstName: r.firstName,
            name: r.name,
            email: r.email,
            phone: r.phone,
            guests: r.guests,
            date: r.date,
            time: r.time,
            visits,
            notes: r.notes,
          })
        );
      } catch (e) {
        console.error("cancel admin mail failed:", e);
      }
    }
  }
  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// -------------------- reminders (24h) --------------------
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
    const html = emailShell(`
      <h2 style="margin:0 0 14px 0">Friendly reminder</h2>
      <p>We look forward to seeing you tomorrow.</p>
      <div style="background:#f3e6d9;border-radius:10px;padding:12px 14px;margin:14px 0">
        <div><b>Date</b><br>${r.date}</div>
        <div style="margin-top:8px"><b>Time</b><br>${r.time}</div>
        <div style="margin-top:8px"><b>Guests</b><br>${r.guests}</div>
      </div>
      <p>If your plans change, please cancel in advance so we can free the table for others.</p>
      <p><b>${BRAND}</b></p>
    `);
    try {
      await sendMail(r.email, "Reservation reminder", html);
      await prisma.reservation.update({
        where: { id: r.id },
        data: { reminderSent: true },
      });
    } catch (e) {
      console.error("reminder mail failed:", e);
    }
  }
}
setInterval(sendReminders, 30 * 60 * 1000);

// -------------------- start --------------------
async function start() {
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", () =>
    console.log(`Server running on ${PORT}`)
  );
}
start().catch((e) => {
  console.error(e);
  process.exit(1);
});
