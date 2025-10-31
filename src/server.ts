import express from "express";
import path from "path";
import { addDays, addMinutes, isBefore } from "date-fns";
import { PrismaClient } from "@prisma/client";
import nodemailer from "nodemailer";

// ----------------------------------------------------
// App / Prisma
// ----------------------------------------------------
const app = express();
const prisma = new PrismaClient();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const PORT = Number(process.env.PORT || 3000);

// ----------------------------------------------------
// Konfiguration
// ----------------------------------------------------
const MAX_SEATS_TOTAL = Number(process.env.MAX_SEATS_TOTAL || 40);
const SLOT_MINUTES = Number(process.env.SLOT_MINUTES || 15);
const OPEN_FROM = String(process.env.OPEN_FROM || "10:00");
const OPEN_TO = String(process.env.OPEN_TO || "21:45");
const OPEN_DAYS = (process.env.OPEN_DAYS || "1,2,3,4,5,6")
  .split(",")
  .map((n) => Number(n.trim())); // 0=So .. 6=Sa

const ADMIN_NOTIFY = String(process.env.ADMIN_NOTIFY || "info@noxamasamui.com");
const PUBLIC_BASE = String(process.env.PUBLIC_BASE_URL || "");
const LOGO_URL = String(process.env.MAIL_LOGO_URL || "/logo-hero.png");

// Enum deines Schemas (keine blocked/walkin Strings!)
type ResStatus = "confirmed" | "canceled" | "noshow";

// ----------------------------------------------------
// Mailer
// ----------------------------------------------------
const transporter = nodemailer.createTransport({
  pool: true,
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: false,
  auth: process.env.SMTP_USER
    ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    : undefined,
});

async function sendMail(to: string, subject: string, html: string) {
  if (!to) return;
  await transporter.sendMail({
    from: `"${process.env.MAIL_FROM_NAME || "RÖSTILAND"}" <${
      process.env.MAIL_FROM_ADDRESS || "no-reply@noxama.com"
    }>`,
    to,
    subject,
    html,
  });
}

// ----------------------------------------------------
// Helpers
// ----------------------------------------------------
function ymdToDate(ymd: string) {
  const [y, mo, d] = ymd.split("-").map(Number);
  return new Date(y, mo - 1, d);
}
function timeToHM(t: string) {
  const [h, m] = t.split(":").map(Number);
  return { h, m };
}
function dtCombine(ymd: string, time: string) {
  const [y, mo, d] = ymd.split("-").map(Number);
  const { h, m } = timeToHM(time);
  return new Date(y, mo - 1, d, h, m, 0, 0);
}
function toYMD(d: Date) {
  return d.toISOString().slice(0, 10);
}
function toHM(d: Date) {
  return d.toTimeString().slice(0, 5);
}
function isOpenDay(ymd: string) {
  const wd = ymdToDate(ymd).getDay();
  return OPEN_DAYS.includes(wd);
}
function generateSlots(ymd: string) {
  const start = dtCombine(ymd, OPEN_FROM);
  const end = dtCombine(ymd, OPEN_TO);
  const out: string[] = [];
  let t = start;
  while (isBefore(t, addMinutes(end, 1))) {
    out.push(toHM(t));
    t = addMinutes(t, SLOT_MINUTES);
  }
  return out;
}
function cancelUrl(token: string) {
  return `${PUBLIC_BASE}/cancel/${token}`;
}
function normStr(s?: string | null) {
  return (s || "").trim();
}
function normEmail(s?: string | null) {
  return (s || "").trim().toLowerCase();
}
function normOpt(s?: string | null) {
  const v = (s || "").trim();
  return v ? v : null;
}
function newToken() {
  return (
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2)
  );
}

// ----------------------------------------------------
// Kapazitaet je Slot
//  - zaehlt nur status=confirmed
//  - "blocked" wird durch notes === "blocked" erkannt
// ----------------------------------------------------
async function seatsTaken(ymd: string, hm: string) {
  const start = dtCombine(ymd, hm);
  const end = addMinutes(start, SLOT_MINUTES);

  const rows = await prisma.reservation.findMany({
    where: { startTs: { gte: start, lt: end }, status: "confirmed" },
    select: { guests: true, notes: true },
  });

  for (const r of rows) {
    if ((r.notes || "").toLowerCase() === "blocked") {
      return MAX_SEATS_TOTAL; // ganzer Slot geblockt
    }
  }

  let taken = 0;
  for (const r of rows) taken += r.guests || 0;
  return taken;
}

// ----------------------------------------------------
// API: Slots fuers Frontend
// ----------------------------------------------------
app.get("/api/slots", async (req, res) => {
  try {
    const ymd = String(req.query.date || "");
    const guests = Number(req.query.guests || 0);
    if (!ymd || guests <= 0) return res.status(400).json({ error: "bad params" });

    if (!isOpenDay(ymd)) return res.json({ open: false, slots: [] });

    const all = generateSlots(ymd);
    const slots = [];
    for (const t of all) {
      const taken = await seatsTaken(ymd, t);
      slots.push({ t, free: taken + guests <= MAX_SEATS_TOTAL });
    }
    res.json({ open: true, slots });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ----------------------------------------------------
// Buchung (Gast) -> status: confirmed
// ----------------------------------------------------
app.post("/api/reservations", async (req, res) => {
  try {
    const { date, time, guests } = req.body || {};
    if (!date || !time || !guests) return res.status(400).json({ error: "missing" });

    if (!isOpenDay(String(date))) return res.status(400).json({ error: "closed" });

    const taken = await seatsTaken(String(date), String(time));
    if (taken + Number(guests) > MAX_SEATS_TOTAL) {
      return res.status(409).json({ error: "slot full" });
    }

    const cancelToken = newToken();
    const startTs = dtCombine(String(date), String(time));
    const endTs = addMinutes(startTs, SLOT_MINUTES);

    const saved = await prisma.reservation.create({
      data: {
        date: String(date),
        time: String(time),
        guests: Number(guests),
        firstName: normStr(req.body.firstName),
        name: normStr(req.body.name),
        email: normEmail(req.body.email),
        phone: normOpt(req.body.phone),
        notes: normOpt(req.body.notes),
        cancelToken,
        startTs,
        endTs,
        status: "confirmed" as ResStatus,
        isWalkIn: false,
        reminderSent: false,
      },
    });

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
    await sendMail(saved.email || "", subject, html);

    await sendMail(
      ADMIN_NOTIFY,
      `New reservation — ${saved.date} ${saved.time} — ${saved.guests}p`,
      `
      <div style="font:15px/1.45 Georgia,serif">
        <p>A guest just booked a table.</p>
        <ul>
          <li>Date: ${saved.date}</li>
          <li>Time: ${saved.time}</li>
          <li>Guests: ${saved.guests}</li>
          <li>Name: ${(saved.firstName ? saved.firstName + " " : "") + (saved.name || "")}</li>
          <li>Email: ${saved.email || ""}</li>
          <li>Phone: ${saved.phone || ""}</li>
          <li>Notes: ${saved.notes || ""}</li>
        </ul>
      </div>`
    );

    res.json({ ok: true, id: saved.id });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ----------------------------------------------------
// Cancel (setzt status=canceled)
// ----------------------------------------------------
app.get("/cancel/:token", async (req, res) => {
  try {
    const token = String(req.params.token || "");
    const r = await prisma.reservation.findFirst({ where: { cancelToken: token } });
    if (r && r.status !== "canceled") {
      await prisma.reservation.update({
        where: { id: r.id },
        data: { status: "canceled" as ResStatus },
      });

      await sendMail(
        ADMIN_NOTIFY,
        "Reservation canceled — FYI",
        `
        <div style="font:15px/1.45 Georgia,serif">
          <p>The guest has canceled their reservation.</p>
          <ul>
            <li>Date: ${r.date}</li><li>Time: ${r.time}</li><li>Guests: ${r.guests}</li>
            <li>Name: ${(r.firstName ? r.firstName + " " : "") + (r.name || "")}</li>
            <li>Email: ${r.email || ""}</li><li>Phone: ${r.phone || ""}</li>
            <li>Notes: ${r.notes || ""}</li>
          </ul>
        </div>`
      );

      await sendMail(
        r.email || "",
        "We hope this goodbye is only for now 😢",
        `
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
                <a href="${PUBLIC_BASE}" style="padding:10px 14px;background:#b48a3a;color:#fff;border-radius:10px;text-decoration:none">Book your comeback</a>
              </div>
              <p style="margin-top:16px">With warm regards,<br><strong>RÖSTILAND BY NOXAMA SAMUI</strong></p>
            </div>
          </div>
        </div>`
      );
    }
    res.sendFile(path.join(process.cwd(), "public", "cancelled.html"));
  } catch {
    res.sendFile(path.join(process.cwd(), "public", "cancelled.html"));
  }
});

// ----------------------------------------------------
// Admin: Liste / Export
// ----------------------------------------------------
app.get("/api/admin/list", async (req, res) => {
  try {
    const date = String(req.query.date || "");
    const view = String(req.query.view || "week");
    if (!date) return res.status(400).json({ error: "bad date" });

    const start = dtCombine(date, "00:00");
    const end = addDays(start, view === "day" ? 1 : 7);

    const rows = await prisma.reservation.findMany({
      where: { startTs: { gte: start, lt: end } },
      orderBy: [{ startTs: "asc" }],
    });

    res.json(
      rows.map((r) => ({
        id: r.id,
        date: r.date,
        time: r.time,
        firstName: r.firstName,
        name: r.name,
        email: r.email,
        phone: r.phone,
        guests: r.guests,
        notes: r.notes,
        status: r.status as ResStatus,
        isWalkIn: r.isWalkIn,
      }))
    );
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.get("/api/admin/export", async (req, res) => {
  const date = String(req.query.date || "");
  const view = String(req.query.view || "week");
  const start = dtCombine(date, "00:00");
  const end = addDays(start, view === "day" ? 1 : 7);

  const rows = await prisma.reservation.findMany({
    where: { startTs: { gte: start, lt: end } },
    orderBy: [{ startTs: "asc" }],
  });

  const header = "Date,Time,Guests,Name,Email,Phone,Status,Notes\n";
  const lines = rows
    .map((r) =>
      [
        r.date,
        r.time,
        r.guests,
        (r.firstName ? r.firstName + " " : "") + (r.name || ""),
        r.email || "",
        r.phone || "",
        r.status,
        r.notes || "",
      ]
        .map((x) => `"${String(x).replace(/"/g, '""')}"`)
        .join(",")
    )
    .join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", "attachment; filename=reservations.csv");
  res.send(header + lines + "\n");
});

// ----------------------------------------------------
// Admin: Walk-in (status: confirmed, Pflichtfelder gefuellt)
// ----------------------------------------------------
app.post("/api/admin/walkin", async (req, res) => {
  try {
    const { date, time, guests, notes } = req.body || {};
    if (!date || !time || !guests) return res.status(400).json({ error: "missing" });

    const startTs = dtCombine(String(date), String(time));
    const endTs = addMinutes(startTs, SLOT_MINUTES);

    await prisma.reservation.create({
      data: {
        date: String(date),
        time: String(time),
        guests: Number(guests),
        firstName: "",
        name: "Walk-in",
        email: "",
        phone: null,
        notes: normOpt(notes),
        cancelToken: newToken(),
        startTs,
        endTs,
        status: "confirmed" as ResStatus,
        isWalkIn: true,
        reminderSent: false,
      },
    });

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ----------------------------------------------------
// Admin: Block (status: confirmed, notes='blocked')
// ----------------------------------------------------
app.post("/api/admin/block", async (req, res) => {
  try {
    const { start, end, reason } = req.body || {};
    if (!start || !end) return res.status(400).json({ error: "missing" });

    let t = new Date(start);
    const endDt = new Date(end);

    while (isBefore(t, addMinutes(endDt, 1))) {
      await prisma.reservation.create({
        data: {
          date: toYMD(t),
          time: toHM(t),
          startTs: t,
          endTs: addMinutes(t, SLOT_MINUTES),
          guests: MAX_SEATS_TOTAL,
          firstName: "",
          name: "BLOCK",
          email: "",
          phone: null,
          notes: normOpt(reason) || "blocked",
          cancelToken: newToken(),
          status: "confirmed" as ResStatus,
          isWalkIn: false,
          reminderSent: false,
        },
      });
      t = addMinutes(t, SLOT_MINUTES);
    }

    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ----------------------------------------------------
// Admin: Delete / No-show
// ----------------------------------------------------
app.delete("/api/admin/reservation/:id", async (req, res) => {
  try {
    await prisma.reservation.delete({ where: { id: Number(req.params.id) } });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

app.post("/api/admin/noshow/:id", async (req, res) => {
  try {
    await prisma.reservation.update({
      where: { id: Number(req.params.id) },
      data: { status: "noshow" as ResStatus },
    });
    res.json({ ok: true });
  } catch (e: any) {
    res.status(500).json({ error: String(e.message || e) });
  }
});

// ----------------------------------------------------
app.listen(PORT, () => console.log(`Server running on :${PORT}`));
