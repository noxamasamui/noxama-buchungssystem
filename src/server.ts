// src/server.ts
import { fileURLToPath } from "url";
import express, { type Request, type Response } from "express";
import cors from "cors";
import path from "path";
import dotenv from "dotenv";
import { PrismaClient } from "@prisma/client";
import { customAlphabet } from "nanoid";
import { addMinutes } from "date-fns";

import { mailer, fromAddress } from "./mailer";
import { renderReservationEmail, calcLoyalty } from "./email";

// __dirname für ES-Module
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

// Online-Kapazität pro Slot
const ONLINE_SEATS_CAP = Number(process.env.ONLINE_SEATS_CAP || 40);

// Öffnungszeiten und Slot-Dauern
const OPEN_LUNCH_START = process.env.OPEN_LUNCH_START || "10:00";
const OPEN_LUNCH_END = process.env.OPEN_LUNCH_END || "16:30";
const OPEN_LUNCH_DURATION_MIN = Number(process.env.OPEN_LUNCH_DURATION_MIN || 90);

const OPEN_DINNER_START = process.env.OPEN_DINNER_START || "17:00";
const OPEN_DINNER_END = process.env.OPEN_DINNER_END || "22:00";
const OPEN_DINNER_DURATION_MIN = Number(process.env.OPEN_DINNER_DURATION_MIN || 90);

// Nanoid für Tokens
const nanoid = customAlphabet("abcdefghijkmnpqrstuvwxyz123456789", 21);

/** ----------------------- Hilfsfunktionen ----------------------- */

// "HH:mm" -> Minuten seit 00:00
function hmToMinutes(hm: string): number {
  const [h, m] = hm.split(":").map((s) => Number(s));
  return h * 60 + m;
}

// Minuten seit 00:00 -> "HH:mm"
function minutesToHm(min: number): string {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// erzeugt Slots zwischen start..end in steps
function buildSlotsWindow(
  startHm: string,
  endHm: string,
  durationMin: number
): string[] {
  const start = hmToMinutes(startHm);
  const end = hmToMinutes(endHm);
  const out: string[] = [];
  for (let t = start; t + durationMin <= end; t += 15) {
    // 15-Minuten Raster, Sitzdauer ist durationMin, letzte Ankunft so, dass Dauer noch bis end passt
    const visual = minutesToHm(t);
    const latestLeave = t + durationMin;
    if (latestLeave <= end) out.push(visual);
  }
  return out;
}

// Alle Slots für einen Tag
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

/** ----------------------- API: Config ----------------------- */

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

/** ----------------------- API: Slots ----------------------- */

app.get("/api/slots", async (req: Request, res: Response) => {
  const date = String(req.query.date || "");
  const guests = Number(req.query.guests || 2);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(date))
    return res.status(400).json({ error: "Invalid date" });
  if (!Number.isFinite(guests) || guests < 1 || guests > 10)
    return res.status(400).json({ error: "Invalid guests" });

  const all = dailySlots();

  // Belegungen je Slot ermitteln
  const list = await Promise.all(
    all.map(async (time) => {
      const agg = await prisma.reservation.aggregate({
        _sum: { guests: true },
        where: {
          date,
          time,
          status: { not: "canceled" },
        },
      });
      const taken = agg._sum.guests ?? 0;
      const disabled = taken >= ONLINE_SEATS_CAP; // voll
      return { time, disabled, taken, cap: ONLINE_SEATS_CAP };
    })
  );

  res.json(list);
});

/** ----------------------- API: Book ----------------------- */

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

    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)))
      return res.status(400).json({ error: "Invalid date" });

    const slots = dailySlots();
    if (!slots.includes(String(time)))
      return res.status(400).json({ error: "Invalid time" });

    if (!Number.isFinite(guests) || guests < 1 || guests > 10)
      return res.status(400).json({ error: "Invalid guests" });

    if (!firstName || !name || !email)
      return res.status(400).json({ error: "Missing fields" });

    // Kapazitätscheck
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

    // Loyalty ermitteln
    const pastCount = await prisma.reservation.count({
      where: {
        email: newRes.email,
        status: { not: "canceled" },
        // nur ältere zählen: createdAt < aktuelle
        createdAt: { lt: newRes.createdAt },
      },
    });
    const loyalty = calcLoyalty(pastCount);

    // Mail verschicken
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
  } catch (err: any) {
    console.error("book error", err);
    res.status(500).json({ error: "Server error" });
  }
});

/** ----------------------- Cancel ----------------------- */

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

  // einfache Weiterleitung zur cancel-Seite
  res.redirect("/cancelled.html");
});

/** ----------------------- Fallback / Start ----------------------- */

app.get("/", (_req, res) => {
  res.sendFile(path.resolve(__dirname, "../public/index.html"));
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
