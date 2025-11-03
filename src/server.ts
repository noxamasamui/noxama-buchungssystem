// src/server.ts
// Kompakter, geprüfter Express-Server mit korrekten Typen (ESM)

import express from "express";
import type { Request as ExpressRequest, Response as ExpressResponse } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";

import { PrismaClient } from "@prisma/client";
import { nanoid } from "nanoid";
import * as XLSX from "xlsx";

import dotenv from "dotenv";
import {
  addMinutes,
  addHours,
  differenceInMinutes,
  format,
} from "date-fns";

// mailsender (dein Shim aus src/mailsender.ts)
import { sendMailMS } from "./mailsender";


// ──────────────────────────────────────────────────────────────────────────────
// ESM-kompatibles __dirname und Pfade
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const publicDir = path.join(rootDir, "public");

// Globale Helfer (falls Number/String versehentlich überschattet werden)
const toNum = (v: unknown) => globalThis.Number(v);
const toStr = (v: unknown) => String(v);

// ──────────────────────────────────────────────────────────────────────────────
// App / Prisma / Middlewares
dotenv.config();

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(cors({ origin: true, credentials: true }));
app.use(express.static(publicDir));

// Typ-Aliase für Express
type Req = ExpressRequest;
type Res = ExpressResponse;

// ──────────────────────────────────────────────────────────────────────────────
// Konfiguration aus ENV
const PORT = toNum(process.env.PORT) || 10000;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const VENUE_ADDRESS =
  process.env.VENUE_ADDRESS || "Moo 4 Lamai Beach, 84310 Suratthani, Thailand";
const VENUE_EMAIL = process.env.VENUE_EMAIL || "info@noxamasamui.com";
const VENUE_PHONE = process.env.VENUE_PHONE || "+66 077 270 675";
const PUBLIC_LOGO_URL = process.env.PUBLIC_LOGO_URL || "";
const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || "";
const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || "";

const TZ = process.env.TZ || "Asia/Bangkok";
const SUNDAY_CLOSED = String(process.env.SUNDAY_CLOSED || "true") === "true";

const ONLINE_SEATS_CAP = toNum(process.env.ONLINE_SEATS_CAP) || 40;
const MAX_SEATS_TOTAL = toNum(process.env.MAX_SEATS_TOTAL) || 48;

// Öffnungszeiten – Lunch
const OPEN_LUNCH_START = process.env.OPEN_LUNCH_START || "10:00";
const OPEN_LUNCH_END = process.env.OPEN_LUNCH_END || "16:30";
const OPEN_LUNCH_DURATION_MIN = toNum(process.env.OPEN_LUNCH_DURATION_MIN) || 90;

// Öffnungszeiten – Dinner
const OPEN_DINNER_START = process.env.OPEN_DINNER_START || "17:00";
const OPEN_DINNER_END = process.env.OPEN_DINNER_END || "22:00";
const OPEN_DINNER_DURATION_MIN = toNum(process.env.OPEN_DINNER_DURATION_MIN) || 150;

// ──────────────────────────────────────────────────────────────────────────────
// Statische Seiten
app.get("/", (_req: Req, res: Res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req: Req, res: Res) => res.sendFile(path.join(publicDir, "admin.html")));
app.get("/cancelled", (_req: Req, res: Res) =>
  res.sendFile(path.join(publicDir, "cancelled.html"))
);

// ──────────────────────────────────────────────────────────────────────────────
// Hilfsfunktionen

function normalizeYmd(input: string): string {
  // akzeptiert 2025-11-24 oder 24.11.2025
  if (!input) return "";
  if (input.includes("-")) return input.slice(0, 10);
  const m = input.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return "";
}

function listSlotsForDate(dateISO: string): { time: string }[] {
  // baut 15-Minuten Slots für Lunch + Dinner
  const build = (hhmmStart: string, hhmmEnd: string) => {
    const [sh, sm] = hhmmStart.split(":").map((s) => toNum(s));
    const [eh, em] = hhmmEnd.split(":").map((s) => toNum(s));
    let cur = new Date(`${dateISO}T${String(sh).padStart(2, "0")}:${String(sm).padStart(2, "0")}:00`);
    const end = new Date(`${dateISO}T${String(eh).padStart(2, "0")}:${String(em).padStart(2, "0")}:00`);
    const out: { time: string }[] = [];
    while (cur <= end) {
      out.push({ time: `${String(cur.getHours()).padStart(2, "0")}:${String(cur.getMinutes()).padStart(2, "0")}` });
      cur = addMinutes(cur, 15);
    }
    return out;
  };

  return [
    ...build(OPEN_LUNCH_START, OPEN_LUNCH_END),
    ...build(OPEN_DINNER_START, OPEN_DINNER_END),
  ];
}

async function seatsTakenAt(dateISO: string, time: string): Promise<number> {
  const list = await prisma.reservation.findMany({
    where: { date: dateISO, time, status: { in: ["confirmed", "no-show"] } },
    select: { guests: true },
  });
  return list.reduce((a, r) => a + (r.guests || 0), 0);
}

async function isClosedAt(dateISO: string, time: string): Promise<string | null> {
  // Sonntag zu
  const d = new Date(`${dateISO}T00:00:00`);
  if (SUNDAY_CLOSED && d.getDay() === 0) return "Closed on Sunday";

  // Zeit in Date
  const [hh, mm] = time.split(":").map((s) => toNum(s));
  const ts = new Date(`${dateISO}T${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}:00`);

  const blocks = await prisma.closure.findMany({
    where: { startTs: { lte: ts }, endTs: { gte: ts } },
    select: { reason: true },
  });
  if (blocks.length) return blocks[0].reason || "Closed";
  return null;
}

// ──────────────────────────────────────────────────────────────────────────────
// Öffentliche API

app.get("/api/config", (_req: Req, res: Res) => {
  res.json({
    brandName: BRAND_NAME,
    address: VENUE_ADDRESS,
    email: VENUE_EMAIL,
    phone: VENUE_PHONE,
    tz: TZ,
    sundayClosed: SUNDAY_CLOSED,
    mailHeaderUrl: MAIL_HEADER_URL,
    mailLogoUrl: MAIL_LOGO_URL || PUBLIC_LOGO_URL,
    maxOnlineGuests: 10,
  });
});

app.get("/api/notices", async (req: Req, res: Res) => {
  const date = normalizeYmd(toStr(req.query?.date ?? ""));
  if (!date) return res.json([]);
  const startOfDay = new Date(`${date}T00:00:00`);
  const endOfDay = addHours(startOfDay, 24);

  const list = await prisma.notice.findMany({
    where: {
      active: true,
      startTs: { lte: endOfDay },
      endTs: { gte: startOfDay },
    },
    orderBy: { startTs: "desc" },
  });
  res.json(list);
});

app.get("/api/slots", async (req: Req, res: Res) => {
  const date = normalizeYmd(toStr(req.query?.date ?? ""));
  const guests = Math.min(10, Math.max(1, toNum(req.query?.guests ?? 1)));
  if (!date) return res.json([]);

  const slots = listSlotsForDate(date);
  const result = [];

  for (const s of slots) {
    const closedReason = await isClosedAt(date, s.time);
    if (closedReason) {
      result.push({ time: s.time, canReserve: false, reason: closedReason });
      continue;
    }
    const taken = await seatsTakenAt(date, s.time);
    const left = Math.max(0, ONLINE_SEATS_CAP - taken);
    result.push({
      time: s.time,
      canReserve: left >= guests,
      reason: left >= guests ? "" : "Fully booked at this time",
    });
  }
  res.json(result);
});

app.post("/api/reservations", async (req: Req, res: Res) => {
  const b = req.body as any;
  const date = normalizeYmd(toStr(b?.date ?? ""));
  const time = toStr(b?.time ?? "");
  const firstName = toStr(b?.firstName ?? "");
  const name = toStr(b?.name ?? "");
  const email = toStr(b?.email ?? "");
  const phone = b?.phone ? toStr(b.phone) : null;
  const guests = Math.min(10, Math.max(1, toNum(b?.guests ?? 1)));
  const notes = toStr(b?.notes ?? "");

  if (!date || !time || !firstName || !name || !email) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const closed = await isClosedAt(date, time);
  if (closed) return res.status(409).json({ error: closed });

  const taken = await seatsTakenAt(date, time);
  if (taken + guests > ONLINE_SEATS_CAP) {
    return res.status(409).json({ error: "Fully booked at this time. Please select another slot." });
  }

  const cancelToken = nanoid(24);
  const r = await prisma.reservation.create({
    data: {
      id: nanoid(16),
      date,
      time,
      firstName,
      name,
      email,
      phone,
      guests,
      notes,
      status: "confirmed",
      isWalkIn: false,
      cancelToken,
    },
  });

  // Mailversand: hier könntest du deinen mailsender verwenden
  // (Aus Stabilitätsgründen schicken wir in diesem Minimalserver nichts)

  res.json({ ok: true, id: r.id });
});

// ──────────────────────────────────────────────────────────────────────────────
// Admin: Reservations Übersicht

app.get("/api/admin/reservations", async (req: Req, res: Res) => {
  const base = normalizeYmd(toStr(req.query?.date ?? ""));
  const view = toStr(req.query?.view ?? "week"); // day|week|month
  if (!base) return res.json([]);

  const start = new Date(`${base}T00:00:00`);
  let end = addHours(start, 24);
  if (view === "week") end = addHours(start, 24 * 7);
  if (view === "month") end = addHours(start, 24 * 31);

  const list = await prisma.reservation.findMany({
    where: { date: { gte: format(start, "yyyy-MM-dd"), lte: format(end, "yyyy-MM-dd") } },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });
  res.json(list);
});

app.delete("/api/admin/reservations/:id", async (req: Req, res: Res) => {
  const id = toStr(req.params?.id ?? "");
  if (!id) return res.status(400).json({ error: "Missing id" });
  await prisma.reservation.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

app.post("/api/admin/reservations/:id/noshow", async (req: Req, res: Res) => {
  const id = toStr(req.params?.id ?? "");
  if (!id) return res.status(400).json({ error: "Missing id" });
  await prisma.reservation.update({ where: { id }, data: { status: "no-show" } }).catch(() => undefined);
  res.json({ ok: true });
});

// Walk-in
app.post("/api/admin/walkin", async (req: Req, res: Res) => {
  const b = req.body as any;
  const date = normalizeYmd(toStr(b?.date ?? ""));
  const time = toStr(b?.time ?? "");
  const guests = Math.max(1, toNum(b?.guests ?? 1));
  const notes = toStr(b?.notes ?? "");

  if (!date || !time) return res.status(400).json({ error: "Missing date/time" });

  const taken = await seatsTakenAt(date, time);
  if (taken + guests > MAX_SEATS_TOTAL) {
    return res.status(409).json({ error: "Capacity exceeded" });
  }

  await prisma.reservation.create({
    data: {
      id: nanoid(16),
      date,
      time,
      firstName: "Walk",
      name: "In",
      email: "walkin@noxama.local",
      phone: null,
      guests,
      notes,
      status: "confirmed",
      isWalkIn: true,
      cancelToken: nanoid(24),
    },
  });

  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Admin: Closures

app.get("/api/admin/closure", async (_req: Req, res: Res) => {
  const list = await prisma.closure.findMany({ orderBy: { startTs: "desc" } });
  res.json(list);
});

app.post("/api/admin/closure", async (req: Req, res: Res) => {
  const b = req.body as any;
  const startTs = new Date(toStr(b?.startTs ?? ""));
  const endTs = new Date(toStr(b?.endTs ?? ""));
  const reason = toStr(b?.reason ?? "Closed");
  if (!(startTs instanceof Date) || isNaN(startTs.getTime()) || !(endTs instanceof Date) || isNaN(endTs.getTime())) {
    return res.status(400).json({ error: "Invalid datetime" });
  }
  await prisma.closure.create({ data: { id: nanoid(12), startTs, endTs, reason } });
  res.json({ ok: true });
});

app.delete("/api/admin/closure/:id", async (req: Req, res: Res) => {
  const id = toStr(req.params?.id ?? "");
  if (!id) return res.status(400).json({ error: "Missing id" });
  await prisma.closure.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

app.post("/api/admin/closure/day", async (req: Req, res: Res) => {
  const b = req.body as any;
  const day = normalizeYmd(toStr(b?.date ?? ""));
  const reason = toStr(b?.reason ?? "Closed");
  if (!day) return res.status(400).json({ error: "Missing day" });

  const startTs = new Date(`${day}T00:00:00`);
  const endTs = addHours(startTs, 24);
  await prisma.closure.create({ data: { id: nanoid(12), startTs, endTs, reason } });
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Admin: Notices

app.get("/api/admin/notices", async (_req: Req, res: Res) => {
  const list = await prisma.notice.findMany({ orderBy: { startTs: "desc" } });
  res.json(list);
});

app.post("/api/admin/notices", async (req: Req, res: Res) => {
  const b = req.body as any;
  const startTs = new Date(toStr(b?.startTs ?? ""));
  const endTs = new Date(toStr(b?.endTs ?? ""));
  const title = toStr(b?.title ?? "");
  const message = toStr(b?.message ?? "");
  const active = !!b?.active;
  const requireAck = !!b?.requireAck;

  if (!(startTs instanceof Date) || isNaN(startTs.getTime()) || !(endTs instanceof Date) || isNaN(endTs.getTime())) {
    return res.status(400).json({ error: "Invalid data" });
  }
  const n = await prisma.notice.create({
    data: { id: nanoid(12), startTs, endTs, title, message, active, requireAck },
  });
  res.json(n);
});

app.patch("/api/admin/notices/:id", async (req: Req, res: Res) => {
  const id = toStr(req.params?.id ?? "");
  if (!id) return res.status(400).json({ error: "Missing id" });
  const patch: Record<string, any> = {};
  const allowed = ["title", "message", "active", "requireAck", "startTs", "endTs"] as const;
  for (const k of allowed) if (k in (req.body || {})) patch[k] = (req.body as any)[k];
  if ("startTs" in patch) patch.startTs = new Date(toStr(patch.startTs));
  if ("endTs" in patch) patch.endTs = new Date(toStr(patch.endTs));
  const n = await prisma.notice.update({ where: { id }, data: patch });
  res.json(n);
});

app.delete("/api/admin/notices/:id", async (req: Req, res: Res) => {
  const id = toStr(req.params?.id ?? "");
  if (!id) return res.status(400).json({ error: "Missing id" });
  await prisma.notice.delete({ where: { id } }).catch(() => undefined);
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// Export (Excel)

app.get("/api/export", async (req: Req, res: Res) => {
  const period = toStr(req.query?.period ?? "weekly"); // daily|weekly|monthly|yearly
  const base = normalizeYmd(toStr(req.query?.date ?? ""));
  if (!base) return res.status(400).send("Missing date");

  const start = new Date(`${base}T00:00:00`);
  let end = addHours(start, 24);
  if (period === "weekly") end = addHours(start, 24 * 7);
  if (period === "monthly") end = addHours(start, 24 * 31);
  if (period === "yearly") end = addHours(start, 24 * 366);

  const rows = await prisma.reservation.findMany({
    where: { date: { gte: format(start, "yyyy-MM-dd"), lte: format(end, "yyyy-MM-dd") } },
    orderBy: [{ date: "asc" }, { time: "asc" }],
  });

  const sheetRows = rows.map((r) => ({
    Date: r.date,
    Time: r.time,
    FirstName: r.firstName,
    LastName: r.name,
    Email: r.email,
    Phone: r.phone || "",
    Guests: r.guests,
    Status: r.status,
    Notes: r.notes || "",
    WalkIn: r.isWalkIn ? "yes" : "",
    CreatedAt: r.createdAt ? format(r.createdAt as any, "yyyy-MM-dd HH:mm") : "",
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(sheetRows);
  XLSX.utils.book_append_sheet(wb, ws, "Reservations");

  const fname = `reservations_${format(start, "yyyyMMdd")}_${period}.xlsx`;
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.send(buf);
});

// ──────────────────────────────────────────────────────────────────────────────
// Start
app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
