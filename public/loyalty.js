// public/loyalty.js
// Loyalty Modal und leichte Feuerwerk Animation

function showLoyaltyModal(tier){
  const existing = document.getElementById('loyalty-modal');
  if (!existing) {
    const wrapper = document.createElement('div');
    wrapper.id = 'loyalty-modal';
    wrapper.style.cssText = 'display:none;position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:9999;align-items:center;justify-content:center;';
    wrapper.innerHTML = `
      <div style="background:#fff8f0;border:1px solid #e0d7c5;border-radius:12px;max-width:520px;width:92%;padding:22px;box-shadow:0 10px 35px rgba(0,0,0,.25);text-align:center;">
        <canvas id="fw-canvas" width="480" height="180" style="width:100%;height:180px;display:block;border-radius:10px;margin-bottom:10px;"></canvas>
        <div id="loyalty-text" style="font-family:Georgia,'Times New Roman',serif;color:#3a2f28;font-size:18px;margin:6px 0 12px 0;"></div>
        <button id="loyalty-close" style="background:#b3822f;color:#fff;border:0;border-radius:8px;padding:10px 16px;font-weight:700;cursor:pointer;">Continue</button>
      </div>`;
    document.body.appendChild(wrapper);
    document.getElementById('loyalty-close').onclick = hideLoyaltyModal;
  }
  const txt = document.getElementById('loyalty-text');
  if (tier === 15) txt.textContent = 'Herzlichen Glueckwunsch! Ab sofort erhaeltst du 15 Prozent Loyalty Danke.';
  else if (tier === 10) txt.textContent = 'Herzlichen Glueckwunsch! Ab sofort erhaeltst du 10 Prozent Loyalty Danke.';
  else txt.textContent = 'Herzlichen Glueckwunsch! Ab sofort erhaeltst du 5 Prozent Loyalty Danke.';
  document.getElementById('loyalty-modal').style.display = 'flex';
  startFireworks();
}

function hideLoyaltyModal(){
  const m = document.getElementById('loyalty-modal');
  if (m) m.style.display = 'none';
  stopFireworks();
}

let fwTimer = null;

function startFireworks(){
  const c = document.getElementById('fw-canvas');
  if (!c) return;
  const ctx = c.getContext('2d');
  const W = c.width, H = c.height;
  const particles = [];
  function boom(){
    for(let i = 0; i < 60; i++){
      const a = Math.random() * Math.PI * 2;
      const sp = 1.5 + Math.random() * 2.5;
      particles.push({ x: W/2, y: H/2, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 60, color: `hsl(${Math.floor(Math.random()*360)},90%,60%)` });
    }
  }
  function tick(){
    ctx.fillStyle = "rgba(255,248,240,.25)";
    ctx.fillRect(0,0,W,H);
    for(let i = particles.length - 1; i >= 0; i--){
      const p = particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.02;
      p.life--;
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, 2, 0, Math.PI*2);
      ctx.fill();
      if (p.life <= 0) particles.splice(i,1);
    }
    if (Math.random() < 0.04) boom();
  }
  boom();
  fwTimer = setInterval(tick, 16);
}

function stopFireworks(){
  if (fwTimer) { clearInterval(fwTimer); fwTimer = null; }
}

// helper used by reservation page
function handleBookingSuccess(json){
  if (json && (json.nowUnlockedTier === 5 || json.nowUnlockedTier === 10 || json.nowUnlockedTier === 15)){
    showLoyaltyModal(json.nowUnlockedTier);
  } else {
    alert("Reservation received. You will get a confirmation email shortly. Please also check your spam folder.");
  }
}
