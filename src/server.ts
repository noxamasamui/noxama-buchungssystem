// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { addHours, addMinutes } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

// ------------------------------------------------------
// App, Prisma, Static
// ------------------------------------------------------
const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

// ------------------------------------------------------
// Konfiguration
// ------------------------------------------------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_EMAIL =
  process.env.MAIL_FROM_ADDRESS || process.env.SMTP_USER || "info@noxamasamui.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";

// Sitzplätze
const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48);
const MAX_SEATS_RESERVABLE = Number(process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40);

// Öffnungszeiten
function hourFrom(v: string | undefined, fallback: number) {
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}
const OPEN_HOUR = hourFrom(process.env.OPEN_HOUR || "10", 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || "22", 22);
const SUNDAY_CLOSED = String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// ------------------------------------------------------
// Helpers
// ------------------------------------------------------
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
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
  const reserved = list.filter(r => !r.isWalkIn).reduce((s, r) => s + r.guests, 0);
  const walkins = list.filter(r => r.isWalkIn).reduce((s, r) => s + r.guests, 0);
  return { reserved, walkins, total: reserved + walkins };
}

async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok: false, reason: "Invalid time" };
  if (SUNDAY_CLOSED && isSundayYmd(norm)) return { ok: false, reason: "Sunday closed" };

  const start = localDateFrom(norm, timeHHmm);
  if (isNaN(start.getTime())) return { ok: false, reason: "Invalid time" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y, m, d } = splitYmd(norm);
  const open = localDate(y, m, d, OPEN_HOUR, 0, 0);
  const close = localDate(y, m, d, CLOSE_HOUR, 0, 0);
  if (start < open) return { ok: false, reason: "Before open" };
  if (end > close) return { ok: false, reason: "After close" };

  const blocked = await prisma.closure.findFirst({
    where: { AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }] },
  });
  if (blocked) return { ok: false, reason: "Blocked" };

  return { ok: true, start, end, minutes, norm };
}

// ------------------------------------------------------
// SMTP
// ------------------------------------------------------
async function sendEmailSMTP(to: string, subject: string, html: string) {
  await mailer().sendMail({ from: fromAddress(), to, subject, html });
}

// ------------------------------------------------------
// Pages
// ------------------------------------------------------
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));
app.get("/cancelled", (_req, res) => res.sendFile(path.join(publicDir, "cancelled.html")));

// ------------------------------------------------------
// Health / Test-Mail
// ------------------------------------------------------
app.get("/__health/email", async (_req, res) => {
  try { await verifyMailer(); res.json({ ok: true }); }
  catch (e: any) { res.status(500).json({ ok: false, error: String(e?.message || e) }); }
});

app.get("/api/test-mail", async (req, res) => {
  try {
    const to = String(req.query.to || ADMIN_EMAIL || FROM_EMAIL);
    await sendEmailSMTP(to, `${BRAND_NAME} — Test`, "<p>SMTP ok.</p>");
    res.send("OK");
  } catch (e: any) {
    res.status(500).send("SMTP error: " + String(e?.message || e));
  }
});

// ------------------------------------------------------
// Public Config (Kontakt)
// ------------------------------------------------------
app.get("/api/config", (_req, res) => {
  res.json({
    brand: BRAND_NAME,
    address: process.env.VENUE_ADDRESS || "",
    phone: process.env.VENUE_PHONE || "",
    email: process.env.VENUE_EMAIL || "",
  });
});

// ------------------------------------------------------
// Slots
// ------------------------------------------------------
app.get("/api/slots", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  if (!date) return res.json([]);
  const times = generateSlots(date, OPEN_HOUR, CLOSE_HOUR);
  const out: any[] = [];
  for (const t of times) {
    const allow = await slotAllowed(date, t);
    if (!allow.ok) {
      out.push({
        time: t, allowed: false, reason: allow.reason, minutes: 0,
        canReserve: false, reserved: 0, walkins: 0, total: 0,
      });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const canReserve = sums.reserved < MAX_SEATS_RESERVABLE && sums.total < MAX_SEATS_TOTAL;
    out.push({
      time: t,
      allowed: true,
      reason: null,
      minutes: allow.minutes,
      canReserve,
      reserved: sums.reserved,
      walkins: sums.walkins,
      total: sums.total,
    });
  }
  res.json(out);
});

// ------------------------------------------------------
// De-dup (einfacher Schutz gegen Doppelklick/Reload)
// ------------------------------------------------------
const recentPosts = new Map<string, number>(); // key -> ts
function seenRecently(key: string, seconds = 90) {
  const now = Date.now();
  const ts = recentPosts.get(key) || 0;
  if (now - ts < seconds * 1000) return true;
  recentPosts.set(key, now);
  return false;
}

// ------------------------------------------------------
// Reservationen
// ------------------------------------------------------
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;

  // idempotent key
  const idemKey = `${String(email).toLowerCase()}|${String(date)}|${String(time)}|${String(guests)}`;
  if (seenRecently(idemKey)) return res.json({ ok: true, dedup: true });

  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) return res.status(400).json({ error: allow.reason || "Not available" });

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
    return res.status(400).json({ error: "This time is fully booked for reservations." });
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "We are full at this time." });

  const token = nanoid();
  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!,
      time,
      startTs: allow.start!,
      endTs: allow.end!,
      firstName,
      name,
      email,
      phone,
      guests: Number(guests),
      notes,
      status: "confirmed",
      cancelToken: token,
      isWalkIn: false,
    },
  });

  const cancelUrl = `${BASE_URL}/cancel/${token}`;

  // Besuchszähler
  const pastVisits = await prisma.reservation.count({
    where: { email: created.email, status: "confirmed", startTs: { lt: created.startTs } },
  });
  const { teaser, reward } = loyaltyText(pastVisits + 1);

  const htmlGuest = confirmationHtml({
    firstName: created.firstName,
    name: created.name,
    date: created.date,
    time: created.time,
    guests: created.guests,
    cancelUrl,
    pastVisits: pastVisits + 1,
    teaser,
    reward,
  });

  const htmlAdmin = adminNewHtml(created, pastVisits + 1, reward);

  try {
    await sendEmailSMTP(created.email, `${BRAND_NAME} — Reservation`, htmlGuest);
    if (ADMIN_EMAIL) await sendEmailSMTP(ADMIN_EMAIL, `New reservation — ${created.date} ${created.time} — ${created.guests}p`, htmlAdmin);
  } catch (e) {
    console.error("Mail error:", e);
  }

  res.json({ ok: true, reservation: created });
});

// ------------------------------------------------------
// Cancel
// ------------------------------------------------------
app.get("/cancel/:token", async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { cancelToken: req.params.token } });
  if (!r) return res.status(404).send("Not found");

  // idempotent cancel notify
  if (!seenRecently("cancel|" + r.cancelToken)) {
    const htmlAdmin = adminCancelHtml(r);
    const htmlGuest = guestCancelHtml(r);

    try {
      if (ADMIN_EMAIL) await sendEmailSMTP(ADMIN_EMAIL, "Guest canceled reservation — FYI", htmlAdmin);
      await sendEmailSMTP(r.email, "We hope this goodbye is only for now 😢", htmlGuest);
    } catch (e) {
      console.error("Cancel mail error:", e);
    }
  }

  await prisma.reservation.update({ where: { id: r.id }, data: { status: "canceled" } });
  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// ------------------------------------------------------
// Mail HTML
// ------------------------------------------------------
type ConfirmArgs = {
  firstName: string;
  name: string;
  date: string;
  time: string;
  guests: number;
  cancelUrl: string;
  pastVisits: number;
  teaser: string;
  reward: string;
};

function mailShell(inner: string) {
  // Weißer Hintergrund – keine beige Ränder
  const banner = process.env.MAIL_BANNER_URL || "https://i.imgur.com/LQ4nzwd.png";
  return `
  <div style="background:#ffffff;color:#3a2f28;font-family: Georgia, 'Times New Roman', serif; padding:0;margin:0;">
    <div style="max-width:680px;margin:0 auto;">
      <img src="${banner}" alt="Banner" style="display:block;width:100%;max-width:680px;height:auto;margin:0 auto 12px auto;border-radius:12px;" />
      ${inner}
    </div>
  </div>`;
}

function confirmationHtml(a: ConfirmArgs) {
  const site = BRAND_NAME;
  const visitLine = `<p style="margin:0 0 10px 0;">This is your <b>${a.pastVisits}${suffix(a.pastVisits)}</b> visit.</p>`;
  const loyalty = a.reward
    ? `<div style="background:#fff2cc;border-radius:8px;padding:12px 14px;margin:12px 0 6px 0;">
         <p style="margin:0;font-size:16px;"><b>🎉 Thank you for coming back!</b></p>
         <p style="margin:6px 0 0 0;">Your loyalty means the world to us — please enjoy a <b>${a.reward}</b> loyalty thank-you.</p>
       </div>`
    : a.teaser
      ? `<div style="background:#f8f5ee;border-radius:8px;padding:12px 14px;margin:12px 0 6px 0;">
           ${a.teaser}
         </div>`
      : "";

  const inner = `
    <div style="background:#ffffff;border-radius:12px;padding:14px 18px;box-shadow:0 0 0 1px #eee;">
      <h2 style="margin:4px 0 14px 0; font-size:24px;">Your Reservation at ${site}</h2>
      <p style="margin:0 0 10px 0;">Hi ${a.firstName} ${a.name},</p>
      <p style="margin:0 0 14px 0;">Thank you for choosing <b>${site}</b>. We value loyalty deeply — regular guests are the heart of our little community.</p>

      <div style="background:#f9f1e6;border-radius:10px;padding:10px 12px;">
        <div style="margin:0 0 8px 0;"><b>Date</b><br>${a.date}</div>
        <div style="margin:0 0 8px 0;"><b>Time</b><br>${a.time}</div>
        <div><b>Guests</b><br>${a.guests}</div>
      </div>

      ${visitLine}
      ${loyalty}

      <div style="background:#fdeeee;border-radius:10px;padding:10px 12px;margin:12px 0;">
        <p style="margin:0;"><b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.</p>
      </div>

      <div style="text-align:center;margin:16px 0 10px;">
        <a href="${a.cancelUrl}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#e74c3c;color:#fff;text-decoration:none;">Cancel reservation</a>
      </div>

      <p style="margin:8px 0 0 0; font-size:13px; color:#7a6e65;">If the button doesn’t work, copy this link:<br>${a.cancelUrl}</p>

      <p style="margin:18px 0 0 0;">We can’t wait to welcome you!<br/><b>Warm greetings from ${site}</b></p>
    </div>`;

  return mailShell(inner);
}

function suffix(n: number) {
  if (n % 10 === 1 && n % 100 !== 11) return "st";
  if (n % 10 === 2 && n % 100 !== 12) return "nd";
  if (n % 10 === 3 && n % 100 !== 13) return "rd";
  return "th";
}

function loyaltyText(visit: number) {
  // Teaser-Vorschau bei 4 / 9 / 14; Reward in 5–9 / 10–14 / >=15
  if (visit >= 15) return { reward: "15%", teaser: "" };
  if (visit >= 10) return { reward: "10%", teaser: visit === 14 ? "You’re one visit away from <b>15%</b> loyalty thank-you on every visit after the next one." : "" };
  if (visit >= 5) return { reward: "5%", teaser: visit === 9 ? "Next time it will be <b>10%</b>." : "" };
  if (visit === 4) return { reward: "", teaser: "On your next visit you’ll unlock a <b>5%</b> loyalty thank-you." };
  return { reward: "", teaser: visit > 1 ? "Thank you for coming back to us." : "" };
}

function adminNewHtml(r: any, visits: number, reward: string) {
  const badge = reward ? ` — Discount ${reward}` : "";
  const logo = process.env.MAIL_LOGO_URL || "/logo.png";
  return mailShell(`
    <div style="background:#ffffff;border-radius:12px;padding:14px 18px;box-shadow:0 0 0 1px #eee;">
      <h2 style="margin:0 0 10px 0;">New reservation ✅</h2>
      <div style="background:#f9f1e6;border-radius:10px;padding:10px 12px;">
        <div><b>Guest</b> ${r.firstName} ${r.name} (${r.email})</div>
        <div><b>Phone</b> ${r.phone || "-"}</div>
        <div><b>Date</b> ${r.date}  <b>Time</b> ${r.time}</div>
        <div><b>Guests</b> ${r.guests}</div>
        <div><b>Total past visits</b> ${visits}${badge ? `  <b>${badge}</b>` : ""}</div>
        <div><b>Notes</b> ${r.notes || "-"}</div>
      </div>
    </div>`);
}

function adminCancelHtml(r: any) {
  return mailShell(`
    <div style="background:#ffffff;border-radius:12px;padding:14px 18px;box-shadow:0 0 0 1px #eee;">
      <h2 style="margin:0 0 10px 0;">Reservation canceled 🥺</h2>
      <div style="background:#f9f1e6;border-radius:10px;padding:10px 12px;">
        <div><b>Guest</b> ${r.firstName} ${r.name} (${r.email})</div>
        <div><b>Phone</b> ${r.phone || "-"}</div>
        <div><b>Date</b> ${r.date}  <b>Time</b> ${r.time}</div>
        <div><b>Guests</b> ${r.guests}</div>
        <div><b>Notes</b> ${r.notes || "-"}</div>
      </div>
    </div>`);
}

function guestCancelHtml(r: any) {
  const site = BRAND_NAME;
  const banner = process.env.MAIL_BANNER_URL || "https://i.imgur.com/LQ4nzwd.png";
  return `
  <div style="background:#ffffff;color:#3a2f28;font-family: Georgia, 'Times New Roman', serif;">
    <div style="max-width:680px;margin:0 auto;">
      <img src="${banner}" alt="Banner" style="display:block;width:100%;max-width:680px;height:auto;margin:0 auto 12px auto;border-radius:12px;" />
      <div style="background:#ffffff;border-radius:12px;padding:14px 18px;box-shadow:0 0 0 1px #eee;">
        <h2 style="margin:0 0 8px 0;">We’ll miss you this round 😢</h2>
        <p style="margin:0 0 10px 0;">Hi ${r.firstName} ${r.name},</p>
        <p style="margin:0 0 10px 0;">Your reservation for <b>${r.guests}</b> on <b>${r.date}</b> at <b>${r.time}</b> has been canceled.</p>
        <p style="margin:0 0 12px 0;">We completely understand — plans change. Just know that your favorite table will be waiting when you're ready to come back.</p>
        <div style="text-align:center;margin:16px 0 8px;">
          <a href="${BASE_URL}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#b08956;color:#fff;text-decoration:none;">Book your comeback</a>
        </div>
        <p style="margin:16px 0 0 0;">With warm regards,<br/><b>${site}</b></p>
      </div>
    </div>
  </div>`;
}

// ------------------------------------------------------
// Reminder Job (24h vor Start)
// ------------------------------------------------------
async function sendReminders() {
  const now = new Date();
  const from = addHours(now, 24);
  const to = addHours(now, 25);
  const list = await prisma.reservation.findMany({
    where: { status: "confirmed", isWalkIn: false, reminderSent: false, startTs: { gte: from, lt: to } },
  });
  for (const r of list) {
    const html = mailShell(`
      <div style="background:#ffffff;border-radius:12px;padding:14px 18px;box-shadow:0 0 0 1px #eee;">
        <h3>Friendly reminder for your reservation tomorrow</h3>
        <p><b>Date</b> ${r.date} — <b>Time</b> ${r.time} — <b>Guests</b> ${r.guests}</p>
        <p>If your plans change, please cancel here:<br/><a href="${BASE_URL}/cancel/${r.cancelToken}">${BASE_URL}/cancel/${r.cancelToken}</a></p>
      </div>`);
    try {
      await sendEmailSMTP(r.email, "Reservation reminder", html);
      await prisma.reservation.update({ where: { id: r.id }, data: { reminderSent: true } });
    } catch (e) {
      console.error("Reminder mail error:", e);
    }
  }
}
setInterval(sendReminders, 30 * 60 * 1000);

// ------------------------------------------------------
// Start
// ------------------------------------------------------
async function start() {
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on ${PORT}`));
}
start().catch(err => {
  console.error("Fatal start error", err);
  process.exit(1);
});
