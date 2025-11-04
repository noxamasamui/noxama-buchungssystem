// src/server.ts
import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import { PrismaClient } from "@prisma/client";
import { customAlphabet } from "nanoid";

// WICHTIG: dein SMTP-Wrapper (nach Transpile als .js)
import { mailer, fromAddress } from "./mailsender.js";

dotenv.config();

/* ────────────────────────────── ESM __dirname ────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* ────────────────────────────── App / Prisma ─────────────────────────────── */
const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

/* ────────────────────────────── Config (ENV) ─────────────────────────────── */
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

const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || null; // volle Breite
const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || null;     // kleines Logo

const ONLINE_SEATS_CAP = Number(process.env.ONLINE_SEATS_CAP || 40);

// Öffnungszeiten und Slot-Dauer
const OPEN_LUNCH_START = process.env.OPEN_LUNCH_START || "10:00";
const OPEN_LUNCH_END = process.env.OPEN_LUNCH_END || "16:30";
const OPEN_LUNCH_DURATION_MIN = Number(process.env.OPEN_LUNCH_DURATION_MIN || 90);

const OPEN_DINNER_START = process.env.OPEN_DINNER_START || "17:00";
const OPEN_DINNER_END = process.env.OPEN_DINNER_END || "22:00";
const OPEN_DINNER_DURATION_MIN = Number(process.env.OPEN_DINNER_DURATION_MIN || 90);

// Admin Key
const ADMIN_KEY = (process.env.ADMIN_RESET_KEY || process.env.ADMIN_PASSWORD || "").trim();

// Zielseite nach erfolgreicher Buchung (für Frontend, falls genutzt)
const REDIRECT_AFTER_BOOK = process.env.REDIRECT_AFTER_BOOK || "https://noxamasamui.com";

// ID/Token Generator
const nanoid = customAlphabet("abcdefghijkmnpqrstuvwxyz123456789", 21);

/* ────────────────────────────── Helpers: Zeit/Slots ──────────────────────── */
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
function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}
function pickDurationMin(time: string): number {
  const t = hmToMin(time);
  const lunchStart = hmToMin(OPEN_LUNCH_START);
  const lunchEnd = hmToMin(OPEN_LUNCH_END);
  return t >= lunchStart && t + OPEN_LUNCH_DURATION_MIN <= lunchEnd
    ? OPEN_LUNCH_DURATION_MIN
    : OPEN_DINNER_DURATION_MIN;
}
function buildStartEnd(date: string, time: string): { startTs: Date; endTs: Date } {
  const startTs = new Date(`${date}T${time}:00`);
  const endTs = new Date(startTs.getTime() + pickDurationMin(time) * 60_000);
  return { startTs, endTs };
}
function csv(s: string): string {
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/* ────────────────────────────── Helpers: Admin ───────────────────────────── */
function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_KEY) return res.status(500).json({ error: "Admin key not set" });
  const k = String(req.headers["x-admin-key"] || req.query.key || "");
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

/* ────────────────────────────── Loyalty ──────────────────────────────────── */
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

/* ────────────────────────────── Mail Renderer ────────────────────────────── */
function renderReservationEmail(
  meta: {
    brandName: string;
    baseUrl: string;
    mailHeaderUrl: string | null;
    mailLogoUrl: string | null;
  },
  r: {
    firstName: string;
    lastName: string;
    date: string;
    time: string;
    guests: number;
    cancelToken: string;
  },
  loyalty: Loyalty
): { subject: string; html: string } {
  const subject = `Your Reservation at ${meta.brandName}`;

  const loyaltyBlock =
    loyalty.level > 0
      ? `<p><strong>Thank you for your loyalty!</strong><br>You now enjoy a <strong>${loyalty.level}% Loyalty Discount</strong> for this and all future visits.</p>`
      : loyalty.nextAt
      ? `<p><strong>Thank you for your loyalty!</strong><br>After <strong>${loyalty.nextAt}</strong> bookings you’ll enjoy a loyalty discount.</p>`
      : "";

  const cancelLink = `${BASE_URL}/cancel?token=${encodeURIComponent(r.cancelToken)}`;

  const brandTop = meta.mailHeaderUrl
    ? `<img src="${meta.mailHeaderUrl}" alt="" style="display:block;width:100%;height:auto;border:0;max-width:640px;">`
    : meta.mailLogoUrl
    ? `<div style="text-align:center;padding:20px 0 10px">
         <img src="${meta.mailLogoUrl}" alt="" style="max-height:56px;width:auto;border:0;display:inline-block;">
       </div>`
    : ``;

  const html = `
  <div style="font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2b1a12;background:#fff;padding:0;margin:0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%;background:#efe1d6;">
      <tr><td>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="width:100%;max-width:640px;margin:0 auto;background:#fff;">
          <tr><td style="padding:0;">${brandTop}</td></tr>

          <tr>
            <td style="padding:18px 22px 10px;">
              <h2 style="margin:0 0 6px;font-size:22px;line-height:1.25;text-align:center;">
                Your Reservation at ${meta.brandName}
              </h2>
              <p style="margin:0 0 8px;">Hi ${csv(r.firstName)} ${csv(r.lastName)},</p>
              <p style="margin:0;">Thank you for your reservation. We look forward to welcoming you.</p>
            </td>
          </tr>

          <tr>
            <td style="padding:12px 22px;">
              <div style="background:#faefe6;border-radius:10px;padding:12px 14px;border:1px solid #ead7c7">
                <div><b>Date</b> ${r.date}</div>
                <div><b>Time</b> ${r.time}</div>
                <div><b>Guests</b> ${r.guests}</div>
                <div><b>Address</b> ${VENUE_ADDRESS}</div>
              </div>

              ${loyaltyBlock ? `<div style="margin-top:10px;">${loyaltyBlock}</div>` : ``}

              <div style="background:#fdeeea;border-radius:10px;padding:12px 14px;margin:12px 0;border:1px solid #f4d6ce">
                <b>Punctuality</b><br>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
              </div>

              <div style="text-align:center;margin:18px 0 24px">
                <a href="${cancelLink}" style="background:#b6802a;color:#fff;text-decoration:none;padding:10px 16px;border-radius:10px;display:inline-block">Cancel reservation</a>
              </div>

              <p style="text-align:center;margin:0 0 22px;color:#5a463a">Warm regards from <b>${BRAND_NAME}</b></p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </div>`;
  return { subject, html };
}

/* ────────────────────────────── Public: Config ───────────────────────────── */
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
    redirectAfterBook: REDIRECT_AFTER_BOOK,
  });
});

/* ────────────────────────────── Public: Slots ────────────────────────────── */
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

/* ────────────────────────────── Public: Book ─────────────────────────────── */
app.post("/api/book", async (req, res) => {
  try {
    const { date, time, guests, firstName, name, email, phone, notes } =
      (req.body as any) || {};

    if (!isYmd(String(date))) return res.status(400).json({ error: "Invalid date" });

    const slots = dailySlots();
    if (!slots.includes(String(time)))
      return res.status(400).json({ error: "Invalid time" });

    const g = Number(guests);
    if (!Number.isFinite(g) || g < 1 || g > 10)
      return res.status(400).json({ error: "Invalid guests" });

    if (!firstName || !name || !email)
      return res.status(400).json({ error: "Missing fields" });

    const capAgg = await prisma.reservation.aggregate({
      _sum: { guests: true },
      where: { date, time, status: { not: "canceled" } },
    });
    const already = capAgg._sum.guests ?? 0;
    if (already + g > ONLINE_SEATS_CAP) return res.status(409).json({ error: "Fully booked" });

    const { startTs, endTs } = buildStartEnd(String(date), String(time));

    const newRes = await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName: String(firstName),
        name: String(name),
        email: String(email),
        phone: phone ? String(phone) : null,
        date: String(date),
        time: String(time),
        guests: g,
        notes: notes ? String(notes) : null,
        status: "confirmed",
        isWalkIn: false,
        createdAt: new Date(),
        cancelToken: nanoid(),
        reminderSent: false,
        startTs,
        endTs,
      },
    });

    // Loyalty: Anzahl früherer Buchungen (nicht canceled) vor dieser Reservierung
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
      },
      {
        firstName: newRes.firstName,
        lastName: newRes.name,
        date: newRes.date,
        time: newRes.time,
        guests: newRes.guests,
        cancelToken: newRes.cancelToken,
      },
      loyalty
    );

    await mailer().sendMail({
      from: fromAddress(),
      to: newRes.email,
      subject,
      html,
    });

    res.json({ ok: true, id: newRes.id, redirect: REDIRECT_AFTER_BOOK });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ────────────────────────────── Public: Cancel ───────────────────────────── */
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

/* ────────────────────────────── ADMIN: Walk-in ───────────────────────────── */
app.post("/api/admin/walkin", requireAdmin, async (req, res) => {
  const { date, time, guests, notes } = (req.body as any) || {};

  if (!isYmd(String(date))) return res.status(400).json({ error: "Invalid date" });
  const slots = dailySlots();
  if (!slots.includes(String(time)))
    return res.status(400).json({ error: "Invalid time" });

  const g = Number(guests || 2);
  if (!Number.isFinite(g) || g < 1 || g > 10)
    return res.status(400).json({ error: "Invalid guests" });

  const agg = await prisma.reservation.aggregate({
    _sum: { guests: true },
    where: { date, time, status: { not: "canceled" } },
  });
  const already = agg._sum.guests ?? 0;
  if (already + g > ONLINE_SEATS_CAP) return res.status(409).json({ error: "Fully booked" });

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
      notes: notes ? String(notes) : null,
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

/* ────────────────────────────── ADMIN: Liste / Export ────────────────────── */
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

app.get("/api/admin/export.csv", requireAdmin, async (req, res) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
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

/* ────────────────────────────── ADMIN: Day block ─────────────────────────── */
app.post("/api/admin/block-day", requireAdmin, async (req, res) => {
  const { day, reason } = (req.body as any) || {};
  if (!isYmd(String(day))) return res.status(400).json({ error: "Invalid day" });

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

/* ────────────────────────────── Fallback / Start ─────────────────────────── */
app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
