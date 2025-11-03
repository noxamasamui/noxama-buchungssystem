/* ===== Neues HTML für Reminder, gleicher Stil wie Bestätigung ===== */
function reminderHtml(
  firstName: string,
  lastName: string,
  date: string,
  time: string,
  guests: number,
  cancelUrl: string
) {
  const logo = process.env.MAIL_LOGO_URL || "/logo.png";
  const site = BRAND_NAME;
  const header = emailHeader(logo);

  return `
  <div style="font-family:Georgia,'Times New Roman',serif;background:#fff8f0;color:#3a2f28;padding:24px;border-radius:12px;max-width:640px;margin:auto;border:1px solid #e0d7c5;">
    ${header}
    <h2 style="text-align:center;margin:6px 0 14px 0;">See you soon — just a quick reminder</h2>
    <p style="font-size:16px;margin:0 0 12px 0;">Hi ${firstName} ${lastName},</p>
    <p style="font-size:16px;margin:0 0 12px 0;">We look forward to welcoming you at <b>${site}</b>.</p>

    <div style="background:#f7efe2;padding:14px 18px;border-radius:10px;margin:10px 0;border:1px solid #ead6b6;">
      <p style="margin:0;"><b>Date</b> ${date}</p>
      <p style="margin:0;"><b>Time</b> ${time}</p>
      <p style="margin:0;"><b>Guests</b> ${guests}</p>
    </div>

    <div style="margin-top:14px;padding:12px 14px;background:#fdeee9;border:1px solid #f3d0c7;border-radius:10px;">
      <b>Punctuality</b><br/>Please arrive on time — tables may be released after <b>15 minutes</b> of delay.
    </div>

    <p style="margin:14px 0;">If your plans change, please cancel here:</p>
    <p style="text-align:center;margin:0 0 16px 0;">
      <a href="${cancelUrl}" style="display:inline-block;background:#b3822f;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:bold;">
        Cancel reservation
      </a>
    </p>
    <p style="margin-top:6px;font-size:14px;text-align:center;">Warm greetings from <b>${site}</b></p>
  </div>`;
}

/* ===== Reminder-Job ersetzen ===== */
setInterval(async () => {
  const now = new Date();
  const from = addHours(now, 24);
  const to = addHours(now, 25);

  const list = await prisma.reservation.findMany({
    where: {
      status: "confirmed",
      isWalkIn: false,
      reminderSent: false,
      startTs: { gte: from, lt: to },
    },
  });

  for (const r of list) {
    const cancelUrl = `${BASE_URL}/cancel/${r.cancelToken}`;
    const html = reminderHtml(r.firstName, r.name, r.date, r.time, r.guests, cancelUrl);

    try {
      await sendEmailSMTP(r.email, `${BRAND_NAME} — Reminder`, html);
      await prisma.reservation.update({ where: { id: r.id }, data: { reminderSent: true } });
    } catch (e) {
      console.error("Reminder mail error:", e);
    }
  }
}, 30 * 60 * 1000);
