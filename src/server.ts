import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { format, addMinutes, addHours } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

// *** MailerSend HTTP API ***
import { sendEmail, verifyMailer, fromAddress } from "./mailer";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";

const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

const PORT = Number(process.env.PORT || 4020);
const BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.BASE_URL ||
  `http://localhost:${PORT}`;

const MAX_SEATS_TOTAL = Number(
  process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48
);
const MAX_SEATS_RESERVABLE = Number(
  process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40
);

function hourFrom(v: string | undefined, fallback: number) {
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}
const OPEN_HOUR = hourFrom(
  process.env.OPEN_HOUR || process.env.OPEN_LUNCH_START,
  10
);
const CLOSE_HOUR = hourFrom(
  process.env.CLOSE_HOUR || process.env.OPEN_DINNER_END,
  22
);
const SUNDAY_CLOSED =
  String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// ---------- helpers ----------
function normalizeYmd(input: string): string {
  const s = String(input || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const [dd, mm, yy] = s.split(".").map(Number);
    return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) {
    const [mm, dd, yy] = s.split("/").map(Number);
    return `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime()))
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
      2,
      "0"
    )}-${String(d.getDate()).padStart(2, "0")}`;
  return "";
}

function isSundayYmd(ymd: string) {
  const { y, m, d } = splitYmd(ymd);
  return localDate(y, m, d).getDay() === 0;
}

async function overlapping(dateYmd: string, start: Date, end: Date) {
  return prisma.reservation.findMany({
    where: {
      date: dateYmd,
      status: { in: ["confirmed", "noshow"] },
      AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }],
    },
  });
}
async function sumsForInterval(dateYmd: string, start: Date, end: Date) {
  const list = await overlapping(dateYmd, start, end);

  const reserved = list
    .filter((r: any) => !r.isWalkIn)
    .reduce((s: number, r: any) => s + r.guests, 0);

  const walkins = list
    .filter((r: any) => r.isWalkIn)
    .reduce((s: number, r: any) => s + r.guests, 0);

  return { reserved, walkins, total: reserved + walkins };
}

async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok: false, reason: "Ungueltige Zeit" };
  if (SUNDAY_CLOSED && isSundayYmd(norm))
    return { ok: false, reason: "Sonntag geschlossen" };

  const start = localDateFrom(norm, timeHHmm);
  if (isNaN(start.getTime())) return { ok: false, reason: "Ungueltige Zeit" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y, m, d } = split
