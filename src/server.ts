// src/server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { addMinutes, addHours } from "date-fns";
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
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND_NAME;
const FROM_EMAIL =
  process.env.MAIL_FROM_ADDRESS ||
  process.env.SMTP_USER ||
  "info@noxamasamui.com";
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";

// seats
const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48);
const MAX_SEATS_RESERVABLE = Number(process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40);

// opening hours
function hourFrom(v: string | undefined, fallback: number) {
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}
const OPEN_HOUR = hourFrom(process.env.OPEN_HOUR || "10", 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || "22", 22);
const SUNDAY_CLOSED = String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// email banner (1200x400)
const MAIL_BANNER_URL = process.env.MAIL_BANNER_URL || "https://i.imgur.com/LQ4nzwd.png";

// routes for pages
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res) => res.sendFile(path.join(publicDir, "admin.html")));

// health/test
app.get("/__health/email", async (_req, res) => {
  try { await verifyMailer(); res.json({ ok: true }); }
  catch (e:any){ res.status(500).json({ ok:false, error:String(e?.message||e)}); }
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

// public config
app.get("/api/config", (_req, res) => {
  res.json({
    brand: BRAND_NAME,
    address: process.env.VENUE_ADDRESS || "",
    phone: process.env.VENUE_PHONE || "",
    email: process.env.VENUE_EMAIL || "",
  });
});

// --- helpers ---
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
  if (!norm || !timeHHmm) return { ok: false, reason: "Ungültige Zeit" };
  if (SUNDAY_CLOSED && isSundayYmd(norm)) return { ok: false, reason: "Sonntag geschlossen" };

  const start = localDateFrom(norm, timeHHmm);
  if (isNaN(start.getTime())) return { ok: false, reason: "Ungültige Zeit" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y, m, d } = splitYmd(norm);
  const open = localDate(y, m, d, OPEN_HOUR, 0, 0);
  const close = localDate(y, m, d, CLOSE_HOUR, 0, 0);
  if (start < open) return { ok: false, reason: "Vor Öffnung" };
  if (end > close) return { ok: false, reason: "Nach Ladenschluss" };

  const blocked = await prisma.closure.findFirst({
    where: { AND: [{ startTs: { lt: end } }, { endTs: { gt: start } }] },
  });
  if (blocked) return { ok: false, reason: "Blockiert" };

  return { ok: true, start, end, minutes, norm };
}

async function sendEmailSMTP(to: string, subject: string, html: string) {
  await mailer().sendMail({ from: fromAddress(), to, subject, html });
}

// slots
app.get("/api/slots", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  if (!date) return res.json([]);
  const times = generateSlots(date, OPEN_HOUR, CLOSE_HOUR);
  const out: any[] = [];
  for (const t of times) {
    const allow = await slotAllowed(date, t);
    if (!allow.ok) {
      out.push({ time: t, allowed: false, reason: allow.reason, minutes: 0, canReserve: false, reserved: 0, walkins: 0, total: 0 });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const canReserve = sums.reserved < MAX_SEATS_RESERVABLE && sums.total < MAX_SEATS_TOTAL;
    out.push({ time: t, allowed: true, reason: null, minutes: allow.minutes, canReserve, reserved: sums.reserved, walkins: sums.walkins, total: sums.total });
  }
  res.json(out);
});

// loyalty helper
async function countPastVisits(email: string) {
  const c = await prisma.reservation.count({
    where: { email, status: { in: ["confirmed","noshow","canceled"] } }
  });
  return c;
}
function loyaltyText(visits: number){
  // Rabatte: 5% bei 5–9, 10% bei 10–14, ab 15 -> 15%
  if (visits >= 15) return { line:`🎉 Thank you for coming back! 🎉`, reward:`Enjoy a <b>15% loyalty thank-you</b>.`, teaser:"" };
  if (visits >= 10) return { line:`🎉 Thank you for coming back! 🎉`, reward:`Enjoy a <b>10% loyalty thank-you</b>.`, teaser:"" };
  if (visits >= 5)  return { line:`🎉 Thank you for coming back! 🎉`, reward:`Enjoy a <b>5% loyalty thank-you</b>.`,  teaser:"" };
  // Hinweise VOR dem nächsten Threshold
  if (visits === 4)  return { line:"", reward:"", teaser:"On your <b>next visit</b> you will receive <b>5% off</b> as a loyalty thank-you." };
  if (visits === 9)  return { line:"", reward:"", teaser:"On your <b>10th visit</b> you will receive <b>10% off</b>." };
  if (visits === 14) return { line:"", reward:"", teaser:"From your <b>15th visit</b> onwards you will receive <b>15% off</b>." };
  return { line:"", reward:"", teaser:"" };
}

// reservation create
app.post("/api/reservations", async (req, res) => {
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) return res.status(400).json({ error: allow.reason || "Nicht verfügbar" });

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
    return res.status(400).json({ error: "Zu dieser Zeit sind alle Reservierungsplätze vergeben." });
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "Zu dieser Zeit sind wir leider voll." });

  const token = nanoid();
  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!, time, startTs: allow.start!, endTs: allow.end!,
      firstName, name, email, phone, guests: Number(guests), notes,
      status: "confirmed", cancelToken: token, isWalkIn: false,
    },
  });

  const visits = await countPastVisits(email);
  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const html = mailReservation({
    banner: MAIL_BANNER_URL, site: BRAND_NAME,
    firstName, name, date: created.date, time: created.time,
    guests: created.guests, visits, cancelUrl
  });

  try {
    await sendEmailSMTP(created.email, `${BRAND_NAME} — Reservation`, html);
    if (ADMIN_EMAIL) {
      const adminHtml = mailAdminNew({ banner: MAIL_BANNER_URL, r: created, visits });
      await sendEmailSMTP(ADMIN_EMAIL, `New reservation — ${created.date} ${created.time} — ${created.guests}p`, adminHtml);
    }
  } catch (e) { console.error("Mail error:", e); }

  res.json({ ok: true, reservation: created });
});

// cancel page + logic
app.get("/cancel/:token", async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { cancelToken: req.params.token } });
  if (!r) return res.status(404).send("Not found");
  await prisma.reservation.update({ where: { id: r.id }, data: { status: "canceled" } });

  // notify guest + admin
  try {
    const guestHtml = mailCanceledGuest({ banner: MAIL_BANNER_URL, site: BRAND_NAME, r });
    await sendEmailSMTP(r.email, "We hope this goodbye is only for now 😢", guestHtml);

    if (ADMIN_EMAIL) {
      const adminHtml = mailCanceledAdmin({ banner: MAIL_BANNER_URL, site: BRAND_NAME, r, visits: await countPastVisits(r.email) });
      await sendEmailSMTP(ADMIN_EMAIL, "Guest canceled reservation — FYI", adminHtml);
    }
  } catch(e){ console.error("Cancel mail error:", e); }

  res.sendFile(path.join(publicDir, "cancelled.html"));
});

// ----- ADMIN API (fix 404) -----
app.get("/api/admin/reservations", async (req, res) => {
  const date = normalizeYmd(String(req.query.date || ""));
  const view = String(req.query.view || "week");
  if(!date) return res.json([]);

  const base = localDateFrom(date,"00:00");
  const to = new Date(base);
  if(view==="day") to.setDate(base.getDate()+1);
  else to.setDate(base.getDate()+7);

  const list = await prisma.reservation.findMany({
    where:{
      startTs:{ gte: base, lt: to }
    },
    orderBy:[{ date:"asc" },{ time:"asc" }]
  });
  res.json(list);
});

app.delete("/api/admin/reservations/:id", async (req,res)=>{
  await prisma.reservation.delete({ where:{ id: Number(req.params.id) }});
  res.json({ok:true});
});
app.post("/api/admin/reservations/:id/noshow", async (req,res)=>{
  await prisma.reservation.update({ where:{ id: Number(req.params.id) }, data:{ status:"noshow" }});
  res.json({ok:true});
});

// closures
app.get("/api/admin/closure", async (_req,res)=>{
  const list = await prisma.closure.findMany({ orderBy:{ startTs:"desc" }});
  res.json(list);
});
app.post("/api/admin/closure", async (req,res)=>{
  const { startTs, endTs, reason } = req.body;
  const c = await prisma.closure.create({ data:{ startTs:new Date(startTs), endTs:new Date(endTs), reason:String(reason||"Closed") }});
  res.json(c);
});
app.post("/api/admin/closure/day", async (req,res)=>{
  const { date, reason } = req.body;
  const d = normalizeYmd(String(date));
  const { y,m,d:dd } = splitYmd(d);
  const s = localDate(y,m,dd,0,0,0);
  const e = localDate(y,m,dd,23,59,59);
  const c = await prisma.closure.create({ data:{ startTs:s, endTs:e, reason:String(reason||"Closed") }});
  res.json(c);
});
app.delete("/api/admin/closure/:id", async (req,res)=>{
  await prisma.closure.delete({ where:{ id:Number(req.params.id) }});
  res.json({ok:true});
});

// walk-in
app.post("/api/walkin", async (req,res)=>{
  const { date, time, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) return res.status(400).json({ error: allow.reason || "Not available" });

  const created = await prisma.reservation.create({
    data:{
      date: allow.norm!, time, startTs: allow.start!, endTs: allow.end!,
      firstName:"Walk", name:"In", email:"", phone:"", guests:Number(guests||1),
      notes:String(notes||""), status:"confirmed", isWalkIn:true, cancelToken:""
    }
  });
  res.json({ ok:true, reservation: created });
});

// export XLSX
app.get("/api/export", async (req,res)=>{
  const period = String(req.query.period||"weekly");
  const date = normalizeYmd(String(req.query.date||""));
  const base = localDateFrom(date||normalizeYmd(new Date().toISOString()),"00:00");
  const start = new Date(base);
  const end = new Date(base);
  if(period==="daily") end.setDate(start.getDate()+1);
  else if(period==="weekly") end.setDate(start.getDate()+7);
  else if(period==="monthly") end.setMonth(start.getMonth()+1);
  else if(period==="yearly") end.setFullYear(start.getFullYear()+1);

  const list = await prisma.reservation.findMany({
    where:{ startTs:{ gte:start, lt:end }},
    orderBy:[{date:"asc"},{time:"asc"}]
  });

  const rows = list.map(r=>({
    Date:r.date, Time:r.time, Name:`${r.firstName} ${r.name}`,
    Email:r.email, Phone:r.phone, Guests:r.guests, Status:r.status,
    Notes:r.notes || "", WalkIn:r.isWalkIn ? "yes":"", Visits: "", Discount:""
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, "Reservations");
  const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
  res.setHeader("Content-Disposition","attachment; filename=reservations.xlsx");
  res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// emails (HTML)
function wrapEmail(body:string){
  return `
  <div style="margin:0;padding:0;background:#ffffff;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#ffffff;border-collapse:collapse;">
      <tr>
        <td style="padding:0;text-align:center">
          <img src="${MAIL_BANNER_URL}" alt="Banner" style="display:block;width:100%;max-width:1200px;height:auto;margin:0 auto;"/>
        </td>
      </tr>
      <tr><td style="padding:24px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:720px;margin:0 auto;border-collapse:separate;border-spacing:0;background:#fff;">
          <tr><td style="padding:0">${body}</td></tr>
        </table>
      </td></tr>
    </table>
  </div>`;
}
function kv(label:string,value:string){
  return `
  <div style="margin:8px 0;">
    <div style="font-weight:bold;color:#3a2f28;margin-bottom:4px;">${label}</div>
    <div style="background:#fbf5ef;border:1px solid #eadfd1;border-radius:10px;padding:10px 12px;color:#3a2f28;">${value}</div>
  </div>`;
}
function mailReservation(p:{banner:string,site:string,firstName:string,name:string,date:string,time:string,guests:number,visits:number,cancelUrl:string}){
  const { site, firstName, name, date, time, guests, visits, cancelUrl } = p;
  const loy = loyaltyText(visits);
  const body = `
  <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28;">
    <h2 style="margin:0 0 12px 0;">Your Reservation at ${site}</h2>
    <p>Hi ${firstName} ${name},</p>
    <p>Thank you for choosing <b>${site}</b>. We value loyalty deeply — regular guests are the heart of our little community.</p>
    ${kv("Date",date)}${kv("Time",time)}${kv("Guests",String(guests))}
    ${visits>0?`<p style="margin-top:10px;">This is your <b>${visits}</b> visit.</p>`:""}
    ${loy.line?`<div style="margin:14px 0;padding:12px;border-radius:12px;background:#fff7e8;border:1px solid #f0e0c6;"><div style="font-weight:bold;margin-bottom:6px;">${loy.line}</div><div>${loy.reward}</div></div>`:""}
    ${loy.teaser?`<p style="margin-top:6px;">${loy.teaser}</p>`:""}

    <div style="margin:18px 0;">
      <div style="font-weight:bold;margin-bottom:4px;">Punctuality</div>
      <div style="background:#fbf5ef;border:1px solid #eadfd1;border-radius:10px;padding:10px 12px;">
        Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
      </div>
    </div>

    <div style="text-align:center;margin:22px 0;">
      <a href="${cancelUrl}" style="display:inline-block;padding:12px 18px;background:#a0713a;color:#fff;text-decoration:none;border-radius:8px;">Cancel reservation</a>
    </div>
    <p style="font-size:12px;color:#6b5b51;">If the button doesn't work, copy this link:<br/>${cancelUrl}</p>
    <p>We can’t wait to welcome you!<br/><b>Warm greetings from ${site}</b></p>
  </div>`;
  return wrapEmail(body);
}
function mailCanceledGuest(p:{banner:string,site:string,r:any}){
  const { site, r } = p;
  const url = `${BASE_URL}/`;
  const body = `
  <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28;">
    <h2 style="margin:0 0 10px 0;">We’ll miss you this round 😢</h2>
    <p>Hi ${r.firstName} ${r.name},</p>
    <p>Your reservation for <b>${r.guests}</b> on <b>${r.date}</b> at <b>${r.time}</b> has been canceled.</p>
    <p>We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
    <div style="text-align:center;margin:20px 0;">
      <a href="${url}" style="display:inline-block;padding:12px 18px;background:#a0713a;color:#fff;text-decoration:none;border-radius:8px;">Book your comeback</a>
    </div>
    <p>With warm regards,<br/><b>${site}</b></p>
  </div>`;
  return wrapEmail(body);
}
function mailCanceledAdmin(p:{banner:string,site:string,r:any,visits:number}){
  const { r, site, visits } = p;
  const body = `
  <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28;">
    <h2 style="margin:0 0 10px 0;">Reservation canceled 😳</h2>
    ${kv("Guest",`${r.firstName} ${r.name} (${r.email})`)}
    ${kv("Phone",r.phone||"-")}
    ${kv("Date",r.date)}${kv("Time",r.time)}${kv("Guests",String(r.guests))}
    ${kv("Total past visits",String(visits))}
    <p style="margin-top:14px;"><b>${site}</b></p>
  </div>`;
  return wrapEmail(body);
}
function mailAdminNew(p:{banner:string,r:any,visits:number}){
  const { r, visits } = p;
  const body = `
  <div style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28;">
    <h2 style="margin:0 0 10px 0;">New reservation ✅</h2>
    ${kv("Guest",`${r.firstName} ${r.name} (${r.email})`)}
    ${kv("Phone",r.phone||"-")}
    ${kv("Date",r.date)}${kv("Time",r.time)}${kv("Guests",String(r.guests))}
    ${kv("Notes",r.notes||"-")}
    ${kv("Total past visits",String(visits))}
  </div>`;
  return wrapEmail(body);
}

// reminders (24h)
async function sendReminders() {
  const now = new Date();
  const from = addHours(now, 24);
  const to = addHours(now, 25);
  const list = await prisma.reservation.findMany({
    where: { status: "confirmed", isWalkIn: false, reminderSent: false, startTs: { gte: from, lt: to } },
  });
  for (const r of list) {
    const cancelUrl = `${BASE_URL}/cancel/${r.cancelToken}`;
    const html = mailReservation({
      banner: MAIL_BANNER_URL, site: BRAND_NAME,
      firstName:r.firstName, name:r.name, date:r.date, time:r.time,
      guests:r.guests, visits: await countPastVisits(r.email), cancelUrl
    });
    try {
      await sendEmailSMTP(r.email, "Reservation reminder", html);
      await prisma.reservation.update({ where: { id: r.id }, data: { reminderSent: true } });
    } catch (e) { console.error("Reminder mail error:", e); }
  }
}
setInterval(sendReminders, 30 * 60 * 1000);

// start
async function start() {
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT, "0.0.0.0", () => console.log(`Server running on ${PORT}`));
}
start().catch(err => { console.error("Fatal start error", err); process.exit(1); });
