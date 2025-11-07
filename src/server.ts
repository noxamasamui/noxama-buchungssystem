// src/server.ts
import express from "express";
import bodyParser from "body-parser";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import cors from "cors";
import { parse } from "csv-stringify/sync"; // optional for CSV, but we will produce manually if unavailable
import dayjs from "dayjs";

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(bodyParser.json());
app.use(express.static("public"));

// -------------------- Helpers --------------------
const pad2 = (n: number) => String(n).padStart(2, "0");

function parseTimeToDate(dateStr: string, hhmm: string) {
  // dateStr expected YYYY-MM-DD, hhmm "HH:MM"
  const [y, m, d] = dateStr.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  return new Date(y, m - 1, d, hh, mm, 0, 0);
}
function addMinutes(d: Date, minutes: number) {
  return new Date(d.getTime() + minutes * 60000);
}
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date) {
  return aStart < bEnd && bStart < aEnd;
}

function isoDate(d: Date) {
  return d.toISOString();
}

function readConfig() {
  // read environment variables - keep names compatible with what we discussed
  return {
    brand: process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI",
    address: process.env.VENUE_ADDRESS || "Moo 4 Lamai Beach, 84310 Suratthani, Thailand",
    phone: process.env.VENUE_PHONE || "+66 077 270 675",
    email: process.env.VENUE_EMAIL || "info@noxamasamui.com",
    mailHeaderUrl: process.env.MAIL_HEADER_URL || process.env.MAIL_LOGO_URL || "",
    mailLogoUrl: process.env.MAIL_LOGO_URL || "",
    onlineSeatsCap: Number(process.env.ONLINE_SEATS_CAP || process.env.MAX_SEATS_TOTAL || 40),
    openLunchStart: process.env.OPEN_LUNCH_START || "10:00",
    openLunchEnd: process.env.OPEN_LUNCH_END || "16:30",
    openLunchDurationMin: Number(process.env.OPEN_LUNCH_DURATION_MIN || process.env.OPEN_LUNCH_DURATION || 90),
    openDinnerStart: process.env.OPEN_DINNER_START || "17:00",
    openDinnerEnd: process.env.OPEN_DINNER_END || "22:00",
    openDinnerDurationMin: Number(process.env.OPEN_DINNER_DURATION_MIN || process.env.OPEN_DINNER_DURATION || 150),
    slotStepMin: Number(process.env.SLOT_STEP_MIN || 15),
    sundayClosed: (process.env.SUNDAY_CLOSED || "true") === "true",
    // admin secret optional for protecting admin endpoints (if you use)
    adminSecret: process.env.ADMIN_SECRET || "",
  };
}

// -------------------- API - Config --------------------
app.get("/api/config", (req, res) => {
  res.json(readConfig());
});

// -------------------- Notices --------------------
// Get notice for date
app.get("/api/notices", async (req, res) => {
  // query: ?date=YYYY-MM-DD
  const date = String(req.query.date || "");
  if (!date) return res.status(400).json({ error: "Missing date" });
  try {
    const notice = await prisma.notice.findUnique({ where: { date } });
    if (!notice) return res.json(null);
    return res.json({ date: notice.date, message: notice.message });
  } catch (err) {
    console.error("GET /api/notices err", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// Admin upsert notice
app.post("/api/admin/notice", async (req, res) => {
  const { date, message, secret } = req.body || {};
  // optional admin secret check if set
  const cfg = readConfig();
  if (cfg.adminSecret && secret !== cfg.adminSecret) {
    return res.status(403).json({ error: "Forbidden" });
  }
  if (!date || !message) return res.status(400).json({ error: "Missing date or message" });

  try {
    const notice = await prisma.notice.upsert({
      where: { date },
      update: { message },
      create: { date, message },
    });
    return res.json({ ok: true, notice: { date: notice.date, message: notice.message } });
  } catch (err) {
    console.error("POST /api/admin/notice err", err);
    return res.status(500).json({ error: "Failed to save notice" });
  }
});

// -------------------- Closures (blocktage) - Admin --------------------
// create closure (admin)
app.post("/api/admin/closures", async (req, res) => {
  const { startTs, endTs, reason, secret } = req.body || {};
  const cfg = readConfig();
  if (cfg.adminSecret && secret !== cfg.adminSecret) return res.status(403).json({ error: "Forbidden" });
  if (!startTs || !endTs) return res.status(400).json({ error: "Missing startTs or endTs" });
  try {
    const c = await prisma.closure.create({ data: { startTs: new Date(startTs), endTs: new Date(endTs), reason } });
    return res.json({ ok: true, closure: c });
  } catch (err) {
    console.error("POST /api/admin/closures err", err);
    return res.status(500).json({ error: "Failed to create closure" });
  }
});

// list closures overlapping a date range (admin)
app.get("/api/admin/closures", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "Missing date" });
  const d = String(date);
  try {
    const start = new Date(d + "T00:00:00");
    const end = new Date(d + "T23:59:59");
    const closures = await prisma.closure.findMany({
      where: {
        AND: [
          { startTs: { lte: end } },
          { endTs: { gte: start } },
        ],
      },
    });
    return res.json(closures);
  } catch (err) {
    console.error("GET /api/admin/closures err", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Helper: load reservations + closures for date --------------------
async function loadReservationsAndClosuresForDate(date: string) {
  // reservations for that date
  const reservations = await prisma.reservation.findMany({
    where: { date },
    select: {
      id: true,
      date: true,
      time: true,
      startTs: true,
      endTs: true,
      guests: true,
      status: true,
      isWalkIn: true,
      createdAt: true,
    },
  });

  const startOfDay = new Date(date + "T00:00:00");
  const endOfDay = new Date(date + "T23:59:59");
  const closures = await prisma.closure.findMany({
    where: {
      AND: [
        { startTs: { lte: endOfDay } },
        { endTs: { gte: startOfDay } },
      ],
    },
  });

  return { reservations, closures };
}

// -------------------- Slots endpoint --------------------
app.get("/api/slots", async (req, res) => {
  const date = String(req.query.date || "");
  const guests = Number(req.query.guests || 1);
  if (!date) return res.status(400).json({ error: "Missing date" });

  const cfg = readConfig();

  // sunday closed?
  const dObj = new Date(date + "T00:00:00");
  if (cfg.sundayClosed && dObj.getDay() === 0) return res.json([]);

  try {
    const { reservations, closures } = await loadReservationsAndClosuresForDate(date);

    function isInClosure(start: Date, end: Date) {
      for (const c of closures) {
        if (overlaps(start, end, new Date(c.startTs), new Date(c.endTs))) return true;
      }
      return false;
    }

    const slots: Array<{ time: string; allowed: boolean; remaining: number }> = [];

    function generateRange(startHHMM: string, endHHMM: string, durationMin: number) {
      const step = cfg.slotStepMin;
      let p = parseTimeToDate(date, startHHMM);
      const endLimit = parseTimeToDate(date, endHHMM);
      while (addMinutes(p, durationMin) <= endLimit) {
        const start = new Date(p);
        const end = addMinutes(start, durationMin);

        if (isInClosure(start, end)) {
          p = addMinutes(p, step);
          continue;
        }

        let used = 0;
        for (const r of reservations) {
          if (r.status !== "confirmed") continue;
          if (overlaps(start, end, new Date(r.startTs), new Date(r.endTs))) used += r.guests;
        }

        const remaining = Math.max(0, cfg.onlineSeatsCap - used);
        const allowed = remaining >= guests;
        const hh = pad2(start.getHours());
        const mm = pad2(start.getMinutes());
        slots.push({ time: `${hh}:${mm}`, allowed, remaining });
        p = addMinutes(p, step);
      }
    }

    generateRange(cfg.openLunchStart, cfg.openLunchEnd, cfg.openLunchDurationMin);
    generateRange(cfg.openDinnerStart, cfg.openDinnerEnd, cfg.openDinnerDurationMin);

    // merge by time (take max remaining, allowed if either allowed)
    const map = new Map<string, { time: string; allowed: boolean; remaining: number }>();
    for (const s of slots) {
      if (!map.has(s.time)) map.set(s.time, { ...s });
      else {
        const ex = map.get(s.time)!;
        ex.allowed = ex.allowed || s.allowed;
        ex.remaining = Math.max(ex.remaining, s.remaining);
      }
    }
    const out = Array.from(map.values()).sort((a, b) => (a.time > b.time ? 1 : -1));
    return res.json(out);
  } catch (err) {
    console.error("GET /api/slots err", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Create reservation --------------------
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes, isWalkIn } = req.body || {};
  if (!date || !time || !firstName || !name) return res.status(400).json({ error: "Missing required fields" });

  const cfg = readConfig();
  try {
    const start = parseTimeToDate(date, time);

    // decide duration based on slot falling in Lunch or Dinner
    const lunchStart = parseTimeToDate(date, cfg.openLunchStart);
    const lunchEnd = parseTimeToDate(date, cfg.openLunchEnd);
    const dinnerStart = parseTimeToDate(date, cfg.openDinnerStart);
    const dinnerEnd = parseTimeToDate(date, cfg.openDinnerEnd);

    let durationMin = cfg.openLunchDurationMin;
    if (start >= dinnerStart && start <= dinnerEnd) durationMin = cfg.openDinnerDurationMin;
    else if (start >= lunchStart && start <= lunchEnd) durationMin = cfg.openLunchDurationMin;

    const end = addMinutes(start, durationMin);

    // check closures overlap
    const closures = await prisma.closure.findMany({
      where: {
        AND: [
          { startTs: { lt: end } },
          { endTs: { gt: start } },
        ],
      },
    });
    if (closures.length > 0) return res.status(400).json({ error: "Selected time lies in a closed period" });

    // sum overlapping confirmed reservations
    const overlapping = await prisma.reservation.findMany({
      where: {
        date,
        status: "confirmed",
        AND: [
          { startTs: { lt: end } },
          { endTs: { gt: start } },
        ],
      },
    });
    let used = 0;
    for (const r of overlapping) used += r.guests;
    if (used + Number(guests) > cfg.onlineSeatsCap) {
      return res.status(409).json({ error: "Not enough capacity for this slot" });
    }

    const cancelToken = Math.random().toString(36).slice(2, 10);

    const created = await prisma.reservation.create({
      data: {
        date,
        time,
        startTs: start,
        endTs: end,
        firstName,
        name,
        email: email || "",
        phone: phone || "",
        guests: Number(guests),
        notes: notes || "",
        isWalkIn: !!isWalkIn,
        cancelToken,
      },
    });

    // optionally: send confirmation email here - but out of scope
    return res.json({ ok: true, id: created.id });
  } catch (err) {
    console.error("POST /api/reservations err", err);
    return res.status(500).json({ error: "Failed to create reservation" });
  }
});

// -------------------- Admin: list reservations for UI --------------------
app.get("/api/admin/reservations", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) return res.status(400).json({ error: "Missing date" });
  try {
    const list = await prisma.reservation.findMany({
      where: { date },
      orderBy: { startTs: "asc" },
    });

    // Add derived fields: visit count and discount placeholder
    const enhanced = list.map((r) => ({
      id: r.id,
      date: r.date,
      time: r.time,
      firstName: r.firstName,
      name: r.name,
      email: r.email,
      phone: r.phone,
      guests: r.guests,
      status: r.status,
      isWalkIn: r.isWalkIn,
      createdAt: r.createdAt,
      // visit and discount are placeholders - if you track visits you can compute here
      visitCount: 1,
      discount: null,
    }));

    return res.json(enhanced);
  } catch (err) {
    console.error("GET /api/admin/reservations err", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Admin: walk-in create (quick) --------------------
app.post("/api/admin/walkin", async (req, res) => {
  const { date, time, guests, secret } = req.body || {};
  const cfg = readConfig();
  if (cfg.adminSecret && secret !== cfg.adminSecret) return res.status(403).json({ error: "Forbidden" });
  if (!date || !time || !guests) return res.status(400).json({ error: "Missing fields" });

  try {
    const start = parseTimeToDate(date, time);
    const duration = cfg.openLunchDurationMin; // use standard or detect as above
    const end = addMinutes(start, duration);

    const overlapping = await prisma.reservation.findMany({
      where: {
        date,
        status: "confirmed",
        AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }],
      },
    });
    let used = 0;
    for (const r of overlapping) used += r.guests;
    if (used + Number(guests) > cfg.onlineSeatsCap) {
      return res.status(409).json({ error: "Not enough capacity" });
    }

    const created = await prisma.reservation.create({
      data: {
        date,
        time,
        startTs: start,
        endTs: end,
        firstName: "Walk In",
        name: "walkin",
        email: "walkin@noxama.local",
        phone: "",
        guests: Number(guests),
        notes: "walk-in",
        isWalkIn: true,
      },
    });
    return res.json({ ok: true, reservation: created });
  } catch (err) {
    console.error("POST /api/admin/walkin err", err);
    return res.status(500).json({ error: "Failed to create walk-in" });
  }
});

// -------------------- Admin: export CSV (simple) --------------------
app.get("/api/admin/export", async (req, res) => {
  const date = String(req.query.date || "");
  if (!date) return res.status(400).json({ error: "Missing date" });
  try {
    const list = await prisma.reservation.findMany({ where: { date }, orderBy: { startTs: "asc" } });
    const rows = [
      ["date", "time", "firstName", "name", "email", "phone", "guests", "status", "notes"],
      ...list.map((r) => [r.date, r.time, r.firstName, r.name, r.email, r.phone, String(r.guests), String(r.status), r.notes || ""]),
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    res.setHeader("Content-Disposition", `attachment; filename="reservations-${date}.csv"`);
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.send(csv);
  } catch (err) {
    console.error("GET /api/admin/export err", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// -------------------- Start server --------------------
const port = Number(process.env.PORT || 10000);
app.listen(port, () => {
  console.log(`Server running on ${port}`);
});
