// server.ts (modified only to add special-dates file storage + endpoints)
// ... (keep your existing imports) ...
import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
// nanoid removed (ESM causing require() error)
import { randomBytes } from "crypto";
import XLSX from "xlsx";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { addMinutes, addHours, differenceInMinutes, format } from "date-fns";
import fs from "fs/promises";  // <--- added for special-dates persistence

dotenv.config();

/* Minimal secure id generator (replaces nanoid) */
function generateId(size = 21): string {
  const buf = randomBytes(Math.ceil((size * 3) / 4));
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "").slice(0, size);
}

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

const RESERVATION_DURATION_MIN = num(process.env.RESERVATION_DURATION_MIN, 90);

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

/* ───────────────────────────── Mail-Templates ─────────────────────────── */
/* (kept identical to your provided templates) */
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

/* confirmationHtml, canceledGuestHtml, canceledAdminHtml unchanged - omitted for brevity in this snippet,
   but in your actual file leave them as they were in your original server.ts (we keep them unchanged). */

/* ────────────────────────────── Special-dates storage ─────────────────────────────
   Implement a small file-backed store for admin-managed date-notices. This avoids DB schema changes.
   File: public/special-dates.json
   Each entry: { date: "YYYY-MM-DD", title: "...", message: "..." }
   ------------------------------------------------------------------------------ */
const SD_FILE = path.join(publicDir, "special-dates.json");

async function readSpecialDates(): Promise<Array<{date:string,title?:string,message?:string}>> {
  try{
    const raw = await fs.readFile(SD_FILE, "utf8");
    const data = JSON.parse(raw);
    if(Array.isArray(data)) return data;
    return [];
  }catch(e){
    // if file missing, return empty
    return [];
  }
}
async function writeSpecialDates(list: Array<{date:string,title?:string,message?:string}>){
  try{
    await fs.writeFile(SD_FILE, JSON.stringify(list, null, 2), "utf8");
  }catch(e){
    console.error("Failed to write special-dates file", e);
    throw e;
  }
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
// ... unchanged reservation POST route, loyalty logic, etc. (keep your existing implementation) ...
// (In your file keep the reservation POST handler exactly as before; omitted here for brevity)
/* -- START: Wiederhergestellte Mail- / Popup-Templates (bitte unverändert einfügen) -- */

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

function createLoyaltyPopupHtml(visitNo:number, discount:number){
  const title = discount >= 15 ? "Unbelievable — 15% for you!" : (discount >= 10 ? "Awesome — 10% for you!" : "Nice — 5% for you!");
  const message = discount >= 15 ? `As of now you get ${discount}% off on every visit — thank you!` : `You've reached ${visitNo} visits — enjoy ${discount}% off on your next meal!`;
  return `
    <div style="font-family:Georgia,serif;color:#3a2f28;padding:18px;border-radius:12px;background:linear-gradient(180deg,#fffefc,#fff7ea);border:1px solid #ead6b6;max-width:640px;">
      <div style="font-size:22px;margin-bottom:8px;">${title}</div>
      <div style="font-size:15px;margin-bottom:12px;">${message}</div>
      <div style="font-size:13px;color:#6b5b4a;">Show this message at the host stand or mention your email to redeem</div>
    </div>`;
}

/* -- END: Wiederhergestellte Mail- / Popup-Templates -- */

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

    const token = generateId();
    const created = await prisma.reservation.create({
      data: {
        date: allow.norm!, time,
        startTs: allow.start!, endTs: allow.end!,
        firstName, name, email,
        phone: String(phone || ""), guests: g, notes: String(notes || ""),
        status: "confirmed", cancelToken: token, isWalkIn: false,
      },
    });

    const visitNo = await prisma.reservation.count({
      where: { email: created.email, status: { in: ["confirmed", "noshow"] } },
    });
    const currentDiscount = loyaltyDiscountFor(visitNo);
    const unlocked = loyaltyUnlockedNow(visitNo);
    const teaseNext = loyaltyTeaseNext(visitNo);

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

    if (ADMIN_TO) {
      const aHtml = `<div style="font-family:Georgia,serif;color:#3a2f28">
        <p><b>New reservation</b></p>
        <p>${created.date} ${created.time} — ${created.guests}p — ${created.firstName} ${created.name} (${created.email})</p>
      </div>`;
      try { await sendMail(ADMIN_TO, `[NEW] ${created.date} ${created.time} — ${created.guests}p`, aHtml); } catch {}
    }

    const showLoyaltyPopup = visitNo >= 5;
    const loyaltyPopupHtml = showLoyaltyPopup ? createLoyaltyPopupHtml(visitNo, currentDiscount) : null;

    res.json({
      ok: true,
      reservation: created,
      visitNo,
      discount: currentDiscount,
      nowUnlockedTier: unlocked,
      nextMilestone: teaseNext,
      showLoyaltyPopup,
      loyaltyPopupHtml
    });
    }catch(err){
    console.error("reservation error:", err);
    let details: string;
    if (err instanceof Error) {
      details = err.stack || err.message || String(err);
    } else {
      try { details = JSON.stringify(err); }
      catch { details = String(err); }
    }
    res.status(500).json({ error: "Failed to create reservation", details });
  }
});

/* ───────────────────────────── Cancel / Admin reservation endpoints ───────────────────────────── */
// Keep your existing cancel, admin reservation, walkin, closure handlers unchanged
// (copy them exactly from your previous server.ts; omitted here for brevity in this pasted excerpt)
// ... existing admin/reservation/walkin/closure endpoints remain as before ...

/* ───────────────────────────── Special-dates endpoints (PUBLIC + ADMIN) ───────────────────────── */
// Public lookup (frontend uses this on date change)
// GET /api/special-dates?date=YYYY-MM-DD  -> returns array of matching notices (usually 0 or 1)
app.get("/api/special-dates", async (req,res)=>{
  try{
    const dateQ = String(req.query.date || "").trim();
    const list = await readSpecialDates();
    if(dateQ){
      const norm = normalizeYmd(dateQ);
      const filtered = list.filter(x => normalizeYmd(x.date) === norm);
      return res.json(filtered);
    }
    res.json(list);
  }catch(e){
    console.error("GET special-dates", e);
    res.status(500).json([]);
  }
});

// Admin: list (returns all)
app.get("/api/admin/special-dates", async (_req,res)=>{
  try{
    const list = await readSpecialDates();
    res.json(list);
  }catch(e){
    console.error("admin list special-dates", e);
    res.status(500).json([]);
  }
});

// Admin: create / update (replace entry for same date)
app.post("/api/admin/special-date", async (req,res)=>{
  try{
    const date = normalizeYmd(String(req.body.date || ""));
    const title = String(req.body.title || "").trim();
    const message = String(req.body.message || "").trim();
    if(!date || !message) return res.status(400).json({ error: "date and message required" });

    const list = await readSpecialDates();
    const without = list.filter(x => normalizeYmd(x.date) !== date);
    without.push({ date, title, message });
    await writeSpecialDates(without);
    res.json({ ok:true });
  }catch(e){
    console.error("create special-date", e);
    res.status(500).json({ error: "Failed to save special-date" });
  }
});

// Admin: delete by date
app.delete("/api/admin/special-date/:date", async (req,res)=>{
  try{
    const date = normalizeYmd(String(req.params.date || ""));
    if(!date) return res.status(400).json({ error: "Invalid date" });
    const list = await readSpecialDates();
    const without = list.filter(x => normalizeYmd(x.date) !== date);
    await writeSpecialDates(without);
    res.json({ ok:true });
  }catch(e){
    console.error("delete special-date", e);
    res.status(500).json({ error: "Failed to delete special-date" });
  }
});

/* ───────────────────────────── Reminder Job / Export / Start ───────────────────────── */
/* Keep your reminder job, export, other endpoints and start() as in original server.ts.
   For brevity I'm not rewriting them here because they are unchanged; please keep them exactly
   as in your current server.ts (only the special-dates blocks above are new). */

/* If your file originally included the reminder job, export route and start routine, keep them. */

/* Example start (keep as in original): */
setInterval(async ()=>{
  // your existing reminder code (unchanged)
}, 30*60*1000);

async function start(){
  await prisma.$connect();
  try{ await transporter.verify(); }catch(e){ console.warn("SMTP verify failed:", (e as Error).message); }
  app.listen(PORT, "0.0.0.0", ()=>console.log(`Server running on ${PORT}`));
}
start().catch(err=>{ console.error("Fatal start error", err); process.exit(1); });
