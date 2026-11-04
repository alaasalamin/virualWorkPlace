// Speedometer dials for this Mac's CPU and memory, in the HUD under the usage meter.
const $ = (id) => document.getElementById(id);
const SWEEP = 240; // degrees of arc, like a car dashboard
const R = 40;
const CX = 50;
const CY = 52;

const angleOf = (pct) => -SWEEP / 2 + (SWEEP * Math.max(0, Math.min(100, pct))) / 100;

function point(deg, r) {
  const a = ((deg - 90) * Math.PI) / 180;
  return [CX + r * Math.cos(a), CY + r * Math.sin(a)];
}

function arc(from, to, r) {
  const [x1, y1] = point(from, r);
  const [x2, y2] = point(to, r);
  return `M${x1.toFixed(2)} ${y1.toFixed(2)} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

// Tick marks every 10%, longer ones every 50%.
function ticks() {
  let out = '';
  for (let p = 0; p <= 100; p += 10) {
    const deg = angleOf(p);
    const long = p % 50 === 0;
    const [x1, y1] = point(deg, R - 1);
    const [x2, y2] = point(deg, R - (long ? 7 : 4));
    out += `<line x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}" stroke-width="${long ? 2.5 : 1.5}"/>`;
  }
  return out;
}

function dial(id, label) {
  const lo = angleOf(0);
  const mid = angleOf(70);
  const high = angleOf(90);
  const hi = angleOf(100);
  return `<figure class="dial" id="dial-${id}">
    <svg viewBox="0 0 100 92" aria-hidden="true">
      <path class="zone low" d="${arc(lo, mid, R)}"/>
      <path class="zone mid" d="${arc(mid, high, R)}"/>
      <path class="zone high" d="${arc(high, hi, R)}"/>
      <g class="ticks">${ticks()}</g>
      <text class="lim" x="${point(lo, R + 7)[0].toFixed(1)}" y="${point(lo, R + 7)[1].toFixed(1)}">0</text>
      <text class="lim" x="${point(hi, R + 7)[0].toFixed(1)}" y="${point(hi, R + 7)[1].toFixed(1)}">100</text>
      <g class="needle" style="transform: rotate(${lo}deg)">
        <polygon points="${CX},${CY - R + 6} ${CX - 2.6},${CY + 4} ${CX + 2.6},${CY + 4}"/>
      </g>
      <circle class="hub" cx="${CX}" cy="${CY}" r="4.5"/>
      <text class="value" x="${CX}" y="${CY + 22}">–</text>
    </svg>
    <figcaption><b>${label}</b><small></small></figcaption>
  </figure>`;
}

function setDial(id, pct, note) {
  const el = $(`dial-${id}`);
  const p = Math.max(0, Math.min(100, Math.round(pct)));
  el.querySelector('.needle').style.transform = `rotate(${angleOf(p)}deg)`;
  el.querySelector('.value').textContent = `${p}%`;
  el.querySelector('small').textContent = note;
  el.classList.toggle('hot', p >= 90);
  el.setAttribute('aria-label', `${id === 'cpu' ? 'CPU' : 'Memory'} ${p}%`);
}

export function renderDials(s) {
  const box = $('dials');
  if (!s) return;
  if (box.hidden) {
    box.innerHTML = dial('cpu', 'CPU') + dial('mem', 'Memory');
    box.hidden = false;
  }
  setDial('cpu', s.cpu, `${s.cores} cores`);
  setDial('mem', s.mem, `${s.memUsedGb} of ${s.memTotalGb} GB`);
}
