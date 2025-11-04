// src/server.ts  — ESM + Express + Prisma, v1-Layout kompatibel

import { fileURLToPath } from "url";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { customAlphabet } from "nanoid";
import { mailer, fromAddress } from "./mailsender.js";

dotenv.config();

// ESM __dirname
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// App / Prisma
const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

// Konfiguration (ENV)
const PORT = Number(process.env.PORT ?? 4020);
const BASE_URL =
  process.env.PUBLIC_BASE_URL || process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const VENUE_ADDRESS =
  process.env.VENUE_ADDRESS || "Moo 4 Lamai Beach, 84310 Suratthani, Thailand";
const VENUE_PHONE = process.env.VENUE_PHONE || "";
const VENUE_EMAIL = process.env.VENUE_EMAIL || "";
const VENUE_MAP_LINK =
  process.env.VENUE_MAP_LINK ||
  "https://maps.google.com/?q=Moo+4+Lamai+Beach,+84310+Suratthani";

const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || ""; // nur Headerbild ODER Logo nutzen
const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || "";     // wenn Header leer, wird Logo klein gezeigt

const ONLINE_SEATS_CAP = Number(process.env.ONLINE_SEATS_CAP || 40);

const OPEN_LUNCH_START = process.env.OPEN_LUNCH_START || "10:00";
const OPEN_LUNCH_END = process.env.OPEN_LUNCH_END || "16:30";
const OPEN_LUNCH_DURATION_MIN = Number(process.env.OPEN_LUNCH_DURATION_MIN || 90);

const OPEN_DINNER_START = process.env.OPEN_DINNER_START || "17:00";
const OPEN_DINNER_END = process.env.OPEN_DINNER_END || "22:00";
const OPEN_DINNER_DURATION_MIN = Number(process.env.OPEN_DINNER_DURATION_MIN || 90);

const ADMIN_KEY =
  (process.env.ADMIN_RESET_KEY || process.env.ADMIN_PASSWORD || "").trim();

const nanoid = customAlphabet("abcdefghijkmnpqrstuvwxyz123456789", 21);

// Helpers
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_KEY) return res.status(500).json({ error: "Admin key not set" });
  const k = String(req.headers["x-admin-key"] || req.query.key || "");
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}
function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}
function minToHm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
function windowSlots(startHm: string, endHm: string, duration: number): string[] {
  const s = hmToMin(startHm);
  const e = hmToMin(endHm);
  const out: string[] = [];
  for (let t = s; t + duration <= e; t += 15) out.push(minToHm(t));
  return out;
}
function dailySlots(): string[] {
  return [
    ...windowSlots(OPEN_LUNCH_START, OPEN_LUNCH_END, OPEN_LUNCH_DURATION_MIN),
    ...windowSlots(OPEN_DINNER_START, OPEN_DINNER_END, OPEN_DINNER_DURATION_MIN),
  ];
}
function isYmd(s: unknown): s is string {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function pickDurationMin(time: string): number {
  const t = hmToMin(time);
  const lunch = [hmToMin(OPEN_LUNCH_START), hmToMin(OPEN_LUNCH_END)];
  if (t >= lunch[0] && t + OPEN_LUNCH_DURATION_MIN <= lunch[1]) return OPEN_LUNCH_DURATION_MIN;
  return OPEN_DINNER_DURATION_MIN;
}
function buildStartEnd(date: string, time: string): { startTs: Date; endTs: Date } {
  const startTs = new Date(`${date}T${time}:00`);
  const endTs = new Date(startTs.getTime() + pickDurationMin(time) * 60_000);
  return { startTs, endTs };
}
function csv(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
type Loyalty = { level: 0 | 5 | 10 | 15; nextAt?: number; pastCount: number };
function calcLoyalty(pastCount: number): Loyalty {
  let level: 0 | 5 | 10 | 15 = 0;
  const nth = pastCount + 1;
  if (nth >= 15) level = 15;
  else if (nth >= 10) level = 10;
  else if (nth >= 5) level = 5;
  const nextAt = level === 15 ? undefined : level === 10 ? 15 : level === 5 ? 10 : 5;
  return { level, nextAt, pastCount };
}

// E-Mail Renderer (schlank, genau ein Bild oben)
function renderReservationEmail(
  meta: {
    brandName: string;
    venueAddress: string;
  },
  r: {
    date: string;
    time: string;
    guests: number;
    firstName: string;
    lastName: string;
    cancelToken: string;
  },
  loyalty: Loyalty
): { subject: string; html: string } {
  const subject = `Your Reservation at ${meta.brandName}`;
  const loyaltyHtml =
    loyalty.level > 0
      ? `<p><strong>Thank you for your loyalty!</strong><br/>You now enjoy a <strong>${loyalty.level}% Loyalty Discount</strong> for this and all future visits.</p>`
      : loyalty.nextAt
      ? `<p><strong>Thank you for your loyalty!</strong><br/>After <strong>${loyalty.nextAt}</strong> bookings you’ll enjoy a loyalty discount.</p>`
      : "";

  const cancelUrl = `${BASE_URL}/cancel?token=${encodeURIComponent(r.cancelToken)}`;

  const topImage = MAIL_HEADER_URL
    ? `<img src="${MAIL_HEADER_URL}" alt="" style="max-width:100%;display:block;margin:0 auto 12px"/>`
    : MAIL_LOGO_URL
    ? `<div style="text-align:center;margin:16px 0 8px"><img src="${MAIL_LOGO_URL}" alt="" style="height:56px"/></div>`
    : "";

  const html = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2b1a12;line-height:1.45">
    ${topImage}
    <h2 style="text-align:center;margin:8px 0 16px">Your Reservation at ${meta.brandName}</h2>
    <p>Hi ${csv(r.firstName)} ${csv(r.lastName)},</p>
    <p>Thank you for your reservation. We look forward to welcoming you.</p>
    <div style="background:#faefe6;border:1px solid #ead7c7;border-radius:12px;padding:12px 14px;margin:14px 0">
      <div><b>Date</b> ${r.date}</div>
      <div><b>Time</b> ${r.time}</div>
      <div><b>Guests</b> ${r.guests}</div>
      <div><b>Address</b> ${meta.venueAddress}</div>
    </div>
    ${loyaltyHtml}
    <div style="background:#fdeeea;border:1px solid #f4d6ce;border-radius:12px;padding:12px 14px;margin:14px 0">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>
    <div style="text-align:center;margin:18px 0">
      <a href="${cancelUrl}" style="background:#b6802a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;display:inline-block">Cancel reservation</a>
    </div>
    <p style="text-align:center">Warm regards from <b>${BRAND_NAME}</b></p>
  </div>`;
  return { subject, html };
}

/* ---------- Öffentliche API ---------- */

// Konfig (für Frontend)
app.get("/api/config", (_req, res) => {
  res.json({
    brandName: BRAND_NAME,
    baseUrl: BASE_URL,
    venueAddress: VENUE_ADDRESS,
    venuePhone: VENUE_PHONE,
    venueEmail: VENUE_EMAIL,
    venueMapLink: VENUE_MAP_LINK,
    onlineSeatsCap: ONLINE_SEATS_CAP,
    slots: dailySlots(),
  });
});

// Slots (mit Belegung)
app.get("/api/slots", async (req, res) => {
  const date = String(req.query.date || "");
  const guests = Number(req.query.guests || 2);
  if (!isYmd(date)) return res.status(400).json({ error: "Invalid date" });
  if (!Number.isFinite(guests) || guests < 1 || guests > 10)
    return res.status(400).json({ error: "Invalid guests" });

  const all = dailySlots();
  const list = await Promise.all(
    all.map(async (time) => {
      const agg = await prisma.reservation.aggregate({
        _sum: { guests: true },
        where: { date, time, status: { not: "canceled" } },
      });
      const taken = agg._sum.guests ?? 0;
      return { time, disabled: taken >= ONLINE_SEATS_CAP, taken, cap: ONLINE_SEATS_CAP };
    })
  );
  res.json(list);
});

// Buchen
app.post("/api/book", async (req, res) => {
  try {
    const { date, time, guests, firstName, name, email, phone, notes } = req.body || {};
    if (!isYmd(date) || typeof time !== "string") return res.status(400).json({ error: "Invalid data" });

    const g = Number(guests);
    if (!Number.isFinite(g) || g < 1 || g > 10) return res.status(400).json({ error: "Invalid guests" });
    if (!firstName || !name || !email) return res.status(400).json({ error: "Missing fields" });

    // Kapazität prüfen
    const agg = await prisma.reservation.aggregate({
      _sum: { guests: true },
      where: { date, time, status: { not: "canceled" } },
    });
    const already = agg._sum.guests ?? 0;
    if (already + g > ONLINE_SEATS_CAP) return res.status(409).json({ error: "Fully booked" });

    const { startTs, endTs } = buildStartEnd(date, time);

    const newRes = await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName: String(firstName),
        name: String(name),
        email: String(email),
        phone: phone ?? null,
        date,
        time,
        guests: g,
        notes: notes ?? null,
        status: "confirmed",
        isWalkIn: false,
        createdAt: new Date(),
        cancelToken: nanoid(),
        reminderSent: false,
        startTs,
        endTs,
      },
    });

    // Loyalty ermitteln
    const pastCount = await prisma.reservation.count({
      where: {
        email: newRes.email,
        status: { not: "canceled" },
        createdAt: { lt: newRes.createdAt },
      },
    });
    const loyalty = calcLoyalty(pastCount);

    // Mail
    const { subject, html } = renderReservationEmail(
      { brandName: BRAND_NAME, venueAddress: VENUE_ADDRESS },
      {
        date: newRes.date,
        time: newRes.time,
        guests: newRes.guests,
        firstName: newRes.firstName,
        lastName: newRes.name,
        cancelToken: newRes.cancelToken,
      },
      loyalty
    );
    await mailer().sendMail({ from: fromAddress(), to: newRes.email, subject, html });

    res.json({
      ok: true,
      id: newRes.id,
      loyalty,
      nth: pastCount + 1, // für Fireworks
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Cancel
app.get("/cancel", async (req, res) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).send("Missing token");
  const r = await prisma.reservation.findFirst({ where: { cancelToken: token } });
  if (!r) return res.status(404).send("Not found");
  if (r.status !== "canceled") {
    await prisma.reservation.update({ where: { id: r.id }, data: { status: "canceled" } });
  }
  res.redirect("/cancelled.html");
});

/* ---------- Admin API ---------- */

// Liste
app.get("/api/admin/reservations", requireAdmin, async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: "Invalid range" });

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
  });
  const totalGuests = rows.reduce((s, r) => (r.status === "canceled" ? s : s + r.guests), 0);
  res.json({ rows, totalGuests, count: rows.length });
});

// Export
app.get("/api/admin/export.csv", requireAdmin, async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to)) return res.status(400).send("Invalid range");

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
  });

  const header = [
    "Date","Time","FirstName","LastName","Email","Phone","Guests","Status","Notes","WalkIn","CreatedAt"
  ].join(",");
  const body = rows.map(r=>[
    r.date,r.time,csv(r.firstName),csv(r.name),csv(r.email),csv(r.phone??""),String(r.guests),
    r.status,csv(r.notes??""),r.isWalkIn?"yes":"",r.createdAt.toISOString()
  ].join(",")).join("\n");

  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition",`attachment; filename="export_${from}_${to}.csv"`);
  res.send([header,body].join("\n"));
});

// Walk-in
app.post("/api/admin/walkin", requireAdmin, async (req, res) => {
  const { date, time, guests, notes } = req.body || {};
  if (!isYmd(date) || typeof time !== "string") return res.status(400).json({ error: "Invalid data" });
  const g = Number(guests || 2);
  if (!Number.isFinite(g) || g < 1 || g > 10) return res.status(400).json({ error: "Invalid guests" });

  const agg = await prisma.reservation.aggregate({
    _sum: { guests: true },
    where: { date, time, status: { not: "canceled" } },
  });
  const already = agg._sum.guests ?? 0;
  if (already + g > ONLINE_SEATS_CAP) return res.status(409).json({ error: "Fully booked" });

  const { startTs, endTs } = buildStartEnd(date, time);

  const r = await prisma.reservation.create({
    data: {
      id: nanoid(),
      firstName: "Walk",
      name: "In",
      email: "walkin@noxama.local",
      phone: null,
      date,
      time,
      guests: g,
      notes: notes ?? null,
      status: "confirmed",
      isWalkIn: true,
      createdAt: new Date(),
      cancelToken: nanoid(),
      reminderSent: false,
      startTs,
      endTs,
    },
  });

res.json({ ok: true, id: newRes.id, loyalty });

// Block Day (Platzhalter)
app.post("/api/admin/block-day", requireAdmin, async (req, res) => {
  const { day, reason } = req.body || {};
  if (!isYmd(day)) return res.status(400).json({ error: "Invalid day" });

  const slots = dailySlots();
  let created = 0;
  for (const time of slots) {
    const exist = await prisma.reservation.findFirst({
      where: { date: day, time, email: "block@noxama.local", status: { not: "canceled" } },
      select: { id: true },
    });
    if (exist) continue;
    const { startTs, endTs } = buildStartEnd(day, time);
    await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName: "Closed",
        name: String(reason || "Closed / Private event"),
        email: "block@noxama.local",
        phone: null,
        date: day,
        time,
        guests: ONLINE_SEATS_CAP,
        notes: "BLOCK_PLACEHOLDER",
        status: "confirmed",
        isWalkIn: true,
        createdAt: new Date(),
        cancelToken: nanoid(),
        reminderSent: false,
        startTs,
        endTs,
      },
    });
    created++;
  }
  res.json({ ok: true, created });
});
app.delete("/api/admin/block-day", requireAdmin, async (req, res) => {
  const day = String(req.query.day || "");
  if (!isYmd(day)) return res.status(400).json({ error: "Invalid day" });
  const del = await prisma.reservation.deleteMany({
    where: { date: day, email: "block@noxama.local" },
  });
  res.json({ ok: true, deleted: del.count });
});

/* ---------- Pages ---------- */
app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});
app.get("/admin", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/admin.html"));
});
app.get("/cancelled.html", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/cancelled.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
