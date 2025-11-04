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

/* ----------------------------- ESM __dirname ----------------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ------------------------------ App/Prisma ------------------------------- */
const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

/* -------------------------------- Config -------------------------------- */
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

const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || null;
const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || null;

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

/* ------------------------------ Small utils ----------------------------- */
const qstr = (x: unknown): string => (x == null ? "" : String(x));

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_KEY) return res.status(500).json({ error: "Admin key not set" });
  const k = String(req.headers["x-admin-key"] || (req.query as any).key || "");
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map((v) => Number(v));
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
function pickDurationMin(time: string): number {
  const t = hmToMin(time);
  const lunch = [hmToMin(OPEN_LUNCH_START), hmToMin(OPEN_LUNCH_END)];
  if (t >= lunch[0] && t + OPEN_LUNCH_DURATION_MIN <= lunch[1]) {
    return OPEN_LUNCH_DURATION_MIN;
  }
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

/* --------------------------- Loyalty + Mail HTML ------------------------- */
type Loyalty = { level: 0 | 5 | 10 | 15; nextAt?: number; pastCount: number };

function calcLoyalty(pastCount: number): Loyalty {
  let level: 0 | 5 | 10 | 15 = 0;
  if (pastCount + 1 >= 15) level = 15;
  else if (pastCount + 1 >= 10) level = 10;
  else if (pastCount + 1 >= 5) level = 5;
  const nextAt = level === 15 ? undefined : level === 10 ? 15 : level === 5 ? 10 : 5;
  return { level, nextAt, pastCount };
}

function renderReservationEmail(
  meta: {
    brandName: string;
    baseUrl: string;
    mailHeaderUrl: string | null;
    mailLogoUrl: string | null;
    venueAddress: string;
  },
  r: {
    firstName: string;
    lastName: string;
    email: string;
    date: string;
    time: string;
    guests: number;
    cancelToken: string;
  },
  loyalty: Loyalty
): { subject: string; html: string } {
  const subject = `Your Reservation at ${meta.brandName}`;

  const loyaltyText =
    loyalty.level > 0
      ? `You now enjoy a <b>${loyalty.level}% Loyalty Discount</b> for this and all future visits.`
      : `After <b>${loyalty.nextAt}</b> bookings you’ll enjoy a loyalty discount.`;

  const ordinal = (n: number): string => {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  const bookingNo = ordinal(loyalty.pastCount + 1);

  const cancelLink = `${BASE_URL}/cancel?token=${encodeURIComponent(r.cancelToken)}`;
  const headerImg =
    MAIL_HEADER_URL
      ? `<img src="${MAIL_HEADER_URL}" alt="" style="max-width:680px;width:100%;height:auto;display:block;margin:0 auto 12px;border-radius:8px"/>`
      : MAIL_LOGO_URL
      ? `<div style="text-align:center;margin:4px 0 10px"><img src="${MAIL_LOGO_URL}" height="48" alt="Logo" style="display:inline-block"/></div>`
      : "";

  const html = `
  <div style="font:14px/1.45 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#261a12;background:#fff;padding:8px 0">
    <div style="text-align:center">${headerImg}</div>

    <h2 style="text-align:center;margin:8px 0 6px;font-size:18px;letter-spacing:.2px">
      Your Reservation at ${meta.brandName}
    </h2>
    <p style="text-align:center;margin:0 0 12px;font-size:12px;color:#6f5a4b">
      This is your <b>${bookingNo}</b> booking with us.
    </p>

    <p style="margin:10px 0">Hi ${csv(r.firstName)} ${csv(r.lastName)},</p>
    <p style="margin:8px 0">Thank you for your reservation. We look forward to welcoming you.</p>

    <div style="background:#faefe6;border-radius:10px;padding:10px 12px;margin:10px 0;border:1px solid #ead7c7">
      <div style="margin:1px 0"><b>Date</b> ${r.date}</div>
      <div style="margin:1px 0"><b>Time</b> ${r.time}</div>
      <div style="margin:1px 0"><b>Guests</b> ${r.guests}</div>
      <div style="margin:1px 0"><b>Address</b> ${VENUE_ADDRESS}</div>
    </div>

    <div style="background:#fff9e8;border-radius:10px;padding:8px 10px;margin:8px 0;border:1px solid #f3e6c8;font-size:13px">
      <b>Thanks for your loyalty.</b> ${loyaltyText}
    </div>

    <div style="background:#fdeeea;border-radius:10px;padding:8px 10px;margin:8px 0;border:1px solid #f4d6ce">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>

    <div style="text-align:center;margin:16px 0">
      <a href="${cancelLink}" style="background:#b6802a;color:#fff;text-decoration:none;padding:9px 14px;border-radius:10px;display:inline-block;font-size:14px">Cancel reservation</a>
    </div>

    <p style="text-align:center;margin-top:12px;font-size:13px">Warm regards from <b>${BRAND_NAME}</b></p>
  </div>
  `;
  return { subject, html };
}

/* --------------------------------- API ---------------------------------- */
// Public: Config
app.get("/api/config", (_req, res) => {
  res.json({
    brandName: BRAND_NAME,
    baseUrl: BASE_URL,
    venueAddress: VENUE_ADDRESS,
    venuePhone: VENUE_PHONE,
    venueEmail: VENUE_EMAIL,
    venueMapLink: VENUE_MAP_LINK,
    mailHeaderUrl: MAIL_HEADER_URL,
    mailLogoUrl: MAIL_LOGO_URL,
    onlineSeatsCap: ONLINE_SEATS_CAP,
  });
});

// Public: Slots (mit Überlappungsprüfung!)
app.get("/api/slots", async (req, res) => {
  const date = qstr((req.query as any).date);
  const guests = Number(qstr((req.query as any).guests) || "2");

  if (!isYmd(date)) return res.status(400).json({ error: "Invalid date" });
  if (!Number.isFinite(guests) || guests < 1 || guests > 10) {
    return res.status(400).json({ error: "Invalid guests" });
  }

  const all = dailySlots();

  const list = await Promise.all(
    all.map(async (time) => {
      const { startTs, endTs } = buildStartEnd(date, time);

      const agg = await prisma.reservation.aggregate({
        _sum: { guests: true },
        where: {
          status: { not: "canceled" },
          startTs: { lt: endTs },
          endTs: { gt: startTs },
        },
      });

      const taken = agg._sum.guests ?? 0;
      const disabled = taken >= ONLINE_SEATS_CAP;
      return { time, disabled, taken, cap: ONLINE_SEATS_CAP };
    })
  );

  res.json(list);
});

// Public: Book (mit Überlappungsprüfung!)
app.post("/api/book", async (req, res) => {
  try {
    const body = (req.body || {}) as any;
    const date = qstr(body.date);
    const time = qstr(body.time);
    const g = Number(qstr(body.guests) || "0");
    const firstName = qstr(body.firstName);
    const name = qstr(body.name);
    const email = qstr(body.email);
    const phone = body.phone ? qstr(body.phone) : null;
    const notes = body.notes ? qstr(body.notes) : null;

    if (!isYmd(date)) return res.status(400).json({ error: "Invalid date" });
    const slots = dailySlots();
    if (!slots.includes(time)) return res.status(400).json({ error: "Invalid time" });
    if (!Number.isFinite(g) || g < 1 || g > 10)
      return res.status(400).json({ error: "Invalid guests" });
    if (!firstName || !name || !email)
      return res.status(400).json({ error: "Missing fields" });

    const { startTs, endTs } = buildStartEnd(date, time);

    const agg = await prisma.reservation.aggregate({
      _sum: { guests: true },
      where: {
        status: { not: "canceled" },
        startTs: { lt: endTs },
        endTs: { gt: startTs },
      },
    });
    const already = agg._sum.guests ?? 0;
    if (already + g > ONLINE_SEATS_CAP) {
      return res.status(409).json({ error: "Fully booked" });
    }

    const newRes = await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName,
        name,
        email,
        phone,
        date,
        time,
        guests: g,
        notes,
        status: "confirmed",
        isWalkIn: false,
        createdAt: new Date(),
        cancelToken: nanoid(),
        reminderSent: false,
        startTs,
        endTs,
      },
    });

    const pastCount = await prisma.reservation.count({
      where: {
        email: newRes.email,
        status: { not: "canceled" },
        createdAt: { lt: newRes.createdAt },
      },
    });
    const loyalty = calcLoyalty(pastCount);

    const { subject, html } = renderReservationEmail(
      {
        brandName: BRAND_NAME,
        baseUrl: BASE_URL,
        mailHeaderUrl: MAIL_HEADER_URL,
        mailLogoUrl: MAIL_LOGO_URL,
        venueAddress: VENUE_ADDRESS,
      },
      {
        firstName: newRes.firstName,
        lastName: newRes.name,
        email: newRes.email,
        date: newRes.date,
        time: newRes.time,
        guests: newRes.guests,
        cancelToken: newRes.cancelToken,
      },
      loyalty
    );

    await mailer().sendMail({ from: fromAddress(), to: newRes.email, subject, html });

    res.json({ ok: true, id: newRes.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

// Public: Cancel
app.get("/cancel", async (req, res) => {
  const token = qstr((req.query as any).token);
  if (!token) return res.status(400).send("Missing token");
  const r = await prisma.reservation.findFirst({ where: { cancelToken: token } });
  if (!r) return res.status(404).send("Not found");
  if (r.status !== "canceled") {
    await prisma.reservation.update({ where: { id: r.id }, data: { status: "canceled" } });
  }
  res.redirect("/cancelled.html");
});

/* --------------------------------- Admin -------------------------------- */
// Liste
app.get("/api/admin/reservations", requireAdmin, async (req, res) => {
  const from = qstr((req.query as any).from);
  const to = qstr((req.query as any).to);
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: "Invalid range" });

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
  });

  res.json(rows);
});

// Export CSV
app.get("/api/admin/export.csv", requireAdmin, async (req, res) => {
  const from = qstr((req.query as any).from);
  const to = qstr((req.query as any).to);
  if (!isYmd(from) || !isYmd(to)) return res.status(400).send("Invalid range");

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
  });

  const header = [
    "Date",
    "Time",
    "FirstName",
    "LastName",
    "Email",
    "Phone",
    "Guests",
    "Status",
    "Notes",
    "WalkIn",
    "CreatedAt",
  ].join(",");

  const body = rows
    .map((r) =>
      [
        r.date,
        r.time,
        csv(r.firstName),
        csv(r.name),
        csv(r.email),
        csv(r.phone ?? ""),
        String(r.guests),
        r.status,
        csv(r.notes ?? ""),
        r.isWalkIn ? "yes" : "",
        r.createdAt.toISOString(),
      ].join(",")
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="export_${from}_${to}.csv"`);
  res.send([header, body].join("\n"));
});

// Walk-in
app.post("/api/admin/walkin", requireAdmin, async (req, res) => {
  const body = (req.body || {}) as any;
  const date = qstr(body.date);
  const time = qstr(body.time);
  const guests = Number(qstr(body.guests) || "2");
  const notes = body.notes ? qstr(body.notes) : null;

  if (!isYmd(date)) return res.status(400).json({ error: "Invalid date" });
  const slots = dailySlots();
  if (!slots.includes(time)) return res.status(400).json({ error: "Invalid time" });
  if (!Number.isFinite(guests) || guests < 1 || guests > 10)
    return res.status(400).json({ error: "Invalid guests" });

  const { startTs, endTs } = buildStartEnd(date, time);
  const agg = await prisma.reservation.aggregate({
    _sum: { guests: true },
    where: {
      status: { not: "canceled" },
      startTs: { lt: endTs },
      endTs: { gt: startTs },
    },
  });
  const already = agg._sum.guests ?? 0;
  if (already + guests > ONLINE_SEATS_CAP) {
    return res.status(409).json({ error: "Fully booked" });
  }

  const r = await prisma.reservation.create({
    data: {
      id: nanoid(),
      firstName: "Walk",
      name: "In",
      email: "walkin@noxama.local",
      phone: null,
      date,
      time,
      guests,
      notes,
      status: "confirmed",
      isWalkIn: true,
      createdAt: new Date(),
      cancelToken: nanoid(),
      reminderSent: false,
      startTs,
      endTs,
    },
  });

  res.json({ ok: true, id: r.id });
});

// Block day (erstellen)
app.post("/api/admin/block-day", requireAdmin, async (req, res) => {
  const body = (req.body || {}) as any;
  const day = qstr(body.day);
  const reason = qstr(body.reason || "Closed / Private event");
  if (!isYmd(day)) return res.status(400).json({ error: "Invalid day" });

  const slots = dailySlots();
  let created = 0;
  for (const time of slots) {
    const exists = await prisma.reservation.findFirst({
      where: { date: day, time, email: "block@noxama.local", status: { not: "canceled" } },
      select: { id: true },
    });
    if (exists) continue;

    const { startTs, endTs } = buildStartEnd(day, time);
    await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName: "Closed",
        name: reason,
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

// Block day (entfernen)
app.delete("/api/admin/block-day", requireAdmin, async (req, res) => {
  const day = qstr((req.query as any).day);
  if (!isYmd(day)) return res.status(400).json({ error: "Invalid day" });
  const del = await prisma.reservation.deleteMany({
    where: { date: day, email: "block@noxama.local" },
  });
  res.json({ ok: true, deleted: del.count });
});

// Alles löschen im Bereich (optional)
app.delete("/api/admin/reservations", requireAdmin, async (req, res) => {
  const from = qstr((req.query as any).from);
  const to = qstr((req.query as any).to);
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: "Invalid range" });
  const del = await prisma.reservation.deleteMany({
    where: { date: { gte: from, lte: to } },
  });
  res.json({ ok: true, deleted: del.count });
});

/* --------------------------- Static routes/Start -------------------------- */
app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});
app.get("/admin", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/admin.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
