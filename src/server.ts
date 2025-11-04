// src/server.ts
import { fileURLToPath } from "url";
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { customAlphabet } from "nanoid";

import { mailer, fromAddress } from "./mailer";
import { renderReservationEmail, calcLoyalty } from "./email";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(path.resolve(__dirname, "../public")));

/** ----------------------- Konfiguration ----------------------- */
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

/** ----------------------- Helpers ----------------------- */

function requireAdmin(req: Request, res: Response, next: NextFunction) {
  if (!ADMIN_KEY) return res.status(500).json({ error: "Admin key not set" });
  const k = String(req.headers["x-admin-key"] || req.query.key || "");
  if (k !== ADMIN_KEY) return res.status(401).json({ error: "Unauthorized" });
  next();
}

// "HH:mm" -> Minuten
function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((s) => Number(s));
  return h * 60 + m;
}
// Minuten -> "HH:mm"
function minutesToHm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
// Slots zwischen start..end in 15-Minuten-Raster, solange die Sitzdauer noch bis end passt
function buildSlotsWindow(startHm: string, endHm: string, durationMin: number): string[] {
  const start = hmToMinutes(startHm);
  const end = hmToMinutes(endHm);
  const out: string[] = [];
  for (let t = start; t + durationMin <= end; t += 15) {
    out.push(minutesToHm(t));
  }
  return out;
}
function dailySlots(): string[] {
  const lunch = buildSlotsWindow(
    OPEN_LUNCH_START,
    OPEN_LUNCH_END,
    OPEN_LUNCH_DURATION_MIN
  );
  const dinner = buildSlotsWindow(
    OPEN_DINNER_START,
    OPEN_DINNER_END,
    OPEN_DINNER_DURATION_MIN
  );
  return [...lunch, ...dinner];
}
function isYmd(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** ----------------------- Public: Config ----------------------- */

app.get("/api/config", (_req: Request, res: Response) => {
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

/** ----------------------- Public: Slots ----------------------- */

app.get("/api/slots", async (req: Request, res: Response) => {
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

/** ----------------------- Public: Book ----------------------- */

app.post("/api/book", async (req: Request, res: Response) => {
  try {
    const {
      date,
      time,
      guests,
      firstName,
      name,
      email,
      phone,
      notes,
    }: {
      date: string;
      time: string;
      guests: number;
      firstName: string;
      name: string;
      email: string;
      phone?: string | null;
      notes?: string | null;
    } = req.body || {};

    if (!isYmd(String(date))) return res.status(400).json({ error: "Invalid date" });

    const slots = dailySlots();
    if (!slots.includes(String(time)))
      return res.status(400).json({ error: "Invalid time" });

    if (!Number.isFinite(guests) || guests < 1 || guests > 10)
      return res.status(400).json({ error: "Invalid guests" });

    if (!firstName || !name || !email)
      return res.status(400).json({ error: "Missing fields" });

    // Kapazität
    const agg = await prisma.reservation.aggregate({
      _sum: { guests: true },
      where: { date, time, status: { not: "canceled" } },
    });
    const already = agg._sum.guests ?? 0;
    if (already + guests > ONLINE_SEATS_CAP) {
      return res.status(409).json({ error: "Fully booked" });
    }

    const newRes = await prisma.reservation.create({
      data: {
        id: nanoid(),
        firstName: String(firstName),
        name: String(name),
        email: String(email),
        phone: phone ?? null,
        date: String(date),
        time: String(time),
        guests: Number(guests),
        notes: notes ?? null,
        status: "confirmed",
        isWalkIn: false,
        createdAt: new Date(),
        cancelToken: nanoid(),
        reminderSent: false,
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
        cancelUrl: `${BASE_URL}/cancelled.html`,
        mailHeaderUrl: MAIL_HEADER_URL,
        mailLogoUrl: MAIL_LOGO_URL,
        venueAddress: VENUE_ADDRESS,
      },
      {
        id: newRes.id,
        date: newRes.date,
        time: newRes.time,
        guests: newRes.guests,
        firstName: newRes.firstName,
        lastName: newRes.name,
        email: newRes.email,
        phone: newRes.phone ?? null,
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

    res.json({ ok: true, id: newRes.id });
  } catch (err) {
    console.error("book error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** ----------------------- Public: Cancel ----------------------- */

app.get("/cancel", async (req: Request, res: Response) => {
  const token = String(req.query.token || "");
  if (!token) return res.status(400).send("Missing token");

  const r = await prisma.reservation.findFirst({ where: { cancelToken: token } });
  if (!r) return res.status(404).send("Not found");

  if (r.status !== "canceled") {
    await prisma.reservation.update({
      where: { id: r.id },
      data: { status: "canceled" },
    });
  }
  res.redirect("/cancelled.html");
});

/** ======================= ADMIN API ======================= */

// Walk-in anlegen
app.post("/api/admin/walkin", requireAdmin, async (req: Request, res: Response) => {
  const { date, time, guests, notes } = req.body || {};
  if (!isYmd(String(date))) return res.status(400).json({ error: "Invalid date" });

  const slots = dailySlots();
  if (!slots.includes(String(time)))
    return res.status(400).json({ error: "Invalid time" });

  const g = Number(guests || 2);
  if (!Number.isFinite(g) || g < 1 || g > 10)
    return res.status(400).json({ error: "Invalid guests" });

  // Kapazität
  const agg = await prisma.reservation.aggregate({
    _sum: { guests: true },
    where: { date, time, status: { not: "canceled" } },
  });
  const already = agg._sum.guests ?? 0;
  if (already + g > ONLINE_SEATS_CAP) {
    return res.status(409).json({ error: "Fully booked" });
  }

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
    },
  });

  res.json({ ok: true, id: r.id });
});

// Reservierungen auflisten (von/bis)
app.get(
  "/api/admin/reservations",
  requireAdmin,
  async (req: Request, res: Response) => {
    const from = String(req.query.from || "");
    const to = String(req.query.to || "");
    if (!isYmd(from) || !isYmd(to))
      return res.status(400).json({ error: "Invalid range" });

    const rows = await prisma.reservation.findMany({
      where: {
        date: { gte: from, lte: to },
      },
      orderBy: [{ date: "asc" }, { time: "asc" }, { createdAt: "asc" }],
    });

    const totalGuests = rows.reduce((s, r) => (r.status === "canceled" ? s : s + r.guests), 0);
    res.json({ rows, totalGuests, count: rows.length });
  }
);

// CSV-Export (von/bis)
app.get("/api/admin/export.csv", requireAdmin, async (req: Request, res: Response) => {
  const from = String(req.query.from || "");
  const to = String(req.query.to || "");
  if (!isYmd(from) || !isYmd(to))
    return res.status(400).send("Invalid range");

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

// Tag sperren: erzeugt Block-Platzhalter je Slot
app.post("/api/admin/block-day", requireAdmin, async (req: Request, res: Response) => {
  const { day, reason } = req.body || {};
  if (!isYmd(String(day))) return res.status(400).json({ error: "Invalid day" });

  const slots = dailySlots();
  const createdIds: string[] = [];

  for (const time of slots) {
    // Prüfen, ob Slot bereits „blockiert“ ist
    const hasBlock = await prisma.reservation.findFirst({
      where: { date: day, time, email: "block@noxama.local", status: { not: "canceled" } },
      select: { id: true },
    });
    if (hasBlock) continue;

    const id = nanoid();
    await prisma.reservation.create({
      data: {
        id,
        firstName: "Closed",
        name: String(reason || "Closed / Private event"),
        email: "block@noxama.local",
        phone: null,
        date: String(day),
        time: String(time),
        guests: ONLINE_SEATS_CAP, // macht den Slot sofort voll
        notes: "BLOCK_PLACEHOLDER",
        status: "confirmed",
        isWalkIn: true,
        createdAt: new Date(),
        cancelToken: nanoid(),
        reminderSent: false,
      },
    });
    createdIds.push(id);
  }

  res.json({ ok: true, created: createdIds.length });
});

// Tag entsperren: löscht alle Block-Platzhalter
app.delete("/api/admin/block-day", requireAdmin, async (req: Request, res: Response) => {
  const day = String(req.query.day || "");
  if (!isYmd(day)) return res.status(400).json({ error: "Invalid day" });

  const del = await prisma.reservation.deleteMany({
    where: { date: day, email: "block@noxama.local" },
  });

  res.json({ ok: true, deleted: del.count });
});

/** ----------------------- Fallback / Start ----------------------- */

app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});

/* ===== CSV Helper ===== */
function csv(s: string): string {
  const needs = /[",\n]/.test(s);
  return needs ? `"${s.replace(/"/g, '""')}"` : s;
}
