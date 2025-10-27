import express, { Request, Response } from "express";
import cors from "cors";
import path from "path";
import { PrismaClient } from "@prisma/client";
import { format, addMinutes, addHours } from "date-fns";
import { nanoid } from "nanoid";
import XLSX from "xlsx";

import { generateSlots, slotDuration } from "./slots";
import { localDate, localDateFrom, splitYmd } from "./datetime";

// MailerSend API
import { sendMailMS, healthMailMS, isTrial422 } from "./mailersend";

const app = express();
const prisma = new PrismaClient();
const publicDir = path.resolve(__dirname, "../public");

app.use(cors({ origin: true, credentials: true }));
app.use(express.json());
app.use(express.static(publicDir));

// ---- Konfiguration
const PORT = Number(process.env.PORT || 4020);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || process.env.SMTP_USER || "";

const BRAND = process.env.BRAND_NAME || "NOXAMA SAMUI";
const FROM_NAME = process.env.MAIL_FROM_NAME || BRAND;
const FROM_ADDR = process.env.MAIL_FROM_ADDRESS || "noreply@noxamasamui.com";

const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || process.env.ONLINE_SEATS_CAP || 48);
const MAX_SEATS_RESERVABLE = Number(process.env.MAX_SEATS_RESERVABLE || process.env.ONLINE_SEATS_CAP || 40);

function hourFrom(v: string | undefined, fallback: number) {
  if (!v) return fallback;
  const h = Number(v.split(":")[0]);
  return Number.isFinite(h) ? h : fallback;
}
const OPEN_HOUR  = hourFrom(process.env.OPEN_HOUR || process.env.OPEN_LUNCH_START, 10);
const CLOSE_HOUR = hourFrom(process.env.CLOSE_HOUR || process.env.OPEN_DINNER_END, 22);
const SUNDAY_CLOSED = String(process.env.SUNDAY_CLOSED || "true").toLowerCase() === "true";

// ---------- helpers ----------
function normalizeYmd(input: string): string {
  const s = String(input || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  if (/^\d{1,2}\.\d{1,2}\.\d{4}$/.test(s)) { const [dd, mm, yy] = s.split(".").map(Number); return `${yy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`; }
  if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(s)) { const [mm, dd, yy] = s.split("/").map(Number); return `${yy}-${String(mm).padStart(2,"0")}-${String(dd).padStart(2,"0")}`; }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  return "";
}
function isSundayYmd(ymd: string) { const { y,m,d } = splitYmd(ymd); return localDate(y,m,d).getDay() === 0; }

async function overlapping(dateYmd: string, start: Date, end: Date) {
  return prisma.reservation.findMany({
    where: { date: dateYmd, status: { in: ["confirmed","noshow"] }, AND: [{ startTs:{ lt:end } }, { endTs:{ gt:start } }] }
  });
}
async function sumsForInterval(dateYmd: string, start: Date, end: Date) {
  const list = await overlapping(dateYmd, start, end);
  const reserved = list.filter((r:any)=>!r.isWalkIn).reduce((s:number,r:any)=>s+r.guests,0);
  const walkins  = list.filter((r:any)=> r.isWalkIn).reduce((s:number,r:any)=>s+r.guests,0);
  return { reserved, walkins, total: reserved+walkins };
}
async function slotAllowed(dateYmd: string, timeHHmm: string) {
  const norm = normalizeYmd(dateYmd);
  if (!norm || !timeHHmm) return { ok:false, reason:"Ungültige Zeit" };
  if (SUNDAY_CLOSED && isSundayYmd(norm)) return { ok:false, reason:"Sonntag geschlossen" };

  const start = localDateFrom(norm, timeHHmm);
  if (isNaN(start.getTime())) return { ok:false, reason:"Ungültige Zeit" };

  const minutes = slotDuration(norm, timeHHmm);
  const end = addMinutes(start, minutes);

  const { y,m,d } = splitYmd(norm);
  const open  = localDate(y,m,d, OPEN_HOUR, 0, 0);
  const close = localDate(y,m,d, CLOSE_HOUR, 0, 0);
  if (start < open) return { ok:false, reason:"Vor Öffnung" };
  if (end > close)  return { ok:false, reason:"Nach Ladenschluss" };

  const blocked = await prisma.closure.findFirst({ where:{ AND:[ { startTs:{ lt:end } }, { endTs:{ gt:start } } ] }});
  if (blocked) return { ok:false, reason:"Blockiert" };

  return { ok:true, start, end, minutes, norm };
}

// ---------- pages ----------
app.get("/", (_req, res)=>res.sendFile(path.join(publicDir, "index.html")));
app.get("/admin", (_req, res)=>res.sendFile(path.join(publicDir, "admin.html")));

// ---------- health / test ----------
app.get("/__health/email", async (_req, res)=>{
  const ok = await healthMailMS();
  res.json({ ok });
});

// Sendetest: /api/test-mail?to=mail@domain.tld
app.get("/api/test-mail", async (req, res)=>{
  try {
    const to = String(req.query.to || ADMIN_EMAIL || "");
    if (!to) return res.status(400).send("Kein Empfänger angegeben und ADMIN_EMAIL fehlt.");
    const subj = `[TEST] ${BRAND} Mailer`;
    const html = `<p>Testmail von ${BRAND}. Wenn du diese Mail siehst, funktioniert die API.</p>`;
    await sendMailWithTrialFallback(to, subj, html);
    res.send("OK");
  } catch (e:any) {
    res.status(500).send(`MailerSend error ${e.status || ""}: ${e.body ? JSON.stringify(e.body) : e.message || e}`);
  }
});

// ---------- public config ----------
app.get("/api/config", (_req, res) => {
  res.json({
    brand: BRAND,
    address: process.env.VENUE_ADDRESS || "",
    phone: process.env.VENUE_PHONE || "",
    email: process.env.VENUE_EMAIL || ""
  });
});

// ---------- slots ----------
app.get("/api/slots", async (req, res)=>{
  const date = normalizeYmd(String(req.query.date||""));
  if (!date) return res.json([]);
  const times = generateSlots(date, OPEN_HOUR, CLOSE_HOUR);
  const out:any[]=[];
  for (const t of times) {
    const allow = await slotAllowed(date, t);
    if (!allow.ok) { out.push({ time:t, allowed:false, reason:allow.reason, minutes:0, canReserve:false, reserved:0, walkins:0, total:0 }); continue; }
    const sums = await sumsForInterval(date, allow.start!, allow.end!);
    const canReserve = sums.reserved < MAX_SEATS_RESERVABLE && sums.total < MAX_SEATS_TOTAL;
    out.push({ time:t, allowed:true, reason:null, minutes:allow.minutes, canReserve, reserved:sums.reserved, walkins:sums.walkins, total:sums.total });
  }
  res.json(out);
});

// ---------- create reservation ----------
app.post("/api/reservations", async (req, res)=>{
  const { date, time, firstName, name, email, phone, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) {
    const msg = allow.reason==="Blockiert"
      ? "Leider ist das Restaurant an diesem Datum blockiert. Bitte wähle einen anderen Tag."
      : allow.reason==="Nach Ladenschluss" || allow.reason==="Vor Öffnung"
        ? "Diese Uhrzeit ist außerhalb unserer Öffnungszeiten."
        : "Dieser Slot ist nicht verfügbar.";
    return res.status(400).json({ error: msg });
  }

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.reserved + Number(guests) > MAX_SEATS_RESERVABLE)
    return res.status(400).json({ error: "Zu dieser Zeit sind alle Reservierungsplätze vergeben. Bitte wähle einen anderen Slot." });
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL)
    return res.status(400).json({ error: "Zu dieser Zeit sind wir leider voll. Bitte wähle eine andere Uhrzeit." });

  const token = nanoid();
  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!, time, startTs: allow.start!, endTs: allow.end!,
      firstName, name, email, phone, guests:Number(guests),
      notes, status:"confirmed", cancelToken: token, isWalkIn:false
    }
  });

  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const html = confirmationHtml(created.firstName, created.name, created.date, created.time, created.guests, cancelUrl);
  const subject = `${BRAND} — Reservation`;

  try {
    await sendMailWithTrialFallback(created.email, subject, html);
  } catch(e){ console.error("Mail Fehler:", e); }

  res.json({ ok:true, reservation: created });
});

// ---------- walk-in ----------
app.post("/api/walkin", async (req, res)=>{
  const { date, time, guests, notes } = req.body;
  const allow = await slotAllowed(String(date), String(time));
  if (!allow.ok) return res.status(400).json({ error: allow.reason==="Blockiert" ? "An diesem Tag ist geschlossen." : "Slot nicht verfügbar." });

  const sums = await sumsForInterval(allow.norm!, allow.start!, allow.end!);
  if (sums.total + Number(guests) > MAX_SEATS_TOTAL) return res.status(400).json({ error:"Gesamtplätze belegt" });

  const created = await prisma.reservation.create({
    data: {
      date: allow.norm!, time, startTs: allow.start!, endTs: allow.end!,
      firstName:"Walk", name:"In", email:"walkin@noxama.local",
      guests:Number(guests), notes, status:"confirmed", cancelToken:nanoid(), isWalkIn:true
    }
  });
  res.json(created);
});

// ---------- admin list ----------
app.get("/api/admin/reservations", async (req, res)=>{
  const date = normalizeYmd(String(req.query.date||""));
  const view = String(req.query.view||"day");
  if (view === "week" && date) {
    const base = new Date(`${date}T00:00:00`);
    const from = new Date(base);
    const to   = new Date(base); to.setDate(to.getDate()+7);
    const list = await prisma.reservation.findMany({
      where: { startTs: { gte: from }, endTs: { lt: to } },
      orderBy: [{ date:"asc" }, { time:"asc" }]
    });
    return res.json(list);
  }
  const where:any = date ? { date } : {};
  const list = await prisma.reservation.findMany({ where, orderBy:[{ date:"asc" },{ time:"asc" }] });
  res.json(list);
});

// actions
app.delete("/api/admin/reservations/:id", async (req, res)=>{
  await prisma.reservation.delete({ where:{ id:req.params.id } });
  res.json({ok:true});
});
app.post("/api/admin/reservations/:id/noshow", async (req, res)=>{
  const r = await prisma.reservation.update({ where:{ id:req.params.id }, data:{ status:"noshow" } });
  res.json(r);
});

// ---------- closures ----------
app.post("/api/admin/closure", async (req, res)=>{
  const { startTs, endTs, reason } = req.body;
  const s = new Date(String(startTs).replace(" ","T"));
  const e = new Date(String(endTs).replace(" ","T"));
  if (isNaN(s.getTime()) || isNaN(e.getTime())) return res.status(400).json({ error:"Ungültige Zeitangaben" });
  if (e <= s) return res.status(400).json({ error:"Start nach Ende" });
  const c = await prisma.closure.create({ data:{ startTs:s, endTs:e, reason:String(reason||"Closed") } });
  res.json(c);
});
app.post("/api/admin/closure/day", async (req, res)=>{
  const date = normalizeYmd(String(req.body.date||""));
  if (!date) return res.status(400).json({ error:"Ungültiges Datum" });
  const { y,m,d } = splitYmd(date);
  const s = localDate(y,m,d, OPEN_HOUR, 0, 0);
  const e = localDate(y,m,d, CLOSE_HOUR, 0, 0);
  const c = await prisma.closure.create({ data:{ startTs:s, endTs:e, reason:String(req.body.reason||"Closed") } });
  res.json(c);
});
app.get("/api/admin/closure", async (_req, res)=>{
  const list = await prisma.closure.findMany({ orderBy:{ startTs:"desc" } });
  res.json(list);
});
app.delete("/api/admin/closure/:id", async (req, res)=>{
  await prisma.closure.delete({ where:{ id:req.params.id } });
  res.json({ok:true});
});

// ---------- export ----------
app.get("/api/export", async (req, res)=>{
  const period = String(req.query.period || "daily");
  const norm = normalizeYmd(String(req.query.date || format(new Date(),"yyyy-MM-dd")));
  const base = new Date(norm+"T00:00:00");
  const start = new Date(base), end = new Date(base);
  if (period==="daily") end.setDate(end.getDate()+1);
  else if (period==="weekly") end.setDate(end.getDate()+7);
  else if (period==="monthly") end.setMonth(end.getMonth()+1);
  else if (period==="yearly") end.setFullYear(end.getFullYear()+1);

  const list = await prisma.reservation.findMany({
    where:{ startTs:{ gte:start }, endTs:{ lt:end } },
    orderBy:[{ date:"asc" }, { time:"asc" }]
  });

  const rows = list.map((r:any)=>({
    Date:r.date, Time:r.time,
    DurationMin:(r.endTs.getTime()-r.startTs.getTime())/60000,
    FirstName:r.firstName, Name:r.name, Email:r.email,
    Phone:r.phone||"", Guests:r.guests, Status:r.status,
    Notes:r.notes||"", WalkIn:r.isWalkIn ? "yes":"no"
  }));

  const closures = await prisma.closure.findMany({ where:{ startTs:{ lt:end }, endTs:{ gt:start } }, orderBy:{ startTs:"asc" } });
  const closRows = closures.map((c:any)=>({ Start:c.startTs, End:c.endTs, Reason:c.reason }));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), "Reservations");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(closRows), "Closures");

  const buf = XLSX.write(wb, { type:"buffer", bookType:"xlsx" });
  const fname = `export_${period}_${format(base,"yyyyMMdd")}.xlsx`;
  res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.send(buf);
});

// ---------- cancel ----------
app.get("/cancel/:token", async (req, res)=>{
  const r = await prisma.reservation.findUnique({ where:{ cancelToken:req.params.token } });
  if (!r) return res.status(404).send("Not found");
  await prisma.reservation.update({ where:{ id:r.id }, data:{ status:"canceled" } });
  res.sendFile(path.join(publicDir,"cancelled.html"));
});

// ---------- Mail-HTML ----------
function confirmationHtml(firstName: string, name: string, date: string, time: string, guests: number, cancelUrl: string) {
  const logo = process.env.MAIL_LOGO_URL || "/logo.png";
  const addr = process.env.VENUE_ADDRESS || "";
  const phone = process.env.VENUE_PHONE || "";
  const email = process.env.VENUE_EMAIL || "";
  const map   = process.env.VENUE_MAP_LINK || "#";
  return `
  <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28;">
    <img src="${logo}" alt="Logo" style="width:160px;height:auto;margin-bottom:12px;" />
    <h2 style="letter-spacing:1px;">${BRAND}</h2>
    <p>Hi ${firstName} ${name}, thanks for your reservation.</p>
    <p><b>Date</b> ${date}<br/><b>Time</b> ${time}<br/><b>Guests</b> ${guests}</p>
    <p><b>Address</b><br/>${addr}<br/><a href="${map}">View on map</a></p>
    <p><b>Contact</b><br/>Phone: ${phone}<br/>Email: ${email}</p>
    <div style="padding:12px;background:#eee3d5;border-radius:6px;margin:16px 0;">
      <b>Late policy:</b> We hold your table for 15 minutes after the reserved time. If your plans change, please cancel early using the link below.
    </div>
    <p><a href="${cancelUrl}" style="display:inline-block;padding:10px 14px;background:#e74c3c;color:white;text-decoration:none;border-radius:6px;">Cancel reservation</a></p>
    <p>If the button does not work, copy this link:<br/>${cancelUrl}</p>
    <p>We look forward to seeing you,<br/>${BRAND}</p>
  </div>`;
}

// ---------- Reminder-Job ----------
async function sendReminders() {
  const now = new Date();
  const from = addHours(now, 24);
  const to   = addHours(now, 25);
  const list = await prisma.reservation.findMany({
    where: { status:"confirmed", isWalkIn:false, reminderSent:false, startTs:{ gte: from, lt: to } }
  });
  for (const r of list) {
    const cancelUrl = `${BASE_URL}/cancel/${r.cancelToken}`;
    const html = `
      <div style="font-family: Georgia, 'Times New Roman', serif; color:#3a2f28;">
        <p>Friendly reminder for your reservation tomorrow:</p>
        <p><b>Date</b> ${r.date} — <b>Time</b> ${r.time} — <b>Guests</b> ${r.guests}</p>
        <p>If your plans change, please cancel here:<br/><a href="${cancelUrl}">${cancelUrl}</a></p>
        <p>See you soon,<br/>${BRAND}</p>
      </div>`;
    try {
      await sendMailWithTrialFallback(r.email, "Reservation reminder", html);
      await prisma.reservation.update({ where:{ id:r.id }, data:{ reminderSent:true } });
    } catch(e){ console.error("Reminder mail Fehler:", e); }
  }
}
setInterval(sendReminders, 30 * 60 * 1000);

// ---------- Trial-Fallback (zentrale Stelle) ----------
async function sendMailWithTrialFallback(to: string, subject: string, html: string) {
  try {
    // Wenn ADMIN_EMAIL gesetzt ist, erzwingen wir im Trial das Senden dorthin
    if (ADMIN_EMAIL) {
      await sendMailMS({ fromName: FROM_NAME, fromEmail: FROM_ADDR, to: ADMIN_EMAIL, subject: `[TRIAL] ${subject}`, html });
      return;
    }
    // normal versuchen
    await sendMailMS({ fromName: FROM_NAME, fromEmail: FROM_ADDR, to, subject, html });
  } catch (e:any) {
    if (isTrial422(e) && ADMIN_EMAIL) {
      await sendMailMS({ fromName: FROM_NAME, fromEmail: FROM_ADDR, to: ADMIN_EMAIL, subject: `[TRIAL-FWD] ${subject}`, html: `<p>(Trial-Weiterleitung – Originalempfänger: ${to})</p>${html}` });
      return;
    }
    throw e;
  }
}

// ---------- START ----------
app.listen(PORT, "0.0.0.0", async () => {
  await prisma.$connect();
  console.log(`Server running on ${PORT}`);
});
