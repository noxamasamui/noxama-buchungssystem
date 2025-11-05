// src/server.ts
import { fileURLToPath } from "url";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { customAlphabet } from "nanoid";

// SMTP-Adapter aus deinem mailsender:
import { mailer, fromAddress } from "./mailsender.js";

dotenv.config();

/* ----------------------------------------------------------- */
/* ESM __dirname */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ----------------------------------------------------------- */
/* App / Prisma / Static */
const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

/* ----------------------------------------------------------- */
/* Config aus ENV */
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

const MAIL_HEADER_URL =
  process.env.MAIL_HEADER_URL || "https://i.imgur.com/LQ4nzwd.png"; // Fallback Banner
const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || null;

const ADMIN_LOGO_URL = process.env.ADMIN_LOGO_URL || MAIL_HEADER_URL;

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

/* ----------------------------------------------------------- */
/* Helpers */

function requireDanger(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_KEY) return res.status(500).json({ error: "Admin key not set" });
  const k = String(req.headers["x-admin-key"] || req.query.key || "");
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

function hmToMin(hm: string): number {
  const [h, m] = hm.split(":").map((s) => Number(s));
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
function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
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

/* ----------------------------------------------------------- */
/* Public Config */
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
    adminLogoUrl: ADMIN_LOGO_URL,
    onlineSeatsCap: ONLINE_SEATS_CAP,
  });
});

/* ----------------------------------------------------------- */
/* Notices (für Buchungspopup) */
app.get("/api/notice", async (req, res) => {
  const date = String(req.query.date || "");
  if (!isYmd(date)) return res.status(400).json({ error: "Invalid date" });
  const n = await prisma.notice.findFirst({
    where: { date, active: true },
    orderBy: { createdAt: "desc" },
  });
  res.json(n || null);
});

/* ----------------------------------------------------------- */
/* Slots – berücksichtigen die Kapazität strikt je Slot */
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
        where: {
          date,
          time,
          status: { notIn: ["canceled", "no-show"] },
        },
      });
      const taken = agg._sum.guests ?? 0;
      // strikte Deckelung je Slot:
      const disabled = taken + guests > ONLINE_SEATS_CAP;
      return { time, disabled, taken, cap: ONLINE_SEATS_CAP };
    })
  );
  res.json(list);
});

/* ----------------------------------------------------------- */
/* Book */
app.post("/api/book", async (req, res) => {
  try {
    const { date, time, guests, firstName, name, email, phone, notes, ack } = req.body || {};

    if (!isYmd(String(date))) return res.status(400).json({ error: "Invalid date" });
    const slots = dailySlots();
    if (!slots.includes(String(time)))
      return res.status(400).json({ error: "Invalid time" });

    const g = Number(guests);
    if (!Number.isFinite(g) || g < 1 || g > 10)
      return res.status(400).json({ error: "Invalid guests" });

    if (!firstName || !name || !email)
      return res.status(400).json({ error: "Missing fields" });

    // Notice prüfen – falls requireAck, muss ack === true sein
    const n = await prisma.notice.findFirst({
      where: { date: String(date), active: true },
    });
    if (n?.requireAck && !ack) {
      return res.status(412).json({ error: "Acknowledgment required" });
    }

    // Kapazität je Slot prüfen
    const agg = await prisma.reservation.aggregate({
      _sum: { guests: true },
      where: { date, time, status: { notIn: ["canceled", "no-show"] } },
    });
    const already = agg._sum.guests ?? 0;
    if (already + g > ONLINE_SEATS_CAP) return res.status(409).json({ error: "Fully booked" });

    const { startTs, endTs } = buildStartEnd(String(date), String(time));

    const newRes = await prisma.reservation.create({
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
        startTs,
        endTs,
      },
    });

    // Loyalty Count (nur frühere, nicht-stornierte)
    const pastCount = await prisma.reservation.count({
      where: {
        email: newRes.email,
        status: { notIn: ["canceled", "no-show"] },
        createdAt: { lt: newRes.createdAt },
      },
    });

    const level = pastCount + 1 >= 15 ? 15 : pastCount + 1 >= 10 ? 10 : pastCount + 1 >= 5 ? 5 : 0;

    const subject = `Your Reservation at ${BRAND_NAME}`;
    const cancelLink = `${BASE_URL}/cancel?token=${encodeURIComponent(newRes.cancelToken)}`;

    const banner = MAIL_HEADER_URL ? `<img src="${MAIL_HEADER_URL}" style="max-width:100%;display:block;margin:0 auto 12px;border-radius:8px"/>` : "";

    const loyaltyBlock =
      level > 0
        ? `<p><strong>You now enjoy a ${level}% Loyalty Discount</strong> for this and all future visits.</p>`
        : `<p><strong>Thank you for your loyalty!</strong><br/>After <strong>${level === 0 ? 5 : level === 5 ? 10 : 15}</strong> bookings you'll enjoy a loyalty discount.</p>`;

    const html = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2b1a12;max-width:720px;margin:auto">
    ${banner}
    <h2 style="text-align:center;margin:8px 0 12px">Your Reservation at ${BRAND_NAME}</h2>
    <p>Hi ${newRes.firstName} ${newRes.name},</p>
    <p>Thank you for your reservation. We look forward to welcoming you.</p>
    <div style="background:#faefe6;border-radius:10px;padding:10px 12px;margin:12px 0;border:1px solid #ead7c7">
      <div><b>Date</b> ${newRes.date}</div>
      <div><b>Time</b> ${newRes.time}</div>
      <div><b>Guests</b> ${newRes.guests}</div>
      <div><b>Address</b> ${VENUE_ADDRESS}</div>
    </div>
    ${loyaltyBlock}
    <div style="background:#fdeeea;border-radius:10px;padding:10px 12px;margin:12px 0;border:1px solid #f4d6ce">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>
    <div style="text-align:center;margin:18px 0">
      <a href="${cancelLink}" style="background:#b6802a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;display:inline-block">Cancel reservation</a>
    </div>
    <p style="text-align:center">Warm regards from <b>${BRAND_NAME}</b></p>
  </div>
  `;

    await mailer().sendMail({ from: fromAddress(), to: newRes.email, subject, html });

    res.json({ ok: true, id: newRes.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Server error" });
  }
});

/* ----------------------------------------------------------- */
/* Cancel per Token (öffentlich) */
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

/* ========================= ADMIN ========================= */

/* Reservierungen lesen (kein Key nötig) */
app.get("/api/admin/reservations", async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: "Invalid range" });

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
  });

  res.json({ rows });
});

/* Reservation löschen (einzeln, kein Key nötig) */
app.delete("/api/admin/reservation/:id", async (req, res) => {
  const id = String(req.params.id);
  await prisma.reservation.delete({ where: { id } }).catch(() => {});
  res.json({ ok: true });
});

/* Reservation patchen: no-show oder canceled (kein Key nötig) */
app.patch("/api/admin/reservation/:id", async (req, res) => {
  const id = String(req.params.id);
  const { status }:{ status?: "no-show" | "canceled" | "confirmed" } = req.body || {};
  if (!status) return res.status(400).json({ error: "Missing status" });
  await prisma.reservation.update({ where: { id }, data: { status } }).catch(() => {});
  res.json({ ok: true });
});

/* CSV Export (kein Key nötig) */
app.get("/api/admin/export.csv", async (req, res) => {
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

  const body = rows.map(r => [
    r.date, r.time, csv(r.firstName), csv(r.name), csv(r.email), csv(r.phone ?? ""),
    String(r.guests), r.status, csv(r.notes ?? ""), r.isWalkIn ? "yes" : "",
    r.createdAt.toISOString()
  ].join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="export_${from}_${to}.csv"`);
  res.send([header, body].join("\n"));
});

/* Notices CRUD (kein Key nötig für anlegen/löschen – sag Bescheid, wenn du das hinter Key willst) */
app.get("/api/admin/notices", async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: "Invalid range" });
  const list = await prisma.notice.findMany({
    where: { date: { gte: from, lte: to } },
    orderBy: [{ date: "asc" }, { createdAt: "desc" }],
  });
  res.json(list);
});

app.post("/api/admin/notice", async (req, res) => {
  const { date, title, message, requireAck, active } = req.body || {};
  if (!isYmd(String(date)) || !message) return res.status(400).json({ error: "Invalid data" });
  const n = await prisma.notice.create({
    data: {
      id: nanoid(),
      date: String(date),
      title: title ? String(title) : null,
      message: String(message),
      requireAck: Boolean(requireAck),
      active: active === false ? false : true,
    },
  });
  res.json(n);
});

app.delete("/api/admin/notice/:id", async (req, res) => {
  const id = String(req.params.id);
  await prisma.notice.delete({ where: { id } }).catch(() => {});
  res.json({ ok: true });
});

/* Blocks anzeigen (placeholder) – kein Key nötig zum Sichten */
app.get("/api/admin/blocked", async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to)) return res.status(400).json({ error: "Invalid range" });

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: from, lte: to }, email: "block@noxama.local", status: { not: "canceled" } },
    orderBy: [{ date: "asc" }, { time: "asc" }],
    select: { id: true, date: true, time: true, name: true }
  });
  res.json(rows);
});

/* Block erstellen (ganzer Tag oder einzelner Slot) – kein Key nötig */
app.post("/api/admin/block", async (req, res) => {
  const { day, time, reason } = req.body || {};
  if (!isYmd(String(day))) return res.status(400).json({ error: "Invalid day" });
  const times = time ? [String(time)] : dailySlots();
  let created = 0;
  for (const t of times) {
    const exists = await prisma.reservation.findFirst({
      where: { date: String(day), time: t, email: "block@noxama.local", status: { not: "canceled" } },
      select: { id: true },
    });
    if (exists) continue;
    const { startTs, endTs } = buildStartEnd(String(day), t);
    await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName: "Closed",
        name: String(reason || "Closed / Private event"),
        email: "block@noxama.local",
        phone: null,
        date: String(day),
        time: t,
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

/* Block entfernen (ganzer Tag oder einzelner Slot) – kein Key nötig */
app.delete("/api/admin/block", async (req, res) => {
  const day = String(req.query.day || "");
  const time = req.query.time ? String(req.query.time) : null;
  if (!isYmd(day)) return res.status(400).json({ error: "Invalid day" });
  const where = time
    ? { date: day, time, email: "block@noxama.local" }
    : { date: day, email: "block@noxama.local" };
  const del = await prisma.reservation.deleteMany({ where });
  res.json({ ok: true, deleted: del.count });
});

/* DANGER ZONE – NUR MIT KEY */
app.delete("/api/admin/danger/purge", requireDanger, async (_req, res) => {
  await prisma.reservation.deleteMany({});
  res.json({ ok: true });
});

/* ----------------------------------------------------------- */
/* Fallback + Start */
app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});
app.get("/admin", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/admin.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
