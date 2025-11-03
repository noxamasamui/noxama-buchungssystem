// src/server.ts
import { fileURLToPath } from "url";
import path from "path";

import express, { Request, Response } from "express";
import cors from "cors";
import dotenv from "dotenv";

import { PrismaClient, ReservationStatus } from "@prisma/client";
import { addMinutes, addHours, differenceInMinutes, format } from "date-fns";
import XLSX from "xlsx";
import { nanoid } from "nanoid";

// ─────────────────────────── ESM __dirname ───────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─────────────────────────── Init ───────────────────────────
dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());

// Statisches /public
const publicDir = path.resolve(__dirname, "../public");
app.use(express.static(publicDir));

// ─────────────────────────── Helpers ───────────────────────────
const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;

const toInt = (v: unknown, fallback = 0) => {
  const n = parseInt(String(v ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
};

const tz = process.env.TZ || "Asia/Bangkok";
const LUNCH_START = process.env.OPEN_LUNCH_START || "10:00";
const LUNCH_END = process.env.OPEN_LUNCH_END || "16:30";
const LUNCH_DURATION = toInt(process.env.OPEN_LUNCH_DURATION_MIN, 90);

const DINNER_START = process.env.OPEN_DINNER_START || "17:00";
const DINNER_END = process.env.OPEN_DINNER_END || "22:00";
const DINNER_DURATION = toInt(process.env.OPEN_DINNER_DURATION_MIN, 150);

const ONLINE_CAP = toInt(process.env.ONLINE_SEATS_CAP, 40);
const MAX_SEATS_TOTAL = toInt(process.env.MAX_SEATS_TOTAL, 48);

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const VENUE_ADDRESS =
  process.env.VENUE_ADDRESS ||
  "Moo 4 Lamai Beach, 84310 Suratthani, Thailand";
const VENUE_EMAIL = process.env.VENUE_EMAIL || "info@noxamasamui.com";

const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL || "http://localhost:4020";
const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || "";
const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || "";
const PUBLIC_LOGO_URL = process.env.PUBLIC_LOGO_URL || "";

// Zeiten in “hh:mm” → Minuten ab 00:00
const hmToMin = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map((x) => parseInt(x, 10));
  return h * 60 + m;
};
const minToHM = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(
    2,
    "0"
  )}`;

function makeSlotsForDay(): string[] {
  const blocks: Array<[number, number, number]> = [
    [hmToMin(LUNCH_START), hmToMin(LUNCH_END), LUNCH_DURATION],
    [hmToMin(DINNER_START), hmToMin(DINNER_END), DINNER_DURATION],
  ];
  const times: string[] = [];
  for (const [from, to, _dur] of blocks) {
    for (let t = from; t <= to; t += 15) times.push(minToHM(t));
  }
  return times;
}

async function activeNoticeFor(dateISO: string) {
  const d = new Date(dateISO + "T00:00:00");
  const end = addHours(d, 24);
  return prisma.notice.findFirst({
    where: {
      active: true,
      startTs: { lte: end },
      endTs: { gte: d },
    },
    orderBy: { createdAt: "desc" },
  });
}

async function isClosedAt(dateISO: string, slot: string) {
  const start = new Date(`${dateISO}T${slot}:00`);
  const end = addMinutes(start, 1);
  const hit = await prisma.closure.findFirst({
    where: {
      OR: [
        { startTs: { lte: start }, endTs: { gte: start } },
        { startTs: { lte: end }, endTs: { gte: end } },
      ],
    },
  });
  return !!hit;
}

async function seatsBooked(dateISO: string, slot: string) {
  const all = await prisma.reservation.findMany({
    where: {
      date: dateISO,
      time: slot,
      status: { in: ["confirmed", "cancelled", "noshow"] }, // Walk-ins sind eigenes Flag
    },
    select: { guests: true, isWalkIn: true },
  });
  const walkins = await prisma.reservation.findMany({
    where: {
      date: dateISO,
      time: slot,
      isWalkIn: true,
    },
    select: { guests: true },
  });
  const sum = (xs: { guests: number }[]) =>
    xs.reduce((s, r) => s + (r.guests || 0), 0);
  return sum(all) + sum(walkins);
}

// ─────────────────────────── Static Pages ───────────────────────────
app.get("/", (_req: Request, res: Response) =>
  res.sendFile(path.join(publicDir, "index.html"))
);
app.get("/admin", (_req: Request, res: Response) =>
  res.sendFile(path.join(publicDir, "admin.html"))
);
app.get("/cancelled", (_req: Request, res: Response) =>
  res.sendFile(path.join(publicDir, "cancelled.html"))
);

// ─────────────────────────── Public API ───────────────────────────
app.get("/api/config", async (_req: Request, res: Response) => {
  res.json({
    brandName: BRAND_NAME,
    venueAddress: VENUE_ADDRESS,
    mailHeaderUrl: MAIL_HEADER_URL,
    mailLogoUrl: MAIL_LOGO_URL,
    publicLogoUrl: PUBLIC_LOGO_URL,
    baseUrl: PUBLIC_BASE_URL,
    onlineCap: ONLINE_CAP,
    tz,
  });
});

app.get("/api/notices", async (req: Request, res: Response) => {
  const date = String((req.query?.date as string) || toISO(new Date()));
  const n = await activeNoticeFor(date);
  res.json(n || null);
});

app.get("/api/slots", async (req: Request, res: Response) => {
  const date = String((req.query?.date as string) || toISO(new Date()));
  const guests = toInt(req.query?.guests, 2);

  const times = makeSlotsForDay();
  const rows: { time: string; disabled: boolean; reason?: string }[] = [];

  for (const time of times) {
    // geschlossen?
    if (await isClosedAt(date, time)) {
      rows.push({ time, disabled: true, reason: "closed" });
      continue;
    }

    const booked = await seatsBooked(date, time);
    const free = Math.max(0, ONLINE_CAP - booked);
    rows.push({
      time,
      disabled: guests > free || guests > MAX_SEATS_TOTAL || free <= 0,
      reason:
        guests > MAX_SEATS_TOTAL
          ? "too_many_guests"
          : guests > free || free <= 0
          ? "full"
          : undefined,
    });
  }
  res.json({ date, guests, slots: rows });
});

app.post("/api/reservations", async (req: Request, res: Response) => {
  const b = (req.body || {}) as {
    firstName?: string;
    name?: string;
    email?: string;
    phone?: string | null;
    date?: string;
    time?: string;
    notes?: string | null;
    guests?: number;
  };

  const firstName = String(b.firstName || "").trim();
  const name = String(b.name || "").trim();
  const email = String(b.email || "").trim();
  const phone = b.phone ? String(b.phone).trim() : null;
  const date = String(b.date || "");
  const time = String(b.time || "");
  const notes = b.notes ? String(b.notes) : null;
  const guests = toInt(b.guests, 2);

  if (!firstName || !name || !email || !date || !time || guests <= 0) {
    return res.status(400).json({ error: "Invalid data" });
  }

  // Schließen + Kapazität prüfen
  if (await isClosedAt(date, time)) {
    return res.status(409).json({ error: "Closed at this time" });
  }
  const already = await seatsBooked(date, time);
  if (guests > Math.max(0, ONLINE_CAP - already)) {
    return res.status(409).json({ error: "Fully booked" });
  }

  const r = await prisma.reservation.create({
    data: {
      id: nanoid(12),
      firstName,
      name,
      email,
      phone,
      date,
      time,
      guests,
      notes,
      status: "confirmed",
      isWalkIn: false,
      createdAt: new Date(),
      cancelToken: nanoid(16),
      reminderSent: false,
    },
  });

  // (Mail optional – absichtlich weggelassen, bis SMTP 100% steht)
  res.json({ ok: true, id: r.id });
});

// ─────────────────────────── Admin: Reservations ───────────────────────────
app.get("/api/admin/reservations", async (req: Request, res: Response) => {
  const base = String((req.query?.date as string) || toISO(new Date()));
  const view = String((req.query?.view as string) || "week");

  const start = new Date(base + "T00:00:00");
  let end = addHours(start, 24);

  if (view === "week") end = addHours(start, 24 * 7);
  if (view === "month") end = addHours(start, 24 * 31);

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: toISO(start), lte: toISO(end) } },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
  res.json(rows);
});

app.delete(
  "/api/admin/reservations/:id",
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await prisma.reservation.delete({ where: { id } });
    res.json({ ok: true });
  }
);

app.post(
  "/api/admin/reservations/:id/noshow",
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await prisma.reservation.update({
      where: { id },
      data: { status: "noshow" as ReservationStatus },
    });
    res.json({ ok: true });
  }
);

// Walk-in
app.post("/api/admin/walkin", async (req: Request, res: Response) => {
  const b = (req.body || {}) as {
    date?: string;
    time?: string;
    guests?: number;
    notes?: string | null;
  };
  const date = String(b.date || "");
  const time = String(b.time || "");
  const guests = toInt(b.guests, 2);
  const notes = b.notes ? String(b.notes) : null;

  if (!date || !time || guests <= 0) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const r = await prisma.reservation.create({
    data: {
      id: nanoid(12),
      firstName: "Walk",
      name: "In",
      email: "walkin@noxama.local",
      phone: null,
      date,
      time,
      guests,
      notes,
      isWalkIn: true,
      status: "confirmed",
      cancelToken: nanoid(16),
      reminderSent: false,
      createdAt: new Date(),
    },
  });
  res.json({ ok: true, id: r.id });
});

// ─────────────────────────── Admin: Closures ───────────────────────────
app.post("/api/admin/closure", async (req: Request, res: Response) => {
  const b = (req.body || {}) as {
    startTs?: string;
    endTs?: string;
    reason?: string;
  };
  const startTs = b.startTs ? new Date(b.startTs) : null;
  const endTs = b.endTs ? new Date(b.endTs) : null;
  const reason = String(b.reason || "Closed / Private event");

  if (!startTs || !endTs || +endTs <= +startTs) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const row = await prisma.closure.create({
    data: { id: nanoid(10), startTs, endTs, reason, createdAt: new Date() },
  });
  res.json(row);
});

app.get("/api/admin/closure", async (_req: Request, res: Response) => {
  const rows = await prisma.closure.findMany({ orderBy: { startTs: "asc" } });
  res.json(rows);
});

app.delete(
  "/api/admin/closure/:id",
  async (req: Request, res: Response) => {
    const { id } = req.params as { id: string };
    await prisma.closure.delete({ where: { id } });
    res.json({ ok: true });
  }
);

app.post("/api/admin/closure/day", async (req: Request, res: Response) => {
  const b = (req.body || {}) as { date?: string; reason?: string };
  const date = String(b.date || "");
  const reason = String(b.reason || "Closed");
  if (!date) return res.status(400).json({ error: "Invalid data" });
  const startTs = new Date(`${date}T00:00:00`);
  const endTs = addHours(startTs, 24);
  const row = await prisma.closure.create({
    data: { id: nanoid(10), startTs, endTs, reason, createdAt: new Date() },
  });
  res.json(row);
});

// ─────────────────────────── Admin: Notices ───────────────────────────
app.get("/api/admin/notices", async (_req: Request, res: Response) => {
  const list = await prisma.notice.findMany({
    orderBy: { createdAt: "desc" },
  });
  res.json(list);
});

app.post("/api/admin/notices", async (req: Request, res: Response) => {
  const b = (req.body || {}) as {
    startTs?: string;
    endTs?: string;
    title?: string;
    message?: string;
    active?: boolean;
    requireAck?: boolean;
  };
  const startTs = b.startTs ? new Date(b.startTs) : null;
  const endTs = b.endTs ? new Date(b.endTs) : null;
  const title = String(b.title || "");
  const message = String(b.message || "");
  const active = !!b.active;
  const requireAck = !!b.requireAck;

  if (!startTs || !endTs || !title) {
    return res.status(400).json({ error: "Invalid data" });
  }

  const row = await prisma.notice.create({
    data: {
      id: nanoid(10),
      startTs,
      endTs,
      title,
      message,
      active,
      requireAck,
      createdAt: new Date(),
    },
  });
  res.json(row);
});

app.patch("/api/admin/notices/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  const patch = req.body || {};
  const allowed: Record<string, any> = {};
  for (const k of ["title", "message", "active", "requireAck"] as const) {
    if (k in patch) allowed[k] = patch[k];
  }
  if ("startTs" in patch) allowed.startTs = new Date(patch.startTs);
  if ("endTs" in patch) allowed.endTs = new Date(patch.endTs);
  const row = await prisma.notice.update({ where: { id }, data: allowed });
  res.json(row);
});

app.delete("/api/admin/notices/:id", async (req: Request, res: Response) => {
  const { id } = req.params as { id: string };
  await prisma.notice.delete({ where: { id } });
  res.json({ ok: true });
});

// ─────────────────────────── Export ───────────────────────────
app.get("/api/export", async (req: Request, res: Response) => {
  const period = String((req.query?.period as string) || "weekly");
  const base = String((req.query?.date as string) || toISO(new Date()));

  const start = new Date(base + "T00:00:00");
  let end = addHours(start, 24);
  if (period === "weekly") end = addHours(start, 24 * 7);
  if (period === "monthly") end = addHours(start, 24 * 31);
  if (period === "yearly") end = addHours(start, 24 * 366);

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: toISO(start), lte: toISO(end) } },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });

  const data = [
    [
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
    ],
    ...rows.map((r) => [
      r.date,
      r.time,
      r.firstName,
      r.name,
      r.email,
      r.phone || "",
      r.guests,
      r.status,
      r.notes || "",
      r.isWalkIn ? "yes" : "",
      format(r.createdAt ?? new Date(), "yyyy-MM-dd HH:mm"),
    ]),
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, "reservations");

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const fname = `reservations_${base}_${period}.xlsx`;

  res.set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.set("Content-Disposition", `attachment; filename="${fname}"`);
  res.send(buf);
});

// ─────────────────────────── Danger Zone: Reset (optional key) ───────────────────────────
app.post("/api/admin/reset", async (req: Request, res: Response) => {
  const key = String((req.body as any)?.key || "");
  if (!key || key !== (process.env.ADMIN_RESET_KEY || "")) {
    return res.status(403).json({ error: "Forbidden" });
  }
  await prisma.$transaction([
    prisma.reservation.deleteMany(),
    prisma.closure.deleteMany(),
    prisma.notice.deleteMany(),
  ]);
  res.json({ ok: true });
});

// ─────────────────────────── Start ───────────────────────────
const PORT = toInt(process.env.PORT, 4020);
app.listen(PORT, () => {
  console.log("Server running on", PORT);
});
