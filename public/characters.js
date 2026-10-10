// Flat-vector office characters, generated deterministically from a name.

const INK = '#1E2A3A';
const SKIN = ['#F8D5B8', '#F2C9A0', '#EDB98A', '#D08B5B', '#AE5D29', '#7A4A2E'];
const HAIR = ['#2B1B12', '#5A3825', '#A0522D', '#E0B15A', '#1E2A3A', '#B8432F', '#8C96A3', '#3B2F5C'];
const SHIRT = ['#5B8DEF', '#F25F5C', '#70C1B3', '#FFD23F', '#9B5DE5', '#247BA0', '#F7A072', '#2BB673', '#EF476F'];
const STYLES = ['short', 'long', 'bun', 'curly', 'buzz', 'ponytail', 'side'];

function hash(s) {
  let h = 2166136261;
  for (const c of s.toLowerCase()) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return h >>> 0;
}

export function lookFor(name, isOrchestrator = false) {
  let h = hash(name || '?');
  const pick = (arr) => {
    const v = arr[h % arr.length];
    h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0;
    return v;
  };
  const look = {
    skin: pick(SKIN),
    hair: pick(HAIR),
    shirt: pick(SHIRT),
    style: pick(STYLES),
    glasses: pick([false, false, true]),
    beard: false,
    headset: isOrchestrator,
    blazer: isOrchestrator,
  };
  look.beard = ['short', 'buzz', 'side'].includes(look.style) && pick([false, false, true]);
  if (isOrchestrator) look.shirt = '#5B4BC4';
  return look;
}

function hairBack(l) {
  const f = l.hair;
  switch (l.style) {
    case 'long':
      return `<path d="M50 62 C46 30 114 30 110 62 L114 112 C102 118 58 118 46 112 Z" fill="${f}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    case 'bun':
      return `<circle cx="80" cy="30" r="13" fill="${f}" stroke="${INK}" stroke-width="3"/>`;
    case 'ponytail':
      return `<path d="M104 52 C124 56 126 86 116 102 C112 86 106 74 100 66 Z" fill="${f}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"/>`;
    case 'curly': {
      let s = '';
      for (let i = 0; i < 11; i++) {
        const a = Math.PI * (0.95 + (i / 10) * 1.1);
        s += `<circle cx="${(80 + Math.cos(a) * 31).toFixed(1)}" cy="${(64 + Math.sin(a) * 31).toFixed(1)}" r="11" fill="${f}" stroke="${INK}" stroke-width="3"/>`;
      }
      return s;
    }
    default:
      return '';
  }
}

function hairFront(l) {
  const f = l.hair;
  const s = `fill="${f}" stroke="${INK}" stroke-width="3" stroke-linejoin="round"`;
  switch (l.style) {
    case 'buzz':
      return `<path d="M53 60 C53 38 107 38 107 60 C96 50 64 50 53 60 Z" ${s} opacity=".9"/>`;
    case 'side':
      return `<path d="M51 66 C48 36 70 32 86 34 C104 36 112 48 109 66 C100 50 84 46 66 48 C60 54 55 60 51 66 Z" ${s}/>`;
    case 'curly':
      return `<path d="M54 58 C58 40 102 40 106 58 C96 50 64 50 54 58 Z" ${s}/>`;
    case 'long':
      return `<path d="M51 66 C50 38 66 34 80 34 C96 34 110 42 109 66 C100 52 90 48 80 50 C76 56 64 62 51 66 Z" ${s}/>`;
    default:
      return `<path d="M52 64 C50 40 66 34 80 34 C98 34 110 44 108 64 C100 54 88 50 78 52 C68 54 60 58 52 64 Z" ${s}/>`;
  }
}

// Head and torso, positioned for a 160 x 170 viewBox. Arms sit on the desk at y≈140.
function person(l) {
  const ink = `stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;
  const lapels = l.blazer
    ? `<path d="M72 112 L80 132 L88 112" fill="#fff" ${ink}/><path d="M80 120 L80 150" ${ink}/>`
    : `<path d="M70 112 C74 120 86 120 90 112" fill="none" ${ink}/>`;
  const glasses = l.glasses
    ? `<g fill="rgba(255,255,255,.35)" ${ink} stroke-width="2.5"><circle cx="68" cy="70" r="8"/><circle cx="92" cy="70" r="8"/><path d="M76 70 L84 70"/></g>`
    : '';
  const beard = l.beard
    ? `<path d="M56 74 C58 98 102 98 104 74 C98 90 62 90 56 74 Z" fill="${l.hair}" ${ink}/>`
    : '';
  const headset = l.headset
    ? `<path d="M50 66 C48 32 112 32 110 66" fill="none" stroke="${INK}" stroke-width="5" stroke-linecap="round"/>
       <rect x="44" y="60" width="10" height="18" rx="5" fill="${INK}"/>
       <path d="M49 78 C50 90 60 94 70 92" fill="none" ${ink}/><circle cx="71" cy="92" r="3.5" fill="${INK}"/>`
    : '';
  return `
  <g class="person">
    <g class="torso">
      <path d="M38 158 C38 124 56 108 80 108 C104 108 122 124 122 158 Z" fill="${l.shirt}" ${ink}/>
      ${lapels}
    </g>
    <path d="M72 96 L72 110 L88 110 L88 96" fill="${l.skin}" ${ink}/>
    <g class="head">
      ${hairBack(l)}
      <ellipse cx="80" cy="68" rx="28" ry="30" fill="${l.skin}" ${ink}/>
      <circle cx="51.5" cy="72" r="5" fill="${l.skin}" ${ink}/>
      <circle cx="108.5" cy="72" r="5" fill="${l.skin}" ${ink}/>
      <ellipse cx="80" cy="68" rx="26.5" ry="28.5" fill="${l.skin}"/>
      <circle cx="63" cy="80" r="5" fill="#FF8FA3" opacity=".45"/>
      <circle cx="97" cy="80" r="5" fill="#FF8FA3" opacity=".45"/>
      <g class="eyes" fill="${INK}">
        <ellipse cx="68" cy="70" rx="3.2" ry="4"/>
        <ellipse cx="92" cy="70" rx="3.2" ry="4"/>
      </g>
      ${beard}
      <path class="mouth" d="M72 84 C76 89 84 89 88 84" fill="none" ${ink}/>
      ${glasses}
      ${hairFront(l)}
      ${headset}
    </g>
  </g>`;
}

function arms(l) {
  const ink = `stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;
  return `
  <g class="arm arm-l"><path d="M46 132 C44 140 50 146 62 146" fill="none" stroke="${l.shirt}" stroke-width="13" stroke-linecap="round"/>
    <circle cx="64" cy="146" r="6.5" fill="${l.skin}" ${ink}/></g>
  <g class="arm arm-r"><path d="M114 132 C116 140 110 146 98 146" fill="none" stroke="${l.shirt}" stroke-width="13" stroke-linecap="round"/>
    <circle cx="96" cy="146" r="6.5" fill="${l.skin}" ${ink}/></g>`;
}

// A full workstation: chair, character, desk, laptop and mug.
export function stationSVG(name, isOrchestrator = false) {
  const l = lookFor(name, isOrchestrator);
  const ink = `stroke="${INK}" stroke-width="3" stroke-linejoin="round"`;
  return `<svg viewBox="0 0 160 190" class="char" aria-hidden="true">
    <rect x="44" y="84" width="72" height="80" rx="16" fill="#3D4B63" ${ink}/>
    ${person(l)}
    <g class="desk">
      <rect x="4" y="146" width="152" height="40" rx="6" fill="#2F5D62" ${ink}/>
      <rect x="4" y="146" width="152" height="10" rx="5" fill="#3F7A7F" ${ink}/>
    </g>
    ${arms(l)}
    <g class="laptop">
      <path d="M112 146 L118 118 L150 118 L144 146 Z" fill="#C9D3DE" ${ink}/>
      <circle class="laptop-logo" cx="131" cy="132" r="3.5" fill="#fff"/>
    </g>
    <g class="mug">
      <rect x="14" y="128" width="16" height="18" rx="3" fill="#fff" ${ink}/>
      <path d="M30 132 C37 132 37 142 30 142" fill="none" ${ink}/>
    </g>
  </svg>`;
}

// Head-and-shoulders portrait for chat headers and hire memos.
export function portraitSVG(name, isOrchestrator = false) {
  const l = lookFor(name, isOrchestrator);
  return `<svg viewBox="30 18 100 140" class="portrait" aria-hidden="true">${person(l)}</svg>`;
}

// Standing figure used when someone walks over to a teammate's desk.
export function walkerSVG(name, isOrchestrator = false) {
  const l = lookFor(name, isOrchestrator);
  const ink = `stroke="${INK}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"`;
  const leg = (cls, x, foot) => `<g class="leg ${cls}">
      <rect x="${x}" y="146" width="18" height="54" rx="8" fill="#3D4B63" ${ink}/>
      <ellipse cx="${foot}" cy="202" rx="13" ry="7" fill="${INK}"/></g>`;
  const arm = (cls, d, hx) => `<g class="arm ${cls}">
      <path d="${d}" fill="none" stroke="${INK}" stroke-width="17" stroke-linecap="round"/>
      <path d="${d}" fill="none" stroke="${l.shirt}" stroke-width="11" stroke-linecap="round"/>
      <circle cx="${hx}" cy="166" r="6.5" fill="${l.skin}" ${ink}/></g>`;
  return `<svg viewBox="20 16 120 196" class="walker-svg" aria-hidden="true">
    ${leg('leg-l', 60, 66)}
    ${leg('leg-r', 82, 94)}
    ${person(l)}
    ${arm('arm-l', 'M44 128 C40 140 40 152 42 162', 42)}
    ${arm('arm-r', 'M116 128 C120 140 120 152 118 162', 118)}
  </svg>`;
}
