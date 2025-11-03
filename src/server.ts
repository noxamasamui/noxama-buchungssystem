// src/server.ts
import express from "express";
import cors from "cors";
import path from "path";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import { addHours, addMinutes, differenceInMinutes, format } from "date-fns";
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

// ---------------- Config ----------------
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const BRAND_NAME = process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI";

const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || 48);
const MAX_SEATS_RESERVABLE = Number(process.env.MAX_SEATS_RESERVABLE || 40);
const MAX_ONLINE_GUESTS = Number(process.env.MAX_ONLINE_GUESTS || 10);
const WALKIN_BUFFER = Number(process.env.WALKIN_BUFFER || 8);

function hourFrom(v?: string, fb = 0) {
  if (!v) return fb;
  const h = Number(String(v).split(":")[0]);
  return Number.isFinite(h) ? h : fb;
}
const OPEN_HOUR = hourFrom(process.env.OPEN_HOUR || "10", 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || "22", 22);
const SUNDAY_CLOSED =
  String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

const ADMIN_TO =
  String(process.env.ADMIN_EMAIL || "") ||
  String(process.env.MAIL_TO_ADMIN || "") ||
  String(process.env.SMTP_USER || "") ||
  String(process.env.MAIL_FROM_ADDRESS || "");

const ADMIN_RESET_KEY = String(process.env.ADMIN_RESET_KEY || "");

// ---------------- Helpers ----------------
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
  const reserved = list.filter(r=>!r.isWalkIn).reduce((s,r)=>s+r.guests,0);
  const walkins  = list.filter(r=> r.isWalkIn).reduce((s,r)=>s+r.guests,0);
  return { reserved, walkins, total: reserved+walkins };
}
function capacityOnlineLeft(res: number, walk: number){
  const effWalk = Math.max(0, walk - WALKIN_BUFFER);
  return Math.max(0, MAX_SEATS_RESERVABLE - res - effWalk);
}

async function slotAllowed(dateYmd: string, timeHHmm: string){
  const norm = normalizeYmd(String(dateYmd));
  if(!norm || !timeHHmm) return { ok:false, reason:"Closed/invalid" };
  if(SUNDAY_CLOSED && isSundayYmd(norm)) return { ok:false, reason:"Closed on Sunday" };

  const start = localDateFrom(norm, timeHHmm);
  if(isNaN(start.getTime())) return { ok:false, reason:"Invalid time" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y,m,d } = splitYmd(norm);
  const open  = localDate(y,m,d,OPEN_HOUR,0,0);
  const close = localDate(y,m,d,CLOSE_HOUR,0,0);
  if(start < open) return { ok:false, reason:"Before opening" };
  if(end > close)  return { ok:false, reason:"After closing" };

  const blocked = await prisma.closure.findFirst({
    where:{ AND:[{startTs:{lt:end}},{endTs:{gt:start}}] }
  });
  if(blocked) return { ok:false, reason:"Blocked" };

  return { ok:true, start, end, minutes, norm, open, close };
}

async function sendEmailSMTP(to: string, subject: string, html: string) {
  await mailer().sendMail({ from: fromAddress(), to, subject, html });
}
async function notifyAdmin(subject: string, html: string) {
  if (!ADMIN_TO) return;
  try { await sendEmailSMTP(ADMIN_TO, subject, html); } catch {}
}

// ---------------- Pages ----------------
app.get("/", (_req,res)=>res.sendFile(path.join(publicDir,"index.html")));
app.get("/admin", (_req,res)=>res.sendFile(path.join(publicDir,"admin.html")));

// ---------------- Public Config ----------------
app.get("/api/config", (_req, res) => {
  res.json({
    brand: process.env.BRAND_NAME || "RÖSTILAND BY NOXAMA SAMUI",
    address: process.env.VENUE_ADDRESS || "Moo 4 Lamai Beach, 84310 Suratthani, Thailand",
    phone: process.env.VENUE_PHONE || "+66 077 270 675",
    email: process.env.VENUE_EMAIL || "info@noxamasamui.com",
    maxOnlineGuests: Number(process.env.MAX_ONLINE_GUESTS || 10),
    mailLogoUrl: process.env.MAIL_LOGO_URL || "/logo-hero.png"
  });
});

// ---------------- Slots API ----------------
app.get("/api/slots", async (req,res)=>{
  const date = normalizeYmd(String(req.query.date||""));
  if(!date) return res.json([]);

  const times = generateSlots(date, OPEN_HOUR, CLOSE_HOUR);
  const out:any[] = [];
  for(const t of times){
    const allow = await slotAllowed(date, t);
    if(!allow.ok){
      out.push({ time:t, allowed:false, reason:allow.reason, canReserve:false, left:0 });
      continue;
    }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const leftOnline = capacityOnlineLeft(sums.reserved, sums.walkins);
    const canReserve = leftOnline>0 && sums.total < MAX_SEATS_TOTAL;
    out.push({
      time:t, allowed:canReserve, reason:canReserve?null:"Fully booked",
      canReserve, reserved:sums.reserved, walkins:sums.walkins, total:sums.total, left:leftOnline
    });
  }
  res.json(out);
});

// ---------------- Reservation API ----------------
app.post("/api/reservations", async (req,res)=>{
  try{
    const { date, time, firstName, name, email, phone, guests, notes } = req.body || {};
    const g = Number(guests||0);
    if(!date || !time || !firstName || !name || !email || g<1) return res.status(400).json({ error:"Invalid input" });
    if(g > MAX_ONLINE_GUESTS) return res.status(400).json({ error:"Online bookings are limited to 10 guests. Please contact us directly." });

    const allow = await slotAllowed(String(date), String(time));
    if(!allow.ok) return res.status(400).json({ error: allow.reason || "Not available" });

    const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
    const leftOnline = capacityOnlineLeft(sums.reserved, sums.walkins);
    if(g > leftOnline) return res.status(400).json({ error:"Fully booked at this time. Please select another." });
    if(sums.total + g > MAX_SEATS_TOTAL) return res.status(400).json({ error:"Fully booked at this time. Please select another." });

    const token = nanoid();
    const created = await prisma.reservation.create({
      data:{
        date: allow.norm!, time, startTs:allow.start!, endTs:allow.end!,
        firstName, name, email, phone:String(phone||""), guests:g, notes:String(notes||""),
        status:"confirmed", cancelToken:token, isWalkIn:false
      }
    });

    const priorVisits = await prisma.reservation.count({
      where:{ email: created.email, status:{ in:["confirmed","noshow"] } }
    });
    const discount = discountForVisit(priorVisits);
    const cancelUrl = `${BASE_URL}/cancel/${token}`;

    const html = confirmationHtml(
      created.firstName, created.name, created.date, created.time,
      created.guests, cancelUrl, priorVisits, discount
    );
    try{ await sendEmailSMTP(created.email, `${BRAND_NAME} — Reservation`, html); }catch(e){}

    const adminHtml = reservationAdminHtml({
      logo: process.env.MAIL_LOGO_URL || "/logo.png",
      brand: BRAND_NAME,
      firstName: created.firstName,
      lastName: created.name,
      email: created.email,
      phone: created.phone || "",
      guests: created.guests,
      date: created.date,
      time: created.time,
      notes: created.notes || "",
      visitCount: priorVisits,
      discount
    });
    notifyAdmin(`New reservation — ${created.date} ${created.time} — ${created.guests}p`, adminHtml);

    res.json({ ok:true, reservation: created });
  }catch(err){
    res.status(500).json({ error:"Server error" });
  }
});

// ---------------- Walk-in API ----------------
app.post("/api/walkin", async (req,res)=>{
  try{
    const { date, time, guests, notes } = req.body || {};
    const g = Number(guests||0);
    if(!date || !time || g<1) return res.status(400).json({ error:"Invalid input" });

    const norm = normalizeYmd(String(date));
    const allow = await slotAllowed(norm, String(time));

    let startTs:Date, endTs:Date, open:Date, close:Date;
    if(allow.ok){ startTs = allow.start!; endTs = allow.end!; open = allow.open!; close = allow.close!; }
    else{
      const start = localDateFrom(norm, String(time));
      const { y,m,d } = splitYmd(norm);
      open = localDate(y,m,d,OPEN_HOUR,0,0);
      close = localDate(y,m,d,CLOSE_HOUR,0,0);
      if(isNaN(start.getTime()) || start<open) return res.status(400).json({ error:"Slot not available." });
      const minutes = Math.max(15, Math.min(slotDuration(norm,String(time)), differenceInMinutes(close,start)));
      startTs = start; endTs = addMinutes(start, minutes); if(endTs>close) endTs = close;
    }

    const sums = await sumsForInterval(norm, startTs, endTs);
    if(sums.total + g > MAX_SEATS_TOTAL) return res.status(400).json({ error:"Total capacity reached" });

    const r = await prisma.reservation.create({
      data:{
        date:norm, time:String(time), startTs, endTs, firstName:"Walk", name:"In", email:"walkin@noxama.local",
        phone:"", guests:g, notes:String(notes||""), status:"confirmed", cancelToken:nanoid(), isWalkIn:true
      }
    });

    notifyAdmin(`[WALK-IN] ${r.date} ${r.time} — ${r.guests}p`,
      `<p>New walk-in recorded:</p><p>${r.date} ${r.time} — ${r.guests} guests</p><p>Notes: ${r.notes||"-"}</p>`);

    res.json(r);
  }catch(err){
    res.status(500).json({ error:"Failed to save walk-in" });
  }
});

// ---------------- Cancel ----------------
app.get("/cancel/:token", async (req,res)=>{
  const r = await prisma.reservation.findUnique({ where:{ cancelToken: req.params.token } });
  if(!r) return res.status(404).send("Not found");

  if(r.status!=="canceled"){
    await prisma.reservation.update({ where:{ id: r.id }, data:{ status:"canceled" } });

    if(r.email && r.email!=="walkin@noxama.local"){
      const guestHtml = canceledGuestHtml(r.firstName, r.name, r.date, r.time, r.guests, `${BASE_URL}/`);
      try{ await sendEmailSMTP(r.email, "We hope this goodbye is only for now", guestHtml); }catch{}
    }

    if(ADMIN_TO){
      const visitCount = r.email
        ? await prisma.reservation.count({ where:{ email:r.email, status:{ in:["confirmed","noshow"] } } })
        : 0;
      const adminHtml = canceledAdminHtml({
        logo: process.env.MAIL_LOGO_URL || "/logo.png",
        brand: BRAND_NAME,
        firstName: r.firstName, lastName: r.name, email: r.email || "", phone: r.phone || "",
        guests: r.guests, date: r.date, time: r.time, notes: r.notes || "", visitCount
      });
      notifyAdmin("Guest canceled reservation — FYI", adminHtml);
    }
  }

  res.sendFile(path.join(publicDir,"cancelled.html"));
});

// ---------------- Admin list/ops ----------------
app.get("/api/admin/reservations", async (req,res)=>{
  const date = normalizeYmd(String(req.query.date||""));
  const view = String(req.query.view||"day"); // day|week|month
  let list:any[] = [];

  if(date){
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to = new Date(base);
    if(view==="week") to.setDate(to.getDate()+7);
    else if(view==="month") to.setMonth(to.getMonth()+1);
    else to.setDate(to.getDate()+1);

    list = await prisma.reservation.findMany({
      where:{ startTs:{ gte: from, lt: to } },
      orderBy:[{ date:"asc" }, { time:"asc" }]
    });
  }else{
    list = await prisma.reservation.findMany({ orderBy:[{ date:"asc" }, { time:"asc" }] });
  }

  const emails = Array.from(new Set(list.map(r=>r.email).filter(Boolean))) as string[];
  const counts = new Map<string,number>();
  await Promise.all(emails.map(async em=>{
    const c = await prisma.reservation.count({ where:{ email:em, status:{ in:["confirmed","noshow"] } } });
    counts.set(em,c);
  }));

  const withLoyalty = list.map(r=>{
    const vc = counts.get(r.email || "") || 0;
    const d = discountForVisit(vc);
    return { ...r, visitCount: vc, discount: d };
  });

  res.json(withLoyalty);
});

app.delete("/api/admin/reservations/:id", async (req,res)=>{
  await prisma.reservation.delete({ where:{ id:req.params.id } });
  res.json({ ok:true });
});
app.post("/api/admin/reservations/:id/noshow", async (req,res)=>{
  const r = await prisma.reservation.update({ where:{ id:req.params.id }, data:{ status:"noshow" as ReservationStatus } });
  res.json(r);
});

// ---------------- Closures ----------------
app.post("/api/admin/closure", async (req,res)=>{
  try{
    const { startTs, endTs, reason } = req.body;
    const s = new Date(String(startTs).replace(" ","T"));
    const e = new Date(String(endTs).replace(" ","T"));
    if(isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({ error:"Invalid time range" });
    if(e<=s) return res.status(400).json({ error:"End must be after start" });
    const c = await prisma.closure.create({ data:{ startTs:s, endTs:e, reason:String(reason||"Closed") } });
    res.json(c);
  }catch(err){ res.status(500).json({ error:"Failed to create block" }); }
});
app.post("/api/admin/closure/day", async (req,res)=>{
  try{
    const date = normalizeYmd(String(req.body.date||""));
    if(!date) return res.status(400).json({ error:"Invalid date" });
    const reason = String(req.body.reason||"Closed");
    const { y,m,d } = splitYmd(date);
    const s = localDate(y,m,d,OPEN_HOUR,0,0);
    const e = localDate(y,m,d,CLOSE_HOUR,0,0);
    const c = await prisma.closure.create({ data:{ startTs:s, endTs:e, reason } });
    res.json(c);
  }catch(err){ res.status(500).json({ error:"Failed to block day" }); }
});
app.get("/api/admin/closure", async (_req,res)=>{
  const list = await prisma.closure.findMany({ orderBy:{ startTs:"desc" } });
  res.json(list);
});
app.delete("/api/admin/closure/:id", async (req,res)=>{
  await prisma.closure.delete({ where:{ id:req.params.id } });
  res.json({ ok:true });
});

// ---------------- Export ----------------
app.get("/api/export", async (req,res)=>{
  try{
    const period = String(req.query.period||"weekly");
    const date = normalizeYmd(String(req.query.date||""));
    const base = date ? new Date(date+"T00:00:00") : new Date();
    const from = new Date(base);
    const to = new Date(base);
    if(period==="daily") to.setDate(to.getDate()+1);
    else if(period==="weekly") to.setDate(to.getDate()+7);
    else if(period==="monthly") to.setMonth(to.getMonth()+1);
    else if(period==="yearly") to.setFullYear(to.getFullYear()+1);
    else to.setDate(to.getDate()+7);

    const list = await prisma.reservation.findMany({
      where:{ startTs:{ gte: from, lt: to } },
      orderBy:[{ date:"asc" }, { time:"asc" }]
    });

    const prog = new Map<string,number>();
    const rows = list.map(r=>{
      const key = (r.email||"").toLowerCase();
      const prev = prog.get(key)||0;
      const isCount = r.status==="confirmed" || r.status==="noshow";
      const now = isCount ? prev+1 : prev;
      prog.set(key, now);
      const disc = discountForVisit(now);
      return {
        Date:r.date, Time:r.time, Name:`${r.firstName} ${r.name}`, Email:r.email, Phone:r.phone||"",
        Guests:r.guests, Status:r.status, Notes:r.notes||"", WalkIn: r.isWalkIn?"yes":"", VisitCount: now, DiscountPercent: disc
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Reservations");
    const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
    const fname = `reservations_${format(from,"yyyyMMdd")}_${period}.xlsx`;
    res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    res.setHeader("Content-Type","application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.send(buf);
  }catch(err){ res.status(500).json({ error:"Export failed" }); }
});

// ---------------- Admin reset ----------------
app.post("/api/admin/reset", async (req,res)=>{
  try{
    const { key } = req.body || {};
    if(!ADMIN_RESET_KEY || key !== ADMIN_RESET_KEY) return res.status(403).json({ error:"Forbidden" });
    await prisma.reservation.deleteMany({});
    res.json({ ok:true });
  }catch(err){ res.status(500).json({ error:"Reset failed" }); }
});

// ---------------- Email helpers ----------------
function emailHeader(logoUrl: string) {
  const banner = process.env.MAIL_HEADER_URL || "";
  if (banner) {
    return `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
        <tr><td align="center" style="padding:0;">
          <img src="${banner}" alt="Logo" style="display:block;width:100%;max-width:680px;height:auto;border:0;outline:none;text-decoration:none;">
        </td></tr>
      </table>`;
  }
  return `
    <div style="max-width:680px;margin:0 auto 10px auto;padding:28px 0;background:
      radial-gradient(ellipse at center, rgba(179,130,47,0.18) 0%, rgba(179,130,47,0.08) 42%, rgba(255,255,255,0) 72%);
      text-align:center;">
      <img src="${logoUrl}" alt="Logo" style="width:180px;height:auto;border:0;outline:none;" />
    </div>`;
}
function ordinalSuffix(n:number){ const v=n%100; if(v>=11&&v<=13) return "th"; switch(n%10){case 1:return "st";case 2:return "nd";case 3:return "rd";default:return "th";}}
function discountForVisit(visitCount:number){ if(visitCount>=15) return 15; if(visitCount>=10) return 10; if(visitCount>=5) return 5; return 0; }

function confirmationHtml(firstName:string,name:string,date:string,time:string,guests:number,cancelUrl:string,visitCount:number,currentDiscount:number){
  const logo = process.env.MAIL_LOGO_URL || "/logo.png";
  const site = BRAND_NAME;
  const header = emailHeader(logo);
  const intro = visitCount===0 ? `We are delighted to welcome you to <b>${site}</b>.`
                               : `Thank you for choosing <b>${site}</b> again.`;
  let reward=""; if(currentDiscount===15){reward=`<div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;"><div style="font-size:20px;margin-bottom:6px;">A heartfelt thank-you</div><div style="font-size:15px;">As a token of appreciation you enjoy a <b style="color:#b3822f;">15% loyalty thank-you</b>.</div></div>`;}else if(currentDiscount===10){reward=`<div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;"><div style="font-size:20px;margin-bottom:6px;">Thank you for coming back</div><div style="font-size:15px;">Please enjoy a <b style="color:#b3822f;">10% loyalty thank-you</b>.</div></div>`;}else if(currentDiscount===5){reward=`<div style="margin:20px 0;padding:16px;background:#fff3df;border:1px solid #ead6b6;border-radius:10px;text-align:center;"><div style="font-size:20px;margin-bottom:6px;">You make our day</div><div style="font-size:15px;">Please enjoy a <b style="color:#b3822f;">5% loyalty thank-you</b>.</div></div>`;}
  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:680px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 14px 0;">Your Reservation at ${site}</h2>
    <p>Hi ${firstName} ${name},</p>
    <p>${intro}</p>
    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Date</b> ${date}</p>
      <p style="margin:0;"><b>Time</b> ${time}</p>
      <p style="margin:0;"><b>Guests</b> ${guests}</p>
    </div>
    ${reward}
    <div style="margin-top:14px;padding:12px 14px;background:#fdeee9;border:1px solid #f3d0c7;border-radius:10px;">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>
    <p style="margin-top:18px;text-align:center;"><a href="${cancelUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Cancel reservation</a></p>
    <p style="margin-top:12px;font-size:13px;text-align:center;opacity:.85;">If our email lands in spam, please mark it as safe so future updates reach you.</p>
    <p style="margin-top:16px;font-size:14px;text-align:center;">We can not wait to welcome you!<br/><b>Warm greetings from ${site}</b></p>
  </div>`; }

function reservationAdminHtml(o:{logo:string;brand:string;firstName:string;lastName:string;email:string;phone:string;guests:number;date:string;time:string;notes:string;visitCount:number;discount:number;}){
  const header = emailHeader(o.logo);
  const d = o.discount ? `${o.discount}%` : "—";
  return `<div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:680px;margin:auto;border:1px solid #e0d7c5;">${header}<h2 style="text-align:center;margin:6px 0 8px 0;">New reservation</h2><div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;"><p style="margin:0;"><b>Guest</b> ${o.firstName} ${o.lastName} (${o.email})</p><p style="margin:0;"><b>Phone</b> ${o.phone||"-"}</p><p style="margin:0;"><b>Date</b> ${o.date} &nbsp; <b>Time</b> ${o.time}</p><p style="margin:0;"><b>Guests</b> ${o.guests}</p><p style="margin:0;"><b>Notes</b> ${o.notes||"-"}</p><p style="margin:0;"><b>Total past visits</b> ${o.visitCount} &nbsp; <b>Discount</b> ${d}</p></div><p style="text-align:center;margin-top:10px;"><b>${o.brand}</b></p></div>`;}
function canceledAdminHtml(o:{logo:string;brand:string;firstName:string;lastName:string;email:string;phone:string;guests:number;date:string;time:string;notes:string;visitCount:number;}){ const header=emailHeader(o.logo); return `<div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:680px;margin:auto;border:1px solid #e0d7c5;">${header}<h2 style="text-align:center;margin:6px 0 8px 0;">Reservation canceled</h2><div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;"><p style="margin:0;"><b>Guest</b> ${o.firstName} ${o.lastName} (${o.email})</p><p style="margin:0;"><b>Phone</b> ${o.phone||"-"}</p><p style="margin:0;"><b>Date</b> ${o.date} &nbsp; <b>Time</b> ${o.time}</p><p style="margin:0;"><b>Guests</b> ${o.guests}</p><p style="margin:0;"><b>Notes</b> ${o.notes||"-"}</p><p style="margin:0;"><b>Total past visits</b> ${o.visitCount}</p></div><p style="text-align:center;margin-top:10px;"><b>${o.brand}</b></p></div>`;}
function canceledGuestHtml(firstName:string,name:string,date:string,time:string,guests:number,rebookUrl:string){ const logo=process.env.MAIL_LOGO_URL||"/logo.png"; const site=BRAND_NAME; const header=emailHeader(logo); return `<div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:680px;margin:auto;border:1px solid #e0d7c5;">${header}<h2 style="text-align:center;margin:6px 0 14px 0;">We will miss you this round</h2><p>Hi ${firstName} ${name},</p><p>Your reservation for <b>${guests}</b> on <b>${date}</b> at <b>${time}</b> has been canceled.</p><p>Plans change — no worries. Your favorite table will be waiting when you are ready to come back.</p><p style="text-align:center;margin:16px 0;"><a href="${rebookUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">Book your comeback</a></p><p>Warm regards,<br/><b>${site}</b></p></div>`;}
function reminderHtml(r:{firstName:string;name:string;date:string;time:string;guests:number;cancelUrl:string;}){ const logo=process.env.MAIL_LOGO_URL||"/logo.png"; const site=BRAND_NAME; const header=emailHeader(logo); return `<div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:680px;margin:auto;border:1px solid #e0d7c5;">${header}<h2 style="text-align:center;margin:6px 0 12px 0;">Friendly reminder</h2><p>Hi ${r.firstName} ${r.name},</p><p>This is a kind reminder of your reservation:</p><div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;"><p style="margin:0;"><b>Date</b> ${r.date}</p><p style="margin:0;"><b>Time</b> ${r.time}</p><p style="margin:0;"><b>Guests</b> ${r.guests}</p></div><p>Please arrive on time — tables may be released after 15 minutes of delay.</p><p style="text-align:center;margin:12px 0;"><a href="${r.cancelUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px;font-weight:bold;">Cancel reservation</a></p><p>We look forward to welcoming you,<br/><b>${site}</b></p></div>`;}

// reminders
setInterval(async ()=>{
  try{
    const now = new Date();
    const from = addHours(now,24);
    const to   = addHours(now,25);
    const list = await prisma.reservation.findMany({
      where:{ status:"confirmed", isWalkIn:false, reminderSent:false, startTs:{ gte:from, lt:to } }
    });
    for(const r of list){
      const html = reminderHtml({
        firstName:r.firstName, name:r.name, date:r.date, time:r.time, guests:r.guests,
        cancelUrl:`${BASE_URL}/cancel/${r.cancelToken}`
      });
      try{
        await sendEmailSMTP(r.email, "Reservation reminder", html);
        await prisma.reservation.update({ where:{ id:r.id }, data:{ reminderSent:true }});
      }catch(e){}
    }
  }catch(e){}
}, 30*60*1000);

// Start
async function start(){
  await prisma.$connect();
  await verifyMailer();
  app.listen(PORT,"0.0.0.0", ()=>console.log(`Server running on ${PORT}`));
}
start().catch(err=>{ console.error(err); process.exit(1); });
