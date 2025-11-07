import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { nanoid } from "nanoid";
import XLSX from "xlsx";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { addMinutes, addHours, differenceInMinutes, format } from "date-fns";

dotenv.config();

/* ───────────────────────── App / Prisma / Static ───────────────────────── */
const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

/* ───────────────────────────── Konfiguration ───────────────────────────── */
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const VENUE_ADDRESS = process.env.VENUE_ADDRESS || "Moo 4 Lamai Beach, 84310 Suratthani, Thailand";
const VENUE_PHONE = process.env.VENUE_PHONE || "+66 077 270 675";
const VENUE_EMAIL = process.env.VENUE_EMAIL || "info@noxamasamui.com";

const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || "/logo-hero.png";
const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || "";  // 1200x400 Banner
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_ADDR = process.env.MAIL_FROM_ADDRESS || VENUE_EMAIL;

const OPEN_HOUR = num(process.env.OPEN_HOUR, 10);
const CLOSE_HOUR = num(process.env.CLOSE_HOUR, 22);
const SLOT_INTERVAL = num(process.env.SLOT_INTERVAL, 15);   // min
const SUNDAY_CLOSED = strBool(process.env.SUNDAY_CLOSED, true);

// === NEU: wie lange eine Reservierung den Tisch blockiert (in Minuten)
// Umgebung: OPEN_DINNER_DURATION_MIN, Default 150
const RESERVATION_DURATION_MIN = num(process.env.OPEN_DINNER_DURATION_MIN, 150);

const MAX_SEATS_TOTAL = num(process.env.MAX_SEATS_TOTAL, 48);
const MAX_SEATS_RESERVABLE = num(process.env.MAX_SEATS_RESERVABLE, 40);
const MAX_ONLINE_GUESTS = num(process.env.MAX_ONLINE_GUESTS, 10);
const WALKIN_BUFFER = num(process.env.WALKIN_BUFFER, 8);

const ADMIN_TO =
  String(process.env.ADMIN_EMAIL || "") ||
  String(process.env.MAIL_TO_ADMIN || "") ||
  String(process.env.SMTP_USER || "") ||
  FROM_ADDR;

const ADMIN_RESET_KEY = process.env.ADMIN_RESET_KEY || "";

/* ────────────────────────────── Mailer (SMTP) ──────────────────────────── */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});
async function sendMail(to: string, subject: string, html: string) {
  await transporter.sendMail({ from: `"${FROM_NAME}" <${FROM_ADDR}>`, to, subject, html });
}

/* ───────────────────────────────── Helpers ─────────────────────────────── */
function num(v: any, fb: number) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function strBool(v: any, fb = false) { if (v==null) return fb; return String(v).trim().toLowerCase() === "true"; }
function pad2(n: number) { return String(n).padStart(2, "0"); }

function normalizeYmd(input: string): string {
  const s = String(input || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const [dd, mm, yy] = s.split(".").map(Number);
    return `${yy}-${pad2(mm)}-${pad2(dd)}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime()))
    return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  return "";
}
function splitYmd(ymd: string){ const [y,m,d] = ymd.split("-").map(Number); return {y,m,d}; }
function localDate(y:number,m:number,d:number,hh=0,mm=0,ss=0){ return new Date(y, m-1, d, hh, mm, ss); }
function localDateFrom(ymd:string, hhmm:string){ const {y,m,d}=splitYmd(ymd); const [hh,mm]=hhmm.split(":").map(Number); return localDate(y,m,d,hh,mm,0); }
function isSunday(ymd:string){ const {y,m,d}=splitYmd(ymd); return localDate(y,m,d).getDay()===0; }

function slotListForDay(){ const out:string[]=[]; for(let h=OPEN_HOUR;h<CLOSE_HOUR;h++){ for(let m=0;m<60;m+=SLOT_INTERVAL){ out.push(`${pad2(h)}:${pad2(m)}`); } } return out; }

function capacityOnlineLeft(reserved:number, walkins:number){
  const effectiveWalkins = Math.max(0, walkins - WALKIN_BUFFER);
  return Math.max(0, MAX_SEATS_RESERVABLE - reserved - effectiveWalkins);
}

/* ───────────── DB-Queries: overlaps / sums / duration per slot ────────── */
async function overlapping(dateYmd: string, start: Date, end: Date) {
  return prisma.reservation.findMany({
    where: {
      date: dateYmd,
      status: { in: ["confirmed", "noshow"] },
      AND: [{ startTs: { lt:end } }, { endTs: { gt:start } }],
    },
  });
}
async function sumsForInterval(dateYmd: string, start: Date, end: Date) {
  const list = await overlapping(dateYmd, start, end);
  const reserved = list.filter(r=>!r.isWalkIn).reduce((s,r)=>s+r.guests,0);
  const walkins  = list.filter(r=> r.isWalkIn).reduce((s,r)=>s+r.guests,0);
  return { reserved, walkins, total: reserved + walkins };
}

// ─── NEU: slotDuration verwendet jetzt die KONFIGURIERBARE Reservierungsdauer
function slotDuration(_date:string, _time:string){
  return RESERVATION_DURATION_MIN;
}

/* ───────────────────────────── Slot-Erlaubnis ──────────────────────────── */
async function slotAllowed(date: string, time: string){
  const norm = normalizeYmd(date);
  if(!norm) return { ok:false, reason:"Invalid date" };
  if(SUNDAY_CLOSED && isSunday(norm)) return { ok:false, reason:"Closed on Sunday" };

  const start = localDateFrom(norm, time);
  if(isNaN(start.getTime())) return { ok:false, reason:"Invalid time" };
  const minutes = Math.max(SLOT_INTERVAL, slotDuration(norm, time));
  const end = addMinutes(start, minutes);

  const {y,m,d}=splitYmd(norm);
  const open  = localDate(y,m,d, OPEN_HOUR, 0, 0);
  const close = localDate(y,m,d, CLOSE_HOUR,0, 0);
  if(start < open) return { ok:false, reason:"Before opening" };
  if(end   > close) return { ok:false, reason:"After closing" };

  const blocked = await prisma.closure.findFirst({ where: { AND: [{ startTs: { lt:end } }, { endTs: { gt:start } }] } });
  if(blocked) return { ok:false, reason:"Blocked" };

  return { ok:true, norm, start, end, open, close, minutes };
}

/* ─────────────────────── Loyalty helpers ─────────────────────────── */
function loyaltyDiscountFor(visit: number): number {
  if (visit >= 15) return 15;
  if (visit >= 10) return 10;
  if (visit >= 5) return 5;
  return 0;
}
function loyaltyTeaseNext(visit: number): 0 | 5 | 10 | 15 {
  if (visit === 4) return 5;
  if (visit === 9) return 10;
  if (visit === 14) return 15;
  return 0;
}
function loyaltyUnlockedNow(visit: number): 0 | 5 | 10 | 15 {
  if (visit === 5) return 5;
  if (visit === 10) return 10;
  if (visit === 15) return 15;
  return 0;
}
function ordinal(n:number){
  const v=n%100; if(v>=11&&v<=13) return `${n}th`;
  const u=n%10; if(u===1) return `${n}st`; if(u===2) return `${n}nd`; if(u===3) return `${n}rd`; return `${n}th`;
}

/* ───────────────────────────── Mail-Templates ──────────────────────────── */
function emailHeader(logoUrl:string){
  if (MAIL_HEADER_URL) {
    return `
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
        <tr><td align="center" style="padding:0">
          <img src="${MAIL_HEADER_URL}" alt="${BRAND_NAME}"
               style="display:block;width:100%;max-width:640px;height:auto;border:0;outline:none;">
        </td></tr>
      </table>`;
  }
  return `
    <div style="max-width:640px;margin:0 auto 10px auto;padding:28px 0;background:
      radial-gradient(ellipse at center, rgba(179,130,47,0.18) 0%, rgba(179,130,47,0.08) 40%, rgba(255,255,255,0) 72%);
      text-align:center;">
      <img src="${logoUrl}" alt="${BRAND_NAME}" style="width:190px;height:auto;border:0;outline:none;" />
    </div>`;
}

/** Confirmation mail – jetzt MIT Besuchsnummer; Teaser 4/9/14; Feierblock 5/10/15 */
function confirmationHtml(p:{
  firstName:string; name:string; date:string; time:string; guests:number;
  cancelUrl:string; visitNo:number; currentDiscount:number;
}){
  const header = emailHeader(MAIL_LOGO_URL);

  let reward = "";
  if (p.currentDiscount === 15) {
    reward = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 Thank you so much! 🎉</div>
        <div style="font-size:16px;">From now on you enjoy a <b style="color:#b3822f;">15% loyalty thank-you</b>.</div>
      </div>`;
  } else if (p.currentDiscount === 10) {
    reward = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 Great news! 🎉</div>
        <div style="font-size:16px;">From now on you enjoy a <b style="color:#b3822f;">10% loyalty thank-you</b>.</div>
      </div>`;
  } else if (p.currentDiscount === 5) {
    reward = `
      <div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;">
        <div style="font-size:22px;margin-bottom:6px;">🎉 You made our day! 🎉</div>
        <div style="font-size:16px;">From now on you enjoy a <b style="color:#b3822f;">5% loyalty thank-you</b>.</div>
      </div>`;
  }

  const tease = loyaltyTeaseNext(p.visitNo);
  const teaser = tease ? `
    <div style="margin:16px 0;padding:12px 14px;background:#eef7ff;border:1px solid #cfe3ff;border-radius:10px;text-align:center;">
      <div style="font-size:18px;margin-bottom:6px;">Heads-up ✨</div>
      <div style="font-size:15px;">On your next visit you will receive a <b>${tease}% loyalty thank-you</b>.</div>
    </div>` : "";

  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 14px 0;">Your Reservation at ${BRAND_NAME}</h2>
    <p>Hi ${p.firstName} ${p.name},</p>
    <p>Thank you for your reservation. We look forward to welcoming you.</p>

    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Date</b> ${p.date}</p>
      <p style="margin:0;"><b>Time</b> ${p.time}</p>
      <p style="margin:0;"><b>Guests</b> ${p.guests}</p>
      <p style="margin:0;"><b>Address</b> ${VENUE_ADDRESS}</p>
    </div>

    <p style="margin:10px 0 0 0;text-align:center;opacity:.95;">This is your <b>${ordinal(p.visitNo)}</b> visit.</p>

    ${reward}
    ${teaser}

    <div style="margin-top:14px;padding:12px 14px;background:#fdeee9;border:1px solid #f3d0c7;border-radius:10px;">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>

    <p style="margin-top:18px;text-align:center;">
      <a href="${p.cancelUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Cancel reservation</a>
    </p>
    <p style="margin-top:16px;font-size:14px;text-align:center;">Warm regards from <b>${BRAND_NAME}</b></p>
  </div>`;
}

function canceledGuestHtml(p:{firstName:string;name:string;date:string;time:string;guests:number;rebookUrl:string;}){
  const header = emailHeader(MAIL_LOGO_URL);
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 14px 0;">We’ll miss you this round 😢</h2>
    <p>Hi ${p.firstName} ${p.name},</p>
    <p>Your reservation for <b>${p.guests}</b> on <b>${p.date}</b> at <b>${p.time}</b> has been canceled.</p>
    <p style="text-align:center;margin:16px 0;">
      <a href="${p.rebookUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Book your comeback</a>
    </p>
    <p>With warm regards,<br/><b>${BRAND_NAME}</b></p>
  </div>`;
}

function canceledAdminHtml(p:{ firstName:string; lastName:string; email:string; phone:string; guests:number; date:string; time:string; notes:string; }){
  const header = emailHeader(MAIL_LOGO_URL);
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 8px 0;">Reservation canceled</h2>
    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Guest</b> ${p.firstName} ${p.lastName} (${p.email})</p>
      <p style="margin:0;"><b>Phone</b> ${p.phone || "-"}</p>
      <p style="margin:0;"><b>Date</b> ${p.date} &nbsp; <b>Time</b> ${p.time}</p>
      <p style="margin:0;"><b>Guests</b> ${p.guests}</p>
      <p style="margin:0;"><b>Notes</b> ${p.notes || "-"}</p>
    </div>
    <p style="text-align:center;margin-top:10px;"><b>${BRAND_NAME}</b></p>
  </div>`;
}

/* ─────────────────────────────── Pages ─────────────────────────────────── */
app.get("/", (_req,res)=>res.sendFile(path.join(publicDir,"index.html")));
app.get("/admin", (_req,res)=>res.sendFile(path.join(publicDir,"admin.html")));

/* ─────────────────────────── Public Config ─────────────────────────────── */
app.get("/api/config", (_req,res)=>{
  res.json({
    brand: BRAND_NAME,
    address: VENUE_ADDRESS,
    phone: VENUE_PHONE,
    email: VENUE_EMAIL,
    maxOnlineGuests: MAX_ONLINE_GUESTS,
    mailLogoUrl: MAIL_LOGO_URL,
    mailHeaderUrl: MAIL_HEADER_URL,
  });
});

/* ───────────────────────────── Slots API ───────────────────────────────── */
app.get("/api/slots", async (req,res)=>{
  const date = normalizeYmd(String(req.query.date || ""));
  const guests = Number(req.query.guests || 1);
  if (!date) return res.json([]);

  const times = slotListForDay();
  const out:any[] = [];

  let anyOpen = false;
  for(const t of times){
    const allow = await slotAllowed(date, t);
    if (!allow.ok) {
      out.push({ time: t, canReserve: false, allowed: false, reason: allow.reason, left: 0 });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const leftOnline = capacityOnlineLeft(sums.reserved, sums.walkins);
    const canReserve = leftOnline >= guests && sums.total + guests <= MAX_SEATS_TOTAL;
    if (canReserve) anyOpen = true;
    out.push({ time: t, canReserve, allowed: canReserve, reason: canReserve ? null : "Fully booked", left: leftOnline });
  }

  if (!anyOpen && out.length > 0) {
    const sunday = SUNDAY_CLOSED && isSunday(date);
    if (sunday) {
      out.forEach(s => s.reason = "Closed on Sunday");
    } else {
      out.forEach(s => {
        if (s.reason === "Blocked" || s.reason == null) {
          s.reason = "Fully booked for this date. Please choose another day.";
        }
      });
    }
  }

  res.json(out);
});

/* ────────────────────────── Online-Reservierung ───────────────────────── */
app.post("/api/reservations", async (req,res)=>{
  try{
    const { date, time, firstName, name, email, phone, guests, notes } = req.body;
    const g = Number(guests || 0);
    if (!date || !time || !firstName || !name || !email || !g || g < 1)
      return res.status(400).json({ error: "Missing or invalid fields" });
    if (g > MAX_ONLINE_GUESTS)
      return res.status(400).json({ error: `Online bookings are limited to ${MAX_ONLINE_GUESTS} guests. Please contact us directly.` });

    const allow = await slotAllowed(String(date), String(time));
    if (!allow.ok) return res.status(400).json({ error: allow.reason || "Not available" });

    const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
    const leftOnline = capacityOnlineLeft(sums.reserved, sums.walkins);
    if (g > leftOnline) return res.status(400).json({ error: "Fully booked at this time. Please select another slot." });
    if (sums.total + g > MAX_SEATS_TOTAL) return res.status(400).json({ error: "Total capacity reached at this time." });

    const token = nanoid();
    const created = await prisma.reservation.create({
      data: {
        date: allow.norm!, time,
        startTs: allow.start!, endTs: allow.end!,
        firstName, name, email,
        phone: String(phone || ""), guests: g, notes: String(notes || ""),
        status: "confirmed", cancelToken: token, isWalkIn: false,
      },
    });

    // Loyalty: Besuchsnummer (confirmed + noshow, inkl. dieser Buchung)
    const visitNo = await prisma.reservation.count({
      where: { email: created.email, status: { in: ["confirmed", "noshow"] } },
    });
    const currentDiscount = loyaltyDiscountFor(visitNo);
    const unlocked = loyaltyUnlockedNow(visitNo);
    const teaseNext = loyaltyTeaseNext(visitNo);

    // Guest mail (mit Besuchsnummer, Teaser 4/9/14, Feierblock 5/10/15)
    const cancelUrl = `${BASE_URL}/cancel/${token}`;
    const html = confirmationHtml({
      firstName: created.firstName,
      name: created.name,
      date: created.date,
      time: created.time,
      guests: created.guests,
      cancelUrl,
      visitNo,
      currentDiscount,
    });
    try { await sendMail(created.email, `${BRAND_NAME} — Reservation`, html); } catch (e) { console.error("mail guest", e); }

    // Admin Info (knapp)
    if (ADMIN_TO) {
      const aHtml = `<div style="font-family:Georgia,serif;color:#3a2f28">
        <p><b>New reservation</b></p>
        <p>${created.date} ${created.time} — ${created.guests}p — ${created.firstName} ${created.name} (${created.email})</p>
      </div>`;
      try { await sendMail(ADMIN_TO, `[NEW] ${created.date} ${created.time} — ${created.guests}p`, aHtml); } catch {}
    }

    // Response fuer Frontend (Popup bei Freischaltung 5/10/15)
    res.json({
      ok: true,
      reservation: created,
      visitNo,
      discount: currentDiscount,
      nowUnlockedTier: unlocked,   // 0 / 5 / 10 / 15
      nextMilestone: teaseNext,     // 0 / 5 / 10 / 15
    });
  }catch(err){
    console.error("reservation error:", err);
    res.status(500).json({ error: "Failed to create reservation" });
  }
});

/* ─────────────────────────────── Cancel ────────────────────────────────── */
app.get("/cancel/:token", async (req,res)=>{
  const r = await prisma.reservation.findUnique({ where: { cancelToken: req.params.token } });
  if (!r) return res.status(404).send("Not found");

  const already = r.status === "canceled";
  if (!already) {
    await prisma.reservation.update({ where: { id: r.id }, data: { status: "canceled" } });

    // guest
    if (r.email && r.email !== "walkin@noxama.local") {
      const gHtml = canceledGuestHtml({
        firstName: r.firstName, name: r.name, date: r.date, time: r.time, guests: r.guests, rebookUrl: `${BASE_URL}/`,
      });
      try { await sendMail(r.email, "We hope this goodbye is only for now 😢", gHtml); } catch {}
    }
    // admin
    if (ADMIN_TO) {
      const aHtml = canceledAdminHtml({
        firstName: r.firstName, lastName: r.name, email: r.email || "", phone: r.phone || "",
        guests: r.guests, date: r.date, time: r.time, notes: r.notes || "",
      });
      try { await sendMail(ADMIN_TO, `[CANCELED] ${r.date} ${r.time} — ${r.guests}p`, aHtml); } catch {}
    }
  }
  res.sendFile(path.join(publicDir, "cancelled.html"));
});

/* ───────────────────────────── Admin: Liste ────────────────────────────── */
app.get("/api/admin/reservations", async (req,res)=>{
  const date = normalizeYmd(String(req.query.date || ""));
  const view = String(req.query.view || "day");

  let list:any[] = [];
  if (view === "week" && date) {
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base); to.setDate(to.getDate() + 7);
    list = await prisma.reservation.findMany({
      where: { startTs: { gte: from, lt: to } },
      orderBy: [{ startTs: "asc" }, { date: "asc" }, { time: "asc" }],
    });
  } else if (view === "month" && date) {
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base); to.setMonth(to.getMonth() + 1);
    list = await prisma.reservation.findMany({
      where: { startTs: { gte: from, lt: to } },
      orderBy: [{ startTs: "asc" }, { date: "asc" }, { time: "asc" }],
    });
  } else {
    const where:any = date ? { date } : {};
    list = await prisma.reservation.findMany({ where, orderBy: [{ date:"asc" }, { time:"asc" }] });
  }

  // Loyalty-Felder ergänzen: visitCount + discount je E-Mail
  const emails = Array.from(new Set(list.map(r => r.email).filter(Boolean))) as string[];

*(file continues — rest unchanged; for brevity I'm omitting the unchanged tail of the server file which you already have. The only functional change is the top-of-file addition of `RESERVATION_DURATION_MIN` and slotDuration returning it. Keep the remainder of your server file as it was.)*
