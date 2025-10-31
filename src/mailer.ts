// src/server.ts
import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { addMinutes, addHours, format } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";
import { verifyMailer, mailer, fromAddress } from "./mailer";

const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";
const FROM_EMAIL =
  process.env.MAIL_FROM_ADDRESS ||
  process.env.SMTP_USER ||
  "info@noxamasamui.com";

// WICHTIG: Kein Fallback auf SMTP_USER – verhindert doppelte Admin-Mails
const ADMIN_EMAIL = String(process.env.ADMIN_EMAIL || "").trim();

// Banner für E-Mails
const MAIL_BANNER_URL =
  process.env.MAIL_BANNER_URL ||
  "https://i.imgur.com/LQ4nzwd.png";

// Kapazitäten
const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || 48);
const MAX_SEATS_RESERVABLE = Number(process.env.MAX_SEATS_RESERVABLE || 40);

// Zeiten
function hourFrom(v: string | undefined, fallback: number) {
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}
const OPEN_HOUR = hourFrom(process.env.OPEN_HOUR || "10", 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || "22", 22);
const SUNDAY_CLOSED =
  String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// Helpers
function normalizeYmd(input: string): string {
  const s = String(input || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  if (!isNaN(d.getTime()))
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;
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
  if (start < open) return { ok: false, reason: "Before opening" };
  if (end > close) return { ok: false, reason: "After closing" };

  const blocked = await prisma.closure.findFirst({
    where: { AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }] },
  });
  if (blocked) return { ok: false, reason: "Blocked" };

  return { ok: true, start, end, minutes, norm };
}

// Mail
async function sendMail(to: string, subject: string, html: string) {
  await mailer().sendMail({ from: fromAddress(), to, subject, html });
}

function panel(label: string, value: string) {
  return `
  <div style="margin-bottom:10px">
    <div style="font-weight:bold;margin-bottom:4px">${label}</div>
    <div style="background:#f5e9db;padding:12px 14px;border-radius:8px">${value}</div>
  </div>`;
}
function emailShell(title: string, inner: string) {
  return `
  <div style="background:#d6c7b2;padding:32px 0;font-family:Georgia,'Times New Roman',serif;color:#3a2f28">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
      <tr><td align="center">
        <table role="presentation" width="680" cellspacing="0" cellpadding="0" style="background:#fff8f0;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.06)">
          <tr><td style="padding:0">
            <img src="${MAIL_BANNER_URL}" width="680" height="226" alt="Banner" style="display:block;width:100%;height:auto;border:0"/>
          </td></tr>
          <tr><td style="padding:24px 28px 8px 28px">
            <h1 style="margin:0 0 8px 0;font-size:24px;letter-spacing:.3px">${title}</h1>
          </td></tr>
          <tr><td style="padding:0 28px 28px 28px">${inner}</td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;
}
function loyaltyBlock(visits: number) {
  if (visits >= 15) return { head: "Thank you for coming back!", text: "Your loyalty means the world to us — please enjoy a 15% loyalty thank-you." };
  if (visits >= 10) return { head: "Thank you for coming back!", text: "Your loyalty means the world to us — please enjoy a 10% loyalty thank-you." };
  if (visits >= 5)  return { head: "Thank you for coming back!", text: "Your loyalty means the world to us — please enjoy a 5% loyalty thank-you." };
  return { head: "", text: `This is your ${visits}th visit. Thank you for coming back to us.` };
}
function loyaltyTeaser(visits: number) {
  if (visits === 4)  return "Heads-up: on your next visit you will receive 5% off.";
  if (visits === 9)  return "Heads-up: on your 10th visit you will receive 10% off.";
  if (visits === 14) return "Heads-up: from your 15th visit you will receive 15% off.";
  return "";
}
function reservationHtml(fn: string, ln: string, date: string, time: string, guests: number, cancelUrl: string, visits: number) {
  const lb = loyaltyBlock(visits);
  const teaser = loyaltyTeaser(visits);
  const inner = `
    <p style="margin:0 0 14px 0">Hi ${fn} ${ln},</p>
    <p style="margin:0 0 16px 0">Thank you for choosing <b>${BRAND_NAME}</b>. We value loyalty deeply — regular guests are the heart of our little community.</p>
    ${panel("Date", date)}${panel("Time", time)}${panel("Guests", String(guests))}
    ${lb.head ? `<div style="margin:16px 0 6px 0;font-weight:bold">${lb.head}</div>` : "" }
    <p style="margin:0 0 8px 0">${lb.text}</p>
    ${teaser ? `<p style="margin:0 0 12px 0">${teaser}</p>` : ""}

    <div style="margin:18px 0 10px 0;padding:12px 14px;background:#fdeee6;border-radius:8px">
      <div style="font-weight:bold;margin-bottom:4px">Punctuality</div>
      <div>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.</div>
    </div>

    <div style="text-align:center;margin-top:18px">
      <a href="${cancelUrl}" style="display:inline-block;padding:11px 16px;background:#b08a48;color:#fff;text-decoration:none;border-radius:8px">Cancel reservation</a>
    </div>
    <p style="font-size:12px;color:#6b5f53;margin-top:10px;text-align:center">If the button does not work, copy this link:<br>${cancelUrl}</p>
    <p style="margin:18px 0 0 0;text-align:center">We can’t wait to welcome you!<br/><b>Warm greetings from ${BRAND_NAME}</b></p>
  `;
  return emailShell(`Your Reservation at ${BRAND_NAME}`, inner);
}
function cancelGuestHtml(fn: string, ln: string, date: string, time: string, guests: number) {
  const inner = `
    <p style="margin:0 0 14px 0">Hi ${fn} ${ln},</p>
    <p style="margin:0 0 12px 0">Your reservation for <b>${guests}</b> on <b>${date}</b> at <b>${time}</b> has been canceled.</p>
    <p style="margin:0 0 14px 0">We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
    ${panel("Date", date)}${panel("Time", time)}${panel("Guests", String(guests))}
    <div style="text-align:center;margin-top:20px">
      <a href="${BASE_URL}/" style="display:inline-block;padding:11px 16px;background:#b08a48;color:#fff;text-decoration:none;border-radius:8px">Book your comeback</a>
    </div>
    <p style="margin:18px 0 0 0;text-align:center">With warm regards,<br/><b>${BRAND_NAME}</b></p>
  `;
  return emailShell("We’ll miss you this round", inner);
}
function adminNewHtml(r: any, visits: number) {
  const inner = `
    <p style="margin:0 0 10px 0">A guest just booked a table.</p>
    ${panel("Guest", `${r.firstName} ${r.name} (${r.email})`)}
    ${panel("Phone", r.phone || "-")}
    ${panel("Date", r.date)}
    ${panel("Time", r.time)}
    ${panel("Guests", String(r.guests))}
    ${panel("Notes", r.notes || "-")}
    ${panel("Total past visits", String(visits))}
  `;
  return emailShell("New reservation", inner);
}
function adminCancelHtml(r: any, visits: number) {
  const inner = `
    <p style="margin:0 0 10px 0">The guest has canceled their reservation.</p>
    ${panel("Guest", `${r.firstName} ${r.name} (${r.email})`)}
    ${panel("Phone", r.phone || "-")}
    ${panel("Date", r.date)}
    ${panel("Time", r.time)}
    ${panel("Guests", String(r.guests))}
    ${panel("Notes", r.notes || "-")}
    ${panel("Total past visits", String(visits))}
  `;
  return emailShell("Reservation canceled", inner);
}

// Seiten
app.get("/", (_req, res)=>res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res)=>res.sendFile(path.join(publicDir, "admin.html")));

// Health
app.get("/__health/email", async (_req,res)=>{
  try{ await verifyMailer(); res.json({ok:true}); }
  catch(e:any){ res.status(500).json({ok:false,error:String(e?.message||e)}); }
});

// Kontakt
app.get("/api/config", (_req,res)=>{
  res.json({
    brand: BRAND_NAME,
    address: process.env.VENUE_ADDRESS || "",
    phone: process.env.VENUE_PHONE || "",
    email: process.env.VENUE_EMAIL || "",
  });
});

// Slots
app.get("/api/slots", async (req,res)=>{
  const date = normalizeYmd(String(req.query.date||""));
  if(!date) return res.json([]);
  const times = generateSlots(date, OPEN_HOUR, CLOSE_HOUR);
  const out:any[]=[];
  for(const t of times){
    const allow = await slotAllowed(date,t);
    if(!allow.ok){
      out.push({ time:t, allowed:false, reason:allow.reason, canReserve:false, minutes:0, reserved:0, walkins:0, total:0 });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const canReserve = sums.reserved < MAX_SEATS_RESERVABLE && sums.total < MAX_SEATS_TOTAL;
    out.push({ time:t, allowed:true, reason:null, canReserve, minutes:allow.minutes, reserved:sums.reserved, walkins:sums.walkins, total:sums.total });
  }
  res.json(out);
});

// Visits zählen
async function visitCount(email:string){
  return prisma.reservation.count({ where:{ email, status:{ in:["confirmed","noshow"] } }});
}

// Reservation
app.post("/api/reservations", async (req,res)=>{
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if(!allow.ok){
    const reason = allow.reason;
    const msg =
      reason === "Blocked" ? "We are fully booked on this date. Please choose another day." :
      reason === "Sunday closed" ? "We are closed on Sundays." :
      (reason === "Before opening" || reason === "After closing") ? "This time is outside our opening hours." :
      "This slot is not available.";
    return res.status(400).json({ error: msg });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
    return res.status(400).json({ error: "We are fully booked at this time. Please choose another time." });
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "We are fully booked at this time. Please choose another time." });

  const prev = await visitCount(String(email));
  const token = nanoid();

  const created = await prisma.reservation.create({
    data:{
      date: allow.norm!, time,
      startTs: allow.start!, endTs: allow.end!,
      firstName, name, email, phone,
      guests:Number(guests), notes,
      status: "confirmed",
      cancelToken: token,
      isWalkIn: false
    }
  });

  const visits = prev + 1;
  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const html = reservationHtml(created.firstName, created.name, created.date, created.time, created.guests, cancelUrl, visits);

  try{
    await verifyMailer();
    await sendMail(created.email, `${BRAND_NAME} — Reservation`, html);

    // Admin-Mail (nur wenn gesetzt und nicht gleich Gast)
    if (ADMIN_EMAIL && ADMIN_EMAIL.toLowerCase() !== created.email.toLowerCase()) {
      const ah = adminNewHtml(created, visits);
      await sendMail(ADMIN_EMAIL, `New reservation — ${created.date} ${created.time} — ${created.guests}p`, ah);
    }
  }catch(e){ console.error("mail error", e); }

  res.json({ ok:true, reservation: created });
});

// Cancel
app.get("/cancel/:token", async (req,res)=>{
  const r = await prisma.reservation.findUnique({ where:{ cancelToken:req.params.token }});
  if(!r) return res.status(404).send("Not found");

  const visits = await visitCount(r.email);

  await prisma.reservation.update({ where:{ id:r.id }, data:{ status:"canceled" } });

  try{
    await verifyMailer();
    const gh = cancelGuestHtml(r.firstName, r.name, r.date, r.time, r.guests);
    await sendMail(r.email, "We’ll miss you this round", gh);

    if (ADMIN_EMAIL && ADMIN_EMAIL.toLowerCase() !== r.email.toLowerCase()) {
      const ah = adminCancelHtml(r, visits);
      await sendMail(ADMIN_EMAIL, "Guest canceled reservation — FYI", ah);
    }
  }catch(e){ console.error("cancel mail error", e); }

  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// Admin API (unverändert, nur Fehler sauber)
app.get("/api/admin/reservations", async (req,res)=>{
  const date = normalizeYmd(String(req.query.date||""));
  const view = String(req.query.view||"day");
  if(view === "week" && date){
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base); to.setDate(to.getDate()+7);
    const list = await prisma.reservation.findMany({
      where:{ startTs:{ gte:from }, endTs:{ lt:to } },
      orderBy:[{date:"asc"},{time:"asc"}]
    });
    return res.json(list);
  }
  const where:any = date ? { date } : {};
  const list = await prisma.reservation.findMany({ where, orderBy:[{date:"asc"},{time:"asc"}] });
  res.json(list);
});

app.delete("/api/admin/reservations/:id", async (req,res)=>{
  await prisma.reservation.delete({ where:{ id:req.params.id } });
  res.json({ ok:true });
});
app.post("/api/admin/reservations/:id/noshow", async (req,res)=>{
  const r = await prisma.reservation.update({ where:{ id:req.params.id }, data:{ status:"noshow" }});
  res.json(r);
});

// Closures / Export bleiben wie gehabt (unverändert)
app.post("/api/admin/closure", async (req,res)=>{
  const { startTs, endTs, reason } = req.body;
  const s = new Date(String(startTs).replace(" ","T"));
  const e = new Date(String(endTs).replace(" ","T"));
  if(isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({error:"Invalid time"});
  if(e<=s) return res.status(400).json({error:"Start after end"});
  const c = await prisma.closure.create({ data:{ startTs:s, endTs:e, reason:String(reason||"Closed") }});
  res.json(c);
});
app.post("/api/admin/closure/day", async (req,res)=>{
  const date = normalizeYmd(String(req.body.date||""));
  if(!date) return res.status(400).json({error:"Invalid date"});
  const {y,m,d} = splitYmd(date);
  const s = localDate(y,m,d,OPEN_HOUR,0,0);
  const e = localDate(y,m,d,CLOSE_HOUR,0,0);
  const c = await prisma.closure.create({ data:{ startTs:s, endTs:e, reason:String(req.body.reason||"Closed") }});
  res.json(c);
});
app.get("/api/admin/closure", async (_req,res)=>{
  const list = await prisma.closure.findMany({ orderBy:{ startTs:"desc"}});
  res.json(list);
});
app.delete("/api/admin/closure/:id", async (req,res)=>{
  await prisma.closure.delete({ where:{ id:req.params.id }});
  res.json({ ok:true });
});

app.get("/api/export", async (req,res)=>{
  const period = String(req.query.period||"daily");
  const norm = normalizeYmd(String(req.query.date||format(new Date(),"yyyy-MM-dd")));
  const base = new Date(norm+"T00:00:00");
  const start = new Date(base), end = new Date(base);
  if(period==="daily") end.setDate(end.getDate()+1);
  else if(period==="weekly") end.setDate(end.getDate()+7);
  else if(period==="monthly") end.setMonth(end.getMonth()+1);
  else if(period==="yearly") end.setFullYear(end.getFullYear()+1);

  const list = await prisma.reservation.findMany({
    where:{ startTs:{ gte:start }, endTs:{ lt:end } },
    orderBy:[{date:"asc"},{time:"asc"}]
  });

  const rows = list.map(r=>({
    Date:r.date, Time:r.time,
    FirstName:r.firstName, Name:r.name, Email:r.email, Phone:r.phone||"",
    Guests:r.guests, Status:r.status, Notes:r.notes||"", WalkIn:r.isWalkIn?"yes":""
  }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Reservations");
  const buf = XLSX.write(wb, {type:"buffer", bookType:"xlsx"});
  const fname = `export_${period}_${format(base,"yyyyMMdd")}.xlsx`;
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// Reminder 24h
async function sendReminders(){
  const now = new Date();
  const from = addHours(now, 24);
  const to   = addHours(now, 25);
  const list = await prisma.reservation.findMany({
    where:{ status:"confirmed", isWalkIn:false, reminderSent:false, startTs:{ gte:from, lt:to } }
  });
  for(const r of list){
    const cancelUrl = `${BASE_URL}/cancel/${r.cancelToken}`;
    const visits = await visitCount(r.email);
    const html = reservationHtml(r.firstName, r.name, r.date, r.time, r.guests, cancelUrl, visits);
    try{
      await verifyMailer();
      await sendMail(r.email, "Reservation reminder", html);
      await prisma.reservation.update({ where:{ id:r.id }, data:{ reminderSent:true }});
    }catch(e){ console.error("reminder mail error", e); }
  }
}
setInterval(sendReminders, 30*60*1000);

async function start(){
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", ()=>console.log("Server on", PORT));
}
start().catch(e=>{ console.error(e); process.exit(1); });
