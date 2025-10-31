import express from "express";
import path from "path";
import { PrismaClient, ReservationStatus } from "@prisma/client";
import nodemailer from "nodemailer";
import { addMinutes, isBefore } from "date-fns";

const app = express();
const prisma = new PrismaClient();

app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = process.env.PORT || 3000;
const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || 40);
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 15);
const OPEN_FROM = String(process.env.OPEN_FROM || "10:00");
const OPEN_TO = String(process.env.OPEN_TO || "21:45");
const OPEN_DAYS = (process.env.OPEN_DAYS || "1,2,3,4,5,6").split(",").map(n => Number(n.trim())); // 0..6 (So..Sa)
const ADMIN_NOTIFY = String(process.env.ADMIN_NOTIFY || "info@noxamasamui.com");
const LOGO_URL = String(process.env.MAIL_LOGO_URL || "/logo-hero.png");

const transporter = nodemailer.createTransport({
  pool: true,
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER ? {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  } : undefined
});

function ymdToDate(ymd: string) {
  const [y,m,d] = ymd.split("-").map(Number);
  return new Date(y, m-1, d);
}
function timeToHM(t: string){ const [h,m] = t.split(":").map(Number); return {h,m}; }
function dtCombine(ymd: string, time: string){
  const [y,m,d] = ymd.split("-").map(Number);
  const {h,m} = timeToHM(time);
  return new Date(y, m-1, d, h, m, 0, 0);
}
function toYMD(d: Date){ return d.toISOString().slice(0,10); }
function toHM(d: Date){ return d.toTimeString().slice(0,5); }

function isOpenDay(ymd: string){
  const wd = ymdToDate(ymd).getDay(); // 0=So
  return OPEN_DAYS.includes(wd);
}

function generateSlots(ymd: string){
  const start = dtCombine(ymd, OPEN_FROM);
  const end   = dtCombine(ymd, OPEN_TO);
  const out: string[] = [];
  let t = start;
  while(isBefore(t, addMinutes(end, 1))){
    out.push(toHM(t));
    t = addMinutes(t, SLOT_MINUTES);
  }
  return out;
}

// --- capacity calculation (booked + walkins) ---
async function seatsTaken(ymd: string, hm: string){
  const start = dtCombine(ymd, hm);
  const end = addMinutes(start, SLOT_MINUTES);

  const rows = await prisma.reservation.findMany({
    where: {
      startTs: { gte: start, lt: end },
      status: { in: ["booked","walkin","blocked"] }
    },
    select:{ guests:true, status:true }
  });

  let taken = 0;
  for(const r of rows){
    // blocks = full capacity
    if(r.status === "blocked") return MAX_SEATS_TOTAL;
    taken += r.guests || 0;
  }
  return taken;
}

function normalizeName(s?: string|null){ return (s||"").trim(); }
function normalizeEmail(s?: string|null){ return (s||"").trim().toLowerCase(); }
function normalizePhone(s?: string|null){ return (s||"").trim() || null; }
function normalizeNotes(s?: string|null){ return (s||"").trim() || null; }

function cancelUrl(token: string){
  return `${process.env.PUBLIC_BASE_URL || ""}/cancel/${token}`;
}

async function sendMail(to: string, subject: string, html: string){
  if(!to) return;
  await transporter.sendMail({
    from: `"${process.env.MAIL_FROM_NAME || "RÖSTILAND"}" <${process.env.MAIL_FROM_ADDRESS || "no-reply@noxama.com"}>`,
    to, subject, html
  });
}

// --- Slots API ---
app.get("/api/slots", async (req, res) => {
  try{
    const ymd = String(req.query.date||"");
    const guests = Number(req.query.guests||0);
    if(!ymd || guests<=0) return res.status(400).json({error:"bad params"});

    if(!isOpenDay(ymd)){
      return res.json({open:false, slots:[]});
    }

    const all = generateSlots(ymd);
    const slots = [];
    for(const t of all){
      const taken = await seatsTaken(ymd, t);
      const free = taken + guests <= MAX_SEATS_TOTAL;
      slots.push({ t, free });
    }
    res.json({open:true, slots});
  }catch(e:any){
    res.status(500).json({error:String(e.message||e)});
  }
});

// --- Create reservation ---
app.post("/api/reservations", async (req, res) => {
  try{
    const { date, time, guests } = req.body || {};
    if(!date || !time || !guests) return res.status(400).json({error:"missing"});

    if(!isOpenDay(date)) return res.status(400).json({error:"closed"});

    const taken = await seatsTaken(date, time);
    if(taken + Number(guests) > MAX_SEATS_TOTAL){
      return res.status(409).json({error:"slot full"});
    }

    const cancelToken = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const startTs = dtCombine(date, time);
    const endTs = addMinutes(startTs, SLOT_MINUTES);

    const data = {
      date: String(date),
      time: String(time),
      guests: Number(guests),
      firstName: normalizeName(req.body.firstName),
      name: normalizeName(req.body.name),
      email: normalizeEmail(req.body.email),
      phone: normalizePhone(req.body.phone),
      notes: normalizeNotes(req.body.notes),
      cancelToken,
      startTs, endTs,
      status: "booked" as ReservationStatus,
      walkIn: false,
      reminderSent: false
    };

    const saved = await prisma.reservation.create({ data });

    // --- Single confirmation email (guest + admin) ---
    const subject = "RÖSTILAND BY NOXAMA SAMUI — Reservation";
    const html = `
      <div style="font:16px/1.5 Georgia,serif;color:#3e2e1f;background:#fff8f0;padding:0;margin:0">
        <div style="max-width:680px;margin:0 auto;padding:24px">
          <div style="text-align:center;margin-bottom:14px">
            <img src="${LOGO_URL}" alt="Logo" style="max-width:600px;width:100%;height:auto;border-radius:8px"/>
          </div>
          <div style="background:#fff;border-radius:12px;border:1px solid #eadcca;padding:18px 20px">
            <h2 style="margin:6px 0 12px">Your Reservation at RÖSTILAND BY NOXAMA SAMUI</h2>
            <p>Hi ${saved.firstName || saved.name || "there"},</p>
            <p>Thank you for choosing <strong>RÖSTILAND BY NOXAMA SAMUI</strong>.</p>
            <div style="margin:12px 0;border:1px solid #f0e6d8;border-radius:10px;background:#fff">
              <div style="padding:10px 14px;border-bottom:1px solid #f0e6d8"><strong>Date</strong><br>${saved.date}</div>
              <div style="padding:10px 14px;border-bottom:1px solid #f0e6d8"><strong>Time</strong><br>${saved.time}</div>
              <div style="padding:10px 14px"><strong>Guests</strong><br>${saved.guests}</div>
            </div>
            <div style="text-align:center;margin-top:16px">
              <a href="${cancelUrl(cancelToken)}" style="display:inline-block;padding:10px 14px;border-radius:10px;background:#b23a3a;color:#fff;text-decoration:none">Cancel reservation</a>
            </div>
            <p style="margin-top:18px">We can’t wait to welcome you!<br><strong>Warm greetings from RÖSTILAND BY NOXAMA SAMUI</strong></p>
          </div>
        </div>
      </div>`;

    await sendMail(saved.email!, subject, html);
    await sendMail(ADMIN_NOTIFY, `New reservation — ${saved.date} ${saved.time} — ${saved.guests}p`, `
      <div style="font:15px/1.45 Georgia,serif">
        <p>A guest just booked a table.</p>
        <ul>
          <li>Date: ${saved.date}</li>
          <li>Time: ${saved.time}</li>
          <li>Guests: ${saved.guests}</li>
          <li>Name: ${saved.firstName ? saved.firstName+' ' : ''}${saved.name || ''}</li>
          <li>Email: ${saved.email || ''}</li>
          <li>Phone: ${saved.phone || ''}</li>
          <li>Notes: ${saved.notes || ''}</li>
        </ul>
      </div>`);

    res.json({ ok:true, id: saved.id });
  }catch(e:any){
    res.status(500).json({error:String(e.message||e)});
  }
});

// --- Cancel route ---
app.get("/cancel/:token", async (req, res) => {
  try{
    const token = String(req.params.token || "");
    const r = await prisma.reservation.findFirst({ where:{ cancelToken: token }});
    if(!r){ return res.status(404).sendFile(path.join(process.cwd(),"public","cancelled.html")); }

    if(r.status !== "canceled"){
      await prisma.reservation.update({
        where:{ id:r.id },
        data: { status:"canceled" }
      });

      const subj = "Reservation canceled — FYI";
      await sendMail(ADMIN_NOTIFY, subj, `
        <div style="font:15px/1.45 Georgia,serif">
          <p>The guest has canceled their reservation.</p>
          <ul>
            <li>Date: ${r.date}</li>
            <li>Time: ${r.time}</li>
            <li>Guests: ${r.guests}</li>
            <li>Name: ${r.firstName ? r.firstName+' ' : ''}${r.name || ''}</li>
            <li>Email: ${r.email || ''}</li>
            <li>Phone: ${r.phone || ''}</li>
            <li>Notes: ${r.notes || ''}</li>
            <li>Total past visits: (info in admin)</li>
          </ul>
        </div>`);
      // Gast bekommt separate Cancel-Mail – 1x
      await sendMail(r.email || "", "We hope this goodbye is only for now 😢", `
        <div style="font:16px/1.5 Georgia,serif;color:#3e2e1f;background:#fff8f0">
          <div style="max-width:680px;margin:0 auto;padding:24px">
            <div style="text-align:center;margin-bottom:14px">
              <img src="${LOGO_URL}" style="max-width:600px;width:100%;height:auto;border-radius:8px" alt="Logo">
            </div>
            <div style="background:#fff;border:1px solid #eadcca;border-radius:12px;padding:18px 20px">
              <h2>We’ll miss you this round 😢</h2>
              <p>Hi ${r.firstName || r.name || "there"},</p>
              <p>Your reservation for <strong>${r.guests}</strong> on <strong>${r.date}</strong> at <strong>${r.time}</strong> has been canceled.</p>
              <p>We completely understand — plans change. Just know that your favorite table will be waiting when you’re ready to come back.</p>
              <div style="text-align:center;margin-top:12px">
                <a href="${process.env.PUBLIC_BASE_URL || ""}" style="padding:10px 14px;background:#b48a3a;color:#fff;border-radius:10px;text-decoration:none">Book your comeback</a>
              </div>
              <p style="margin-top:16px">With warm regards,<br><strong>RÖSTILAND BY NOXAMA SAMUI</strong></p>
            </div>
          </div>
        </div>`);
    }

    res.sendFile(path.join(process.cwd(), "public","cancelled.html"));
  }catch(e:any){
    res.status(500).sendFile(path.join(process.cwd(), "public","cancelled.html"));
  }
});

// --- Admin list ---
import { addDays } from "date-fns";
app.get("/api/admin/list", async (req,res)=>{
  try{
    const date = String(req.query.date||"");
    const view = String(req.query.view||"week");
    if(!date) return res.status(400).json({error:"bad date"});
    const start = dtCombine(date, "00:00");
    const end = addDays(start, view==="day" ? 1 : 7);
    const rows = await prisma.reservation.findMany({
      where: { startTs: { gte: start, lt: end } },
      orderBy: [{ startTs: "asc" }]
    });
    res.json(rows.map(r=>({
      id:r.id, date:r.date, time:r.time, firstName:r.firstName, name:r.name,
      email:r.email, phone:r.phone, guests:r.guests, notes:r.notes,
      status:r.status, walkIn:r.walkIn
    })));
  }catch(e:any){ res.status(500).json({error:String(e.message||e)}); }
});

// --- Excel Export (einfach CSV) ---
app.get("/api/admin/export", async (req,res)=>{
  const date = String(req.query.date||"");
  const view = String(req.query.view||"week");
  const start = dtCombine(date, "00:00");
  const end = addDays(start, view==="day" ? 1 : 7);
  const rows = await prisma.reservation.findMany({
    where: { startTs: { gte: start, lt: end } },
    orderBy: [{ startTs: "asc" }]
  });
  const header = "Date,Time,Guests,Name,Email,Phone,Status,Notes\n";
  const lines = rows.map(r => [
    r.date, r.time, r.guests,
    (r.firstName ? r.firstName+" " : "") + (r.name || ""),
    r.email || "", r.phone || "", r.status, r.notes || ""
  ].map(x => `"${String(x).replace(/"/g,'""')}"`).join(",")).join("\n");

  const csv = header + lines + "\n";
  res.setHeader("Content-Type","text/csv; charset=utf-8");
  res.setHeader("Content-Disposition","attachment; filename=reservations.csv");
  res.send(csv);
});

// --- Walk-in ---
app.post("/api/admin/walkin", async (req,res)=>{
  try{
    const { date, time, guests, notes } = req.body || {};
    if(!date || !time || !guests) return res.status(400).json({error:"missing"});
    const startTs = dtCombine(date, time);
    const endTs = addMinutes(startTs, SLOT_MINUTES);

    await prisma.reservation.create({
      data:{
        date:String(date), time:String(time),
        guests:Number(guests), notes: normalizeNotes(notes),
        startTs, endTs, status:"walkin", walkIn:true
      }
    });
    res.json({ok:true});
  }catch(e:any){ res.status(500).json({error:String(e.message||e)})}
});

// --- Block restaurant ---
app.post("/api/admin/block", async (req,res)=>{
  try{
    const { start, end, reason } = req.body || {};
    if(!start || !end) return res.status(400).json({error:"missing"});
    const s = new Date(start);
    const e = new Date(end);
    // wir legen Block-Slots im Raster an
    let t = s;
    while(isBefore(t, addMinutes(e,1))){
      await prisma.reservation.create({
        data:{
          date: toYMD(t),
          time: toHM(t),
          startTs: t,
          endTs: addMinutes(t, SLOT_MINUTES),
          guests: MAX_SEATS_TOTAL,
          status: "blocked",
          notes: reason || "blocked",
          walkIn: false
        }
      });
      t = addMinutes(t, SLOT_MINUTES);
    }
    res.json({ok:true});
  }catch(e:any){ res.status(500).json({error:String(e.message||e)})}
});

// --- delete & noshow ---
app.delete("/api/admin/reservation/:id", async (req,res)=>{
  try{
    await prisma.reservation.delete({ where:{ id: Number(req.params.id) }});
    res.json({ok:true});
  }catch(e:any){ res.status(500).json({error:String(e.message||e)})}
});

app.post("/api/admin/noshow/:id", async (req,res)=>{
  try{
    await prisma.reservation.update({ where:{ id:Number(req.params.id) }, data:{ status:"noshow" }});
    res.json({ok:true});
  }catch(e:any){ res.status(500).json({error:String(e.message||e)})}
});

app.listen(PORT, ()=> console.log(`Server on :${PORT}`));
