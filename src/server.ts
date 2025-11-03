import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { PrismaClient, type Reservation, type Notice } from "@prisma/client";
import { nanoid } from "nanoid";
import XLSX from "xlsx";
import nodemailer from "nodemailer";
import dotenv from "dotenv";
import { addMinutes, differenceInMinutes, format } from "date-fns";
import { execSync } from "node:child_process";

dotenv.config();

/* ESM __dirname */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/* App / Prisma / Static */
const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

/* Konfiguration */
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "ROESTILAND BY NOXAMA SAMUI";
const VENUE_ADDRESS = process.env.VENUE_ADDRESS || "Moo 4 Lamai Beach, 84310 Suratthani, Thailand";
const VENUE_PHONE = process.env.VENUE_PHONE || "+66 077 270 675";
const VENUE_EMAIL = process.env.VENUE_EMAIL || "info@noxamasamui.com";

const MAIL_LOGO_URL = process.env.MAIL_LOGO_URL || "/logo-hero.png";
const MAIL_HEADER_URL = process.env.MAIL_HEADER_URL || "";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_ADDR = process.env.MAIL_FROM_ADDRESS || VENUE_EMAIL;

const OPEN_HOUR = num(process.env.OPEN_HOUR, 10);
const CLOSE_HOUR = num(process.env.CLOSE_HOUR, 22);
const SLOT_INTERVAL = num(process.env.SLOT_INTERVAL, 15);       // Auswahl-Intervall
const RES_DURATION_MIN = num(process.env.RES_DURATION_MIN, 90); // Sitzdauer
const SUNDAY_CLOSED = strBool(process.env.SUNDAY_CLOSED, true);

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

/* Loyalty Schwellen */
const L5 = 5, L10 = 10, L15 = 15;

/* Mailer */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: String(process.env.SMTP_SECURE || "true").toLowerCase() !== "false",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
});
async function sendMail(to: string, subject: string, html: string) {
  await transporter.sendMail({ from: `"${FROM_NAME}" <${FROM_ADDR}>`, to, subject, html });
}

/* Helpers */
function num(v: unknown, fb: number) { const n = Number(v); return Number.isFinite(n) ? n : fb; }
function strBool(v: unknown, fb = false) { if (v==null) return fb; return String(v).trim().toLowerCase()==="true"; }
function pad2(n: number){ return String(n).padStart(2,"0"); }

function normalizeYmd(input: string): string {
  const s = String(input || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) {
    const [dd, mm, yy] = s.split(".").map(Number);
    return `${yy}-${pad2(mm)}-${pad2(dd)}`;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
  return "";
}
function splitYmd(ymd: string){ const [y,m,d] = ymd.split("-").map(Number); return {y,m,d}; }
function localDate(y:number,m:number,d:number,hh=0,mm=0,ss=0){ return new Date(y, m-1, d, hh, mm, ss); }
function localDateFrom(ymd:string, hhmm:string){ const {y,m,d}=splitYmd(ymd); const [hh,mm]=hhmm.split(":").map(Number); return localDate(y,m,d,hh,mm,0); }
function isSunday(ymd:string){ const {y,m,d}=splitYmd(ymd); return localDate(y,m,d).getDay()===0; }

function slotListForDay(){
  const out:string[]=[];
  for(let h=OPEN_HOUR; h<CLOSE_HOUR; h++){
    for(let m=0; m<60; m+=SLOT_INTERVAL){
      out.push(`${pad2(h)}:${pad2(m)}`);
    }
  }
  return out;
}
function capacityOnlineLeft(reserved:number, walkins:number){
  const effectiveWalkins = Math.max(0, walkins - WALKIN_BUFFER);
  return Math.max(0, MAX_SEATS_RESERVABLE - reserved - effectiveWalkins);
}

/* DB helpers */
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
  const reserved = list.filter(r=>!r.isWalkIn).reduce((s,r)=>s+r.guests,0);
  const walkins  = list.filter(r=> r.isWalkIn).reduce((s,r)=>s+r.guests,0);
  return { reserved, walkins, total: reserved + walkins };
}
function slotDurationMinutes(){ return RES_DURATION_MIN; }

/* Slot-Erlaubnis */
async function slotAllowed(date: string, time: string){
  const norm = normalizeYmd(date);
  if(!norm) return { ok:false as const, reason:"Invalid date" as const };
  if(SUNDAY_CLOSED && isSunday(norm)) return { ok:false as const, reason:"Closed on Sunday" as const };

  const start = localDateFrom(norm, time);
  if(isNaN(start.getTime())) return { ok:false as const, reason:"Invalid time" as const };

  const minutes = slotDurationMinutes();
  const end = addMinutes(start, minutes);

  const {y,m,d}=splitYmd(norm);
  const open  = localDate(y,m,d, OPEN_HOUR, 0, 0);
  const close = localDate(y,m,d, CLOSE_HOUR,0, 0);
  if(start < open) return { ok:false as const, reason:"Before opening" as const };
  if(end   > close) return { ok:false as const, reason:"After closing" as const };

  const blocked = await prisma.closure.findFirst({ where: { AND: [{ startTs: { lt:end } }, { endTs: { gt:start } }] } });
  if(blocked) return { ok:false as const, reason:"Blocked" as const };

  return { ok:true as const, norm, start, end, open, close, minutes };
}

/* Loyalty helpers */
function loyaltyDiscountFor(nthBooking: number): number {
  if (nthBooking >= L15) return 15;
  if (nthBooking >= L10) return 10;
  if (nthBooking >= L5)  return 5;
  return 0;
}
function loyaltyTeaserFor(nthBooking: number): { nextAt: number; nextDiscount: number } | null {
  if (nthBooking === L5 - 1)  return { nextAt: L5,  nextDiscount: 5 };
  if (nthBooking === L10 - 1) return { nextAt: L10, nextDiscount: 10 };
  if (nthBooking === L15 - 1) return { nextAt: L15, nextDiscount: 15 };
  return null;
}

/* Mail-Templates */
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
function loyaltyBlockHTML(params: {
  nth: number;
  discount: number;
  teaser?: { nextAt: number; nextDiscount: number } | null;
}){
  const { nth, discount, teaser } = params;

  const badge = (text:string)=>`
    <div style="display:inline-block;padding:10px 14px;border-radius:999px;
      background:linear-gradient(90deg,#f4e3c8,#ecd1a0);color:#5b431a;font-weight:700;border:1px solid #e1c79a;">
      ${text}
    </div>`;

  if (discount > 0) {
    return `
      <div style="margin:14px 0;padding:14px 18px;border-radius:14px;background:#fff7eb;border:1px solid #edd9b9;">
        <p style="margin:0 0 6px 0;">${badge(`Booking #${nth}`)}</p>
        <h3 style="margin:6px 0 8px 0;">Thank you for your loyalty!</h3>
        <p style="margin:0;">You now enjoy a <b>${discount}% Loyalty Discount</b> for this and all future visits.</p>
      </div>`;
  }
  if (teaser) {
    return `
      <div style="margin:14px 0;padding:14px 18px;border-radius:14px;background:#eef7ec;border:1px solid #cfe5c9;">
        <p style="margin:0 0 6px 0;">${badge(`Booking #${nth}`)}</p>
        <h3 style="margin:6px 0 8px 0;">Almost there 🎉</h3>
        <p style="margin:0;">From your <b>${teaser.nextAt}. booking</b> onwards you will get a
          <b>${teaser.nextDiscount}% Loyalty Discount</b>. Thanks for being with us!</p>
      </div>`;
  }
  return `
    <div style="margin:14px 0;padding:12px 16px;border-radius:12px;background:#f3efe9;border:1px solid #e5dccf;">
      <p style="margin:0;">${badge(`Booking #${nth}`)} — we appreciate you!</p>
    </div>`;
}
function confirmationHtml(p:{
  firstName:string; name:string; date:string; time:string; guests:number; cancelUrl:string;
  nth:number; discount:number; teaser: {nextAt:number; nextDiscount:number} | null;
}){
  const header = emailHeader(MAIL_LOGO_URL);
  const loyalty = loyaltyBlockHTML({ nth: p.nth, discount: p.discount, teaser: p.teaser });
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 14px 0;">Your Reservation at ${BRAND_NAME}</h2>
    <p>Hi ${p.firstName} ${p.name},</p>
    <p>Thank you for your reservation. We look forward to welcoming you.</p>

    ${loyalty}

    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Date</b> ${p.date}</p>
      <p style="margin:0;"><b>Time</b> ${p.time}</p>
      <p style="margin:0;"><b>Guests</b> ${p.guests}</p>
      <p style="margin:0;"><b>Address</b> ${VENUE_ADDRESS}</p>
    </div>
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

/* Pages */
app.get("/health", async (_req, res) => {
  try { await prisma.$queryRaw`SELECT 1`; res.json({ ok:true }); }
  catch(e){ res.status(500).json({ ok:false, error:String(e) }); }
});
app.get("/", (_req: Request, res: Response)=>res.sendFile(path.join(publicDir,"index.html")));
app.get("/admin", (_req: Request, res: Response)=>res.sendFile(path.join(publicDir,"admin.html")));

/* Public Config */
app.get("/api/config", (_req, res)=>{
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

/* Slots API */
app.get("/api/slots", async (req, res)=>{
  const date = normalizeYmd(String(req.query.date || ""));
  const guests = Number(req.query.guests || 1);
  if (!date) return res.json([]);

  const times = slotListForDay();
  const out:any[] = [];

  for(const t of times){
    const allow = await slotAllowed(date, t);
    if (!allow.ok) {
      out.push({ time: t, canReserve: false, allowed: false, reason: allow.reason, left: 0 });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const leftOnline = capacityOnlineLeft(sums.reserved, sums.walkins);
    const canReserve = leftOnline >= guests && sums.total + guests <= MAX_SEATS_TOTAL;
    out.push({ time: t, canReserve, allowed: canReserve, reason: canReserve ? null : "Fully booked", left: leftOnline });
  }

  if (out.every(s=>!s.allowed)) {
    const sunday = SUNDAY_CLOSED && isSunday(date);
    if (sunday) out.forEach(s => s.reason = "Closed on Sunday");
    else out.forEach(s => { if (s.reason==="Blocked" || s.reason==null) s.reason = "Fully booked for this date. Please choose another day."; });
  }

  res.json(out);
});

/* Online-Reservierung */
app.post("/api/reservations", async (req, res)=>{
  try{
    const { date, time, firstName, name, email, phone, guests, notes } = req.body as any;
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

    // Loyalty
    const previousConfirmed = await prisma.reservation.count({
      where: { email: { equals: String(email), mode: "insensitive" }, status: "confirmed" }
    });
    const nth = previousConfirmed + 1;
    const discount = loyaltyDiscountFor(nth);
    const teaser = loyaltyTeaserFor(nth);

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

    const cancelUrl = `${BASE_URL}/cancel/${token}`;
    const html = confirmationHtml({
      firstName: created.firstName, name: created.name, date: created.date, time: created.time, guests: created.guests,
      cancelUrl, nth, discount, teaser
    });

    // FIX: normalize possible null email
    try { await sendMail(created.email || FROM_ADDR, `${BRAND_NAME} — Reservation #${nth}`, html); } catch (e) { console.error("mail guest", e); }

    if (ADMIN_TO) {
      const aHtml = `<div style="font-family:Georgia,serif;color:#3a2f28">
        <p><b>New reservation</b></p>
        <p>${created.date} ${created.time} — ${created.guests}p — ${created.firstName} ${created.name} (${created.email}) — Booking #${nth}${discount?` — ${discount}% loyalty`:``}</p>
      </div>`;
      try { await sendMail(ADMIN_TO, `[NEW] ${created.date} ${created.time} — ${created.guests}p`, aHtml); } catch {}
    }

    res.json({ ok:true, reservation: created, loyalty: { nth, discount } });
  }catch(err){
    console.error("reservation error:", err);
    res.status(500).json({ error: "Failed to create reservation" });
  }
});

/* Cancel */
app.get("/cancel/:token", async (req, res)=>{
  const r = await prisma.reservation.findUnique({ where: { cancelToken: req.params.token } });
  if (!r) return res.status(404).send("Not found");

  const already = r.status === "canceled";
  if (!already) {
    await prisma.reservation.update({ where: { id: r.id }, data: { status: "canceled" } });

    if (r.email && r.email !== "walkin@noxama.local") {
      const gHtml = canceledGuestHtml({
        firstName: r.firstName, name: r.name, date: r.date, time: r.time, guests: r.guests, rebookUrl: `${BASE_URL}/`,
      });
      try { await sendMail(r.email, "We hope this goodbye is only for now 😢", gHtml); } catch {}
    }
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

/* Admin: Liste */
app.get("/api/admin/reservations", async (req, res)=>{
  const date = normalizeYmd(String(req.query.date || ""));
  const view = String(req.query.view || "day");

  let list:Reservation[] = [];
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
  res.json(list);
});
app.delete("/api/admin/reservations/:id", async (req, res)=>{
  await prisma.reservation.delete({ where: { id: req.params.id } });
  res.json({ ok:true });
});
app.post("/api/admin/reservations/:id/noshow", async (req, res)=>{
  const r = await prisma.reservation.update({ where: { id: req.params.id }, data: { status:"noshow" }});
  res.json(r);
});

/* Admin: Walk-in */
app.post("/api/admin/walkin", async (req, res)=>{
  try{
    const { date, time, guests, notes } = req.body as any;
    const g = Number(guests || 0);
    if (!date || !time || !g || g < 1) return res.status(400).json({ error: "Invalid input" });

    const norm = normalizeYmd(String(date));
    const allow = await slotAllowed(norm, String(time));

    let startTs: Date, endTs: Date, open: Date, close: Date;
    if (allow.ok) {
      startTs = allow.start!; endTs = allow.end!; open = allow.open!; close = allow.close!;
    } else {
      const start = localDateFrom(norm, String(time));
      const { y,m,d } = splitYmd(norm);
      open = localDate(y,m,d, OPEN_HOUR,0,0);
      close = localDate(y,m,d, CLOSE_HOUR,0,0);
      if (isNaN(start.getTime()) || start < open) return res.status(400).json({ error: "Slot not available." });
      const minutes = Math.max(15, Math.min(RES_DURATION_MIN, differenceInMinutes(close, start)));
      startTs = start; endTs = addMinutes(start, minutes); if (endTs > close) endTs = close;
    }

    const sums = await sumsForInterval(norm, startTs, endTs);
    if (sums.total + g > MAX_SEATS_TOTAL) return res.status(400).json({ error: "Total capacity reached" });

    const r = await prisma.reservation.create({
      data: {
        date: norm, time: String(time), startTs, endTs,
        firstName:"Walk", name:"In", email:"walkin@noxama.local", phone:"",
        guests:g, notes:String(notes || ""), status:"confirmed", cancelToken:nanoid(), isWalkIn:true,
      },
    });

    res.json(r);
  }catch(err){
    console.error("walkin error:", err);
    res.status(500).json({ error: "Failed to save walk-in" });
  }
});

/* Admin: Closures */
app.post("/api/admin/closure", async (req, res)=>{
  try{
    const { startTs, endTs, reason } = req.body as any;
    const s = new Date(String(startTs).replace(" ", "T"));
    const e = new Date(String(endTs).replace(" ", "T"));
    if (isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({ error: "Invalid time range" });
    if (e <= s) return res.status(400).json({ error: "End must be after start" });
    const c = await prisma.closure.create({ data: { startTs:s, endTs:e, reason:String(reason || "Closed") } });
    res.json(c);
  }catch(err){
    console.error("Create closure error:", err);
    res.status(500).json({ error: "Failed to create block" });
  }
});
app.post("/api/admin/closure/day", async (req, res)=>{
  try{
    const date = normalizeYmd(String((req.body as any).date || ""));
    if (!date) return res.status(400).json({ error: "Invalid date" });
    const { y,m,d } = splitYmd(date);
    const s = localDate(y,m,d, OPEN_HOUR,0,0);
    const e = localDate(y,m,d, CLOSE_HOUR,0,0);
    const reason = String((req.body as any).reason || "Closed");
    const c = await prisma.closure.create({ data: { startTs:s, endTs:e, reason } });
    res.json(c);
  }catch(err){
    console.error("Block day error:", err);
    res.status(500).json({ error: "Failed to block day" });
  }
});
app.get("/api/admin/closure", async (_req, res)=>{
  try{
    const list = await prisma.closure.findMany({ orderBy: { startTs:"desc" } });
    res.json(list);
  }catch(err){
    console.error("List closure error:", err);
    res.status(500).json({ error: "Failed to load blocks" });
  }
});
app.delete("/api/admin/closure/:id", async (req, res)=>{
  try{ await prisma.closure.delete({ where: { id: req.params.id } }); res.json({ ok:true }); }
  catch(err){ console.error("Delete closure error:", err); res.status(500).json({ error: "Failed to delete block" }); }
});

/* Admin: Reset */
app.post("/api/admin/reset", async (req, res)=>{
  try{
    const { key } = (req.body || {}) as any;
    if (!ADMIN_RESET_KEY || key !== ADMIN_RESET_KEY) return res.status(403).json({ error: "Forbidden" });
    await prisma.reservation.deleteMany({});
    res.json({ ok:true });
  }catch(err){
    console.error("reset error:", err);
    res.status(500).json({ error: "Failed to reset" });
  }
});

/* Export */
app.get("/api/export", async (req, res)=>{
  try{
    const period = String(req.query.period || "weekly");
    const date = normalizeYmd(String(req.query.date || ""));
    const base = date ? new Date(date + "T00:00:00") : new Date();
    const from = new Date(base);
    const to   = new Date(base);

    switch(period){
      case "daily":   to.setDate(to.getDate()+1); break;
      case "weekly":  to.setDate(to.getDate()+7); break;
      case "monthly": to.setMonth(to.getMonth()+1); break;
      case "yearly":  to.setFullYear(to.getFullYear()+1); break;
      default:        to.setDate(to.getDate()+7); break;
    }

    const list = await prisma.reservation.findMany({
      where: { startTs: { gte: from, lt: to } },
      orderBy: [{ startTs:"asc" }, { date:"asc" }, { time:"asc" }],
    });

    const rows = list.map(r=>({
      Date: r.date, Time: r.time,
      FirstName: r.firstName, LastName: r.name,
      Email: r.email, Phone: r.phone || "",
      Guests: r.guests, Status: r.status,
      Notes: r.notes || "", WalkIn: r.isWalkIn ? "yes" : "",
      CreatedAt: r.startTs ? format(r.startTs, "yyyy-MM-dd HH:mm") : "",
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reservations");

    const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
    const fname = `reservations_${format(from,"yyyyMMdd")}_${period}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  }catch(err){
    console.error("Export error:", err);
    res.status(500).json({ error: "Export failed" });
  }
});

/* Notices */
function ymdInRange(ymd: string, from: string, to: string){ return ymd >= from && ymd <= to; }

app.get("/api/admin/notices", async (_req, res) => {
  const list = await prisma.notice.findMany({ orderBy: [{ startDate: "asc" }, { endDate: "asc" }] });
  res.json(list);
});
app.post("/api/admin/notices", async (req, res) => {
  try{
    const { id, startDate, endDate, title, message, requireAck, active } = (req.body || {}) as any;
    const s = normalizeYmd(String(startDate || "")); const e = normalizeYmd(String(endDate || ""));
    if (!s || !e) return res.status(400).json({ error: "Invalid date range" });
    if (e < s) return res.status(400).json({ error: "End must be after start" });
    if (!title || !message) return res.status(400).json({ error: "Title and message required" });

    let rec: Notice;
    if (id) {
      rec = await prisma.notice.update({ where: { id:String(id) }, data: { startDate:s, endDate:e, title:String(title), message:String(message), requireAck:!!requireAck, active:!!active } });
    } else {
      rec = await prisma.notice.create({ data: { startDate:s, endDate:e, title:String(title), message:String(message), requireAck:!!requireAck, active: active==null ? true : !!active } });
    }
    res.json(rec);
  }catch(e){
    console.error("Notice save error:", e);
    res.status(500).json({ error: "Failed to save notice" });
  }
});
app.delete("/api/admin/notices/:id", async (req, res) => {
  try{ await prisma.notice.delete({ where: { id: req.params.id } }); res.json({ ok: true }); }
  catch(e){ console.error("Notice delete error:", e); res.status(500).json({ error: "Failed to delete notice" }); }
});
app.get("/api/notices", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  if (!date) return res.json([]);
  const all = await prisma.notice.findMany({ where: { active: true } });
  res.json(all.filter(n => ymdInRange(date, n.startDate, n.endDate)));
});

/* Start */
function ensureSchema() {
  try {
    console.log("Sync DB schema with Prisma (db push)...");
    execSync("npx prisma db push --accept-data-loss", { stdio: "inherit" });
    console.log("DB schema synced.");
  } catch (e) {
    console.warn("DB push failed:", (e as Error).message);
  }
}
async function start(){
  ensureSchema();
  await prisma.$connect();
  try{ await transporter.verify(); }catch(e){ console.warn("SMTP verify failed:", (e as Error).message); }
  app.listen(PORT, "0.0.0.0", ()=>console.log(`Server running on ${PORT}`));
}
start().catch(err=>{ console.error("Fatal start error", err); process.exit(1); });
