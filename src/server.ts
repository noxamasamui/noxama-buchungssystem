// src/server.ts
import { fileURLToPath } from "url";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { customAlphabet } from "nanoid";
import { mailer, fromAddress } from "./mailsender.js";

dotenv.config();

/* __dirname für ESM */
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

/* App / Prisma / Static */
const app    = express();
const prisma = new PrismaClient();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

const PORT  = Number(process.env.PORT ?? 4020);
const BASE  = process.env.PUBLIC_BASE_URL || process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME   = process.env.BRAND_NAME   || "RÖSTILAND BY NOXAMA SAMUI";
const VENUE_ADDR   = process.env.VENUE_ADDRESS|| "Moo 4 Lamai Beach, 84310 Suratthani, Thailand";
const VENUE_PHONE  = process.env.VENUE_PHONE  || "";
const VENUE_EMAIL  = process.env.VENUE_EMAIL  || "";
const MAIL_HEADER  = process.env.MAIL_HEADER_URL || null;
const MAIL_LOGO    = process.env.MAIL_LOGO_URL   || null;

const ONLINE_SEATS_CAP = Number(process.env.ONLINE_SEATS_CAP || 40);

const OPEN_LUNCH_START        = process.env.OPEN_LUNCH_START || "10:00";
const OPEN_LUNCH_END          = process.env.OPEN_LUNCH_END   || "16:30";
const OPEN_LUNCH_DURATION_MIN = Number(process.env.OPEN_LUNCH_DURATION_MIN || 90);

const OPEN_DINNER_START        = process.env.OPEN_DINNER_START || "17:00";
const OPEN_DINNER_END          = process.env.OPEN_DINNER_END   || "22:00";
const OPEN_DINNER_DURATION_MIN = Number(process.env.OPEN_DINNER_DURATION_MIN || 90);

const ADMIN_KEY = (process.env.ADMIN_RESET_KEY || process.env.ADMIN_PASSWORD || "").trim();

const nanoid = customAlphabet("abcdefghijkmnpqrstuvwxyz123456789", 21);

/* Helpers */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const dangerOnly = req.headers["x-danger"] === "1";
  if (dangerOnly) {
    // Danger Zone: Key MUSS vorhanden sein
    const k = String(req.headers["x-admin-key"] || req.query.key || "");
    if (!ADMIN_KEY || k !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
    return next();
  }
  // normale Admin-Ansicht darf ohne Key gelesen werden
  return next();
}

function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map(Number);
  return h * 60 + m;
}
function minToHm(min: number): string {
  const h = Math.floor(min / 60); const m = min % 60;
  return `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
}
function windowSlots(startHm: string, endHm: string, duration: number): string[] {
  const s = hmToMin(startHm), e = hmToMin(endHm); const out: string[] = [];
  for (let t=s; t+duration<=e; t+=15) out.push(minToHm(t));
  return out;
}
function dailySlots(): string[] {
  return [
    ...windowSlots(OPEN_LUNCH_START,  OPEN_LUNCH_END,  OPEN_LUNCH_DURATION_MIN),
    ...windowSlots(OPEN_DINNER_START, OPEN_DINNER_END, OPEN_DINNER_DURATION_MIN),
  ];
}
function isYmd(s: string){ return /^\d{4}-\d{2}-\d{2}$/.test(s); }
function pickDurationMin(time: string){
  const t = hmToMin(time);
  const lunch = [hmToMin(OPEN_LUNCH_START), hmToMin(OPEN_LUNCH_END)];
  if (t >= lunch[0] && t + OPEN_LUNCH_DURATION_MIN <= lunch[1]) return OPEN_LUNCH_DURATION_MIN;
  return OPEN_DINNER_DURATION_MIN;
}
function buildStartEnd(date: string, time: string){
  const startTs = new Date(`${date}T${time}:00`);
  const endTs = new Date(startTs.getTime() + pickDurationMin(time) * 60_000);
  return { startTs, endTs };
}

/* Loyalty */
type Loyalty = { level: 0|5|10|15; nextAt?: number; pastCount: number };
function calcLoyalty(pastCount: number): Loyalty {
  let level: 0|5|10|15 = 0;
  if (pastCount + 1 >= 15) level = 15;
  else if (pastCount + 1 >= 10) level = 10;
  else if (pastCount + 1 >= 5) level = 5;
  const nextAt = level === 15 ? undefined : level === 10 ? 15 : level === 5 ? 10 : 5;
  return { level, nextAt, pastCount };
}

/* Mail */
function renderReservationEmail(
  meta: { brandName: string; baseUrl: string; mailHeaderUrl: string|null; mailLogoUrl: string|null; },
  r: { date: string; time: string; guests: number; firstName: string; name: string; cancelToken: string; loyalty?: Loyalty }
){
  const subject = `Your Reservation at ${meta.brandName}`;
  const loyaltyBlock = r.loyalty && r.loyalty.level>0
    ? `<p><strong>Thank you for your loyalty!</strong><br/>You now enjoy a <strong>${r.loyalty.level}% Loyalty Discount</strong>.</p>`
    : r.loyalty && r.loyalty.nextAt
      ? `<p><strong>Thank you for your loyalty!</strong><br/>After <strong>${r.loyalty.nextAt}</strong> bookings you’ll enjoy a loyalty discount.</p>` : "";

  const cancelLink = `${BASE}/cancel?token=${encodeURIComponent(r.cancelToken)}`;
  const html = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2b1a12">
    ${meta.mailHeaderUrl ? `<img src="${meta.mailHeaderUrl}" style="max-width:100%;display:block;margin:0 auto 16px"/>` : ""}
    ${meta.mailLogoUrl   ? `<div style="text-align:center;margin:8px 0"><img src="${meta.mailLogoUrl}" height="56"/></div>` : ""}
    <h2 style="text-align:center;margin:16px 0 8px">Your Reservation at ${meta.brandName}</h2>

    <div style="background:#faefe6;border-radius:10px;padding:12px 14px;margin:12px 0;border:1px solid #ead7c7">
      <div><b>Date</b> ${r.date}</div>
      <div><b>Time</b> ${r.time}</div>
      <div><b>Guests</b> ${r.guests}</div>
      <div><b>Address</b> ${VENUE_ADDR}</div>
    </div>

    ${loyaltyBlock}

    <div style="background:#fdeeea;border-radius:10px;padding:12px 14px;margin:12px 0;border:1px solid #f4d6ce">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>

    <div style="text-align:center;margin:20px 0">
      <a href="${cancelLink}" style="background:#b6802a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;display:inline-block">Cancel reservation</a>
    </div>

    <p style="text-align:center">Warm regards from <b>${BRAND_NAME}</b></p>
  </div>`;
  return { subject, html };
}

/* Public */
app.get("/api/slots", async (req, res) => {
  const date   = String(req.query.date || "");
  const guests = Number(req.query.guests || 2);
  if (!isYmd(date)) return res.status(400).json({ error: "Invalid date" });
  if (!Number.isFinite(guests) || guests<1 || guests>10) return res.status(400).json({ error: "Invalid guests" });

  const all = dailySlots();
  const list = await Promise.all(all.map(async (time) => {
    const agg = await prisma.reservation.aggregate({
      _sum: { guests: true },
      where: { date, time, status: { not: "canceled" } }, // "no_show" zählt weiter als belegt
    });
    const taken = agg._sum.guests ?? 0;
    return { time, disabled: taken >= ONLINE_SEATS_CAP, taken, cap: ONLINE_SEATS_CAP };
  }));
  res.json(list);
});

app.post("/api/book", async (req, res) => {
  try {
    const { date, time, guests, firstName, name, email, phone, notes } = req.body || {};
    if (!isYmd(String(date))) return res.status(400).json({ error: "Invalid date" });

    const slots = dailySlots();
    if (!slots.includes(String(time))) return res.status(400).json({ error: "Invalid time" });

    const g = Number(guests);
    if (!Number.isFinite(g) || g<1 || g>10) return res.status(400).json({ error: "Invalid guests" });

    if (!firstName || !name || !email) return res.status(400).json({ error: "Missing fields" });

    const sum = await prisma.reservation.aggregate({
      _sum: { guests: true },
      where: { date, time, status: { not: "canceled" } },
    });
    if ((sum._sum.guests ?? 0) + g > ONLINE_SEATS_CAP) return res.status(409).json({ error: "Fully booked" });

    const { startTs, endTs } = buildStartEnd(String(date), String(time));
    const created = await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName: String(firstName),
        name: String(name),
        email: String(email),
        phone: phone ?? null,
        date: String(date),
        time: String(time),
        guests: g,
        notes: notes ?? null,
        status: "confirmed",
        isWalkIn: false,
        createdAt: new Date(),
        cancelToken: nanoid(),
        reminderSent: false,
        startTs, endTs
      }
    });

    const pastCount = await prisma.reservation.count({
      where: { email: created.email, status: { not: "canceled" }, createdAt: { lt: created.createdAt } }
    });
    const loyalty = calcLoyalty(pastCount);

    const { subject, html } = renderReservationEmail(
      { brandName: BRAND_NAME, baseUrl: BASE, mailHeaderUrl: MAIL_HEADER, mailLogoUrl: MAIL_LOGO },
      { date: created.date, time: created.time, guests: created.guests, firstName: created.firstName, name: created.name, cancelToken: created.cancelToken, loyalty }
    );

    await mailer().sendMail({ from: fromAddress(), to: created.email, subject, html });
    res.json({ ok: true, id: created.id, loyalty });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

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

/* Notices (Spezial-Events) */
app.get("/api/notice", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: "Invalid date" });

    const startOfDay = new Date(`${date}T00:00:00`);
    const endOfDay   = new Date(`${date}T23:59:59`);

    const n = await prisma.notice.findFirst({
      where: { startTs: { lte: endOfDay }, endTs: { gte: startOfDay } },
      orderBy: { startTs: "desc" },
    });

    if (!n) return res.json(null);
    return res.json({ message: n.message, requireAck: n.requireAck });
  } catch (e: any) {
    // P2022 / fehlende Spalten/Tabelle: bis Migration da ist, still null zurück
    if (e?.code === "P2022" || e?.code === "P2021") {
      return res.json(null);
    }
    console.error(e);
    return res.status(500).json({ error: "Server error" });
  }
});


/* ---------- ADMIN (Lesen ohne Key; Danger-Zone mit Key) ---------- */

// Liste (kein Key nötig)
app.get("/api/admin/reservations", requireAdmin, async (req, res) => {
  const from = String(req.query.from || "");
  const to   = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: "Invalid range" });

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
  });
  res.json({ rows, total: rows.length });
});

app.get("/api/admin/export.csv", requireAdmin, async (req, res) => {
  const from = String(req.query.from || ""); const to = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to)) return res.status(400).send("Invalid range");
  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
  });
  const header = "Date,Time,FirstName,LastName,Email,Phone,Guests,Status,Notes,WalkIn,CreatedAt";
  const body = rows.map(r => [
    r.date, r.time, csv(r.firstName), csv(r.name), csv(r.email), csv(r.phone ?? ""),
    String(r.guests), r.status, csv(r.notes ?? ""), r.isWalkIn ? "yes":"", r.createdAt.toISOString()
  ].join(",")).join("\n");
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="export_${from}_${to}.csv"`);
  res.send([header, body].join("\n"));
});

function csv(s: string){ return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; }

/* Admin Status setzen / löschen (Danger-Zone -> Header x-danger: 1 + x-admin-key) */
app.patch("/api/admin/reservations/:id/status", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  const status = String(req.body?.status || "");
  if (!["confirmed","canceled","no_show"].includes(status)) return res.status(400).json({ error: "Bad status" });
  const r = await prisma.reservation.update({ where: { id }, data: { status: status as any } });
  res.json({ ok: true, id: r.id, status: r.status });
});

app.delete("/api/admin/reservations/:id", requireAdmin, async (req, res) => {
  const id = String(req.params.id || "");
  await prisma.reservation.delete({ where: { id } });
  res.json({ ok: true, id });
});

/* Walk-in (keine Danger; normaler Admin-Use) */
app.post("/api/admin/walkin", requireAdmin, async (req, res) => {
  const { date, time, guests, notes } = req.body || {};
  if (!isYmd(String(date))) return res.status(400).json({ error: "Invalid date" });
  const slots = dailySlots();
  if (!slots.includes(String(time))) return res.status(400).json({ error: "Invalid time" });
  const g = Number(guests || 2);
  if (!Number.isFinite(g) || g<1 || g>10) return res.status(400).json({ error: "Invalid guests" });

  const sum = await prisma.reservation.aggregate({
    _sum: { guests: true },
    where: { date, time, status: { not: "canceled" } }
  });
  if ((sum._sum.guests ?? 0) + g > ONLINE_SEATS_CAP) return res.status(409).json({ error: "Fully booked" });

  const { startTs, endTs } = buildStartEnd(String(date), String(time));
  const r = await prisma.reservation.create({
    data: {
      id: nanoid(),
      firstName: "Walk",
      name: "In",
      email: "walkin@noxama.local",
      phone: null,
      date: String(date),
      time: String(time),
      guests: g,
      notes: notes ?? null,
      status: "confirmed",
      isWalkIn: true,
      createdAt: new Date(),
      cancelToken: nanoid(),
      reminderSent: false,
      startTs, endTs
    }
  });
  res.json({ ok: true, id: r.id });
});

/* Block day (Danger-Zone -> benötigt Key) */
app.post("/api/admin/block-day", requireAdmin, async (req, res) => {
  const { day, reason } = req.body || {};
  if (!isYmd(String(day))) return res.status(400).json({ error: "Invalid day" });

  const slots = dailySlots();
  let created = 0;
  for (const time of slots) {
    const existing = await prisma.reservation.findFirst({
      where: { date: day, time, email: "block@noxama.local", status: { not: "canceled" } },
      select: { id: true }
    });
    if (existing) continue;
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
        startTs, endTs
      }
    });
    created++;
  }
  res.json({ ok: true, created });
});

app.delete("/api/admin/block-day", requireAdmin, async (req, res) => {
  const day = String(req.query.day || "");
  if (!isYmd(day)) return res.status(400).json({ error: "Invalid day" });
  const del = await prisma.reservation.deleteMany({
    where: { date: day, email: "block@noxama.local" }
  });
  res.json({ ok: true, deleted: del.count });
});

/* Fallback + Start */
app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
