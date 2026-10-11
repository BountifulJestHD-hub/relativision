// ===================== Settings definition =====================
// Item types: range | check | select | button | file | info | note | heading
// A range with preview: true fades the menu while it is dragged, so the simulation behind it is visible.
// To add a setting: add one item below, read it as settings.<key> in main.js,
// and (if the shader needs it) add a uniform in shader.js + main.js.

// Performance presets. "Lowest" is the default.
const PRESETS = {
  lowest: { scale: 0.35, steps: 160, stepSize: 0.12,  octaves: 1, bloom: 0   },
  low:    { scale: 0.50, steps: 240, stepSize: 0.09,  octaves: 2, bloom: 0.4 },
  medium: { scale: 0.65, steps: 360, stepSize: 0.07,  octaves: 3, bloom: 0.5 },
  high:   { scale: 0.85, steps: 480, stepSize: 0.055, octaves: 3, bloom: 0.6 },
  ultra:  { scale: 1.00, steps: 600, stepSize: 0.045, octaves: 3, bloom: 0.7 },
};
const PRESET_KEYS = new Set(Object.keys(PRESETS.lowest));

// ---- Backgrounds ----
// bg1.png, bg2.png, ... next to index.html are detected automatically (up to BG_MAX,
// stopping at the first missing number). Add other file names here: ['file.jpg', 'Label'].
const BG_MAX = 12;
const BG_EXTRA = [];

// log10(mass / solar mass) for the mass presets
const MASS_PRESETS = {
  stellar: 1,
  cygx1:   Math.log10(21.2),
  sgra:    Math.log10(4.3e6),
  m87:     Math.log10(6.5e9),
};

// Order matters: the index is sent to the shader (see tonemap() in shader.js)
const TONEMAPS = [
  ['exp',     'Exponential (default)'],
  ['reinhard','Reinhard'],
  ['acesfast','ACES (fast fit)'],
  ['acesfit', 'ACES (fitted)'],
  ['hable',   'Filmic (Hable)'],
  ['neutral', 'Khronos PBR Neutral'],
  ['linear',  'Linear (hard clip)'],
];

// One tab per section, shown in the bottom bar
const SECTIONS = [
  { title: 'Simulation', items: [
    { key: 'spin',      type: 'range', label: 'Spin (a/M)',                min: 0,  max: 0.998, step: 0.001, value: 0.9 },
    { key: 'simSpeed',  type: 'range', label: 'Sim speed (GM/c³ per sec)', min: 0,  max: 30,    step: 0.5,   value: 6 },
    { key: 'camDist',   type: 'range', label: 'Camera distance (GM/c²)',   min: 12, max: 120,   step: 1,     value: 55, preview: true },
    { type: 'heading', label: 'Auto-orbit' },
    { key: 'autoOrbit',  type: 'check',  label: 'Auto-orbit camera', value: false },
    { key: 'orbitSpeed', type: 'range',  label: 'Orbit speed (°/s)', min: 0, max: 60, step: 0.5, value: 7 },
    { key: 'orbitDir',   type: 'select', label: 'Orbit direction', value: 'pro', options: [
        ['pro',   'Prograde (with the hole’s spin)'],
        ['retro', 'Retrograde (against the spin)'],
    ]},
    { key: 'orbitIncl',  type: 'range',  label: 'Inclination (°)',   min: 0, max: 89,  step: 1,    value: 0 },
    { key: 'orbitEcc',   type: 'range',  label: 'Ellipticality (eccentricity)', min: 0, max: 0.7, step: 0.01, value: 0 },
    { type: 'note', label: 'The orbit starts from where the camera is now. The distance slider is the orbit’s semi-major axis; with ellipticality above 0 the camera swings closer and farther, and moves fastest when closest.' },
  ]},
  { title: 'Black hole', items: [
    { key: 'massPreset', type: 'select', label: 'Mass preset', value: 'sgra', options: [
        ['stellar', 'Stellar-mass (10 M☉)'],
        ['cygx1',   'Cygnus X-1 (21 M☉)'],
        ['sgra',    'Sagittarius A* (4.3×10⁶ M☉)'],
        ['m87',     'M87* (6.5×10⁹ M☉)'],
        ['custom',  'Custom'],
    ]},
    { key: 'logMass', type: 'range', label: 'Mass', min: 0, max: 11, step: 0.01,
      value: MASS_PRESETS.sgra, fmt: v => sci(Math.pow(10, v)) + ' M☉' },
    { type: 'info', id: 'bhInfo' },
  ]},
  { title: 'Camera', items: [
    { key: 'camYaw',   type: 'range', label: 'Yaw (°) – around the spin axis',      min: -180, max: 180, step: 0.5, value: 0, preview: true },
    { key: 'camPitch', type: 'range', label: 'Pitch (°) – above / below the disk',  min: -85,  max: 85,  step: 0.5, value: 8, preview: true },
    { key: 'camRoll',  type: 'range', label: 'Roll (°) – tilt the image',           min: -180, max: 180, step: 0.5, value: 0, preview: true },
    { key: 'resetCam', type: 'button', label: 'Reset camera' },
    { type: 'note', label: 'While you drag a slider here the menu fades so you can see the simulation behind it (the simulation itself stays paused). Dragging on the screen changes yaw and pitch too. Photos and videos use exactly this camera.' },
  ]},
  { title: 'Accretion disk', items: [
    { key: 'thick',   type: 'range', label: 'Thickness (H/r)',          min: 0.01, max: 0.3, step: 0.005, value: 0.03 },
    { key: 'outer',   type: 'range', label: 'Outer radius (GM/c²)',     min: 10,   max: 60,  step: 1,     value: 18 },
    { key: 'opacity', type: 'range', label: 'Opacity',                  min: 0.1,  max: 4,   step: 0.05,  value: 1 },
    { key: 'turb',    type: 'range', label: 'Turbulence',               min: 0,    max: 1.5, step: 0.05,  value: 1 },
    { key: 'bright',  type: 'range', label: 'Brightness',               min: 0.2,  max: 4,   step: 0.05,  value: 1 },
    { key: 'beam',    type: 'range', label: 'Doppler beaming strength', min: 0,    max: 4,   step: 0.1,   value: 1.5 },
  ]},
  { title: 'Background', items: [
    { key: 'bgOn',     type: 'check',  label: 'Show background', value: true },
    { key: 'bg',       type: 'select', label: 'Background image', value: '', options: [['', 'Searching for bg1.png …']] },
    { key: 'bgFile',   type: 'file',   label: 'Load an image from file…' },
    { key: 'bgBright', type: 'range',  label: 'Brightness',        min: 0.1, max: 4, step: 0.05, value: 1 },
    { key: 'bgRot',    type: 'range',  label: 'Rotation (°)',      min: 0,   max: 360, step: 1,  value: 0 },
    { type: 'note', label: 'Images are used as equirectangular (2:1) panoramas, so they are lensed around the hole correctly. If a local image is blocked by the browser, run a local web server in this folder, or use "Load an image from file…".' },
  ]},
  { title: 'Modules', items: [
    { key: 'disk',  type: 'check', label: 'Accretion disk',                value: true },
    { key: 'shift', type: 'check', label: 'Doppler + gravitational shift', value: true },
  ]},
  { title: 'Graphics', items: [
    { key: 'quality', type: 'select', label: 'Quality preset', value: 'lowest', options: [
        ['lowest', 'Lowest (fastest)'], ['low', 'Low'], ['medium', 'Medium'],
        ['high', 'High'], ['ultra', 'Ultra'], ['custom', 'Custom'],
    ]},
    { key: 'scale',    type: 'range', label: 'Resolution scale',                  min: 0.25, max: 1,   step: 0.05,  value: 0.35 },
    { key: 'steps',    type: 'range', label: 'Max ray steps',                     min: 80,   max: 600, step: 10,    value: 160 },
    { key: 'stepSize', type: 'range', label: 'Step size (lower = more accurate)', min: 0.03, max: 0.2, step: 0.005, value: 0.12 },
    { key: 'octaves',  type: 'range', label: 'Noise detail',                      min: 1,    max: 3,   step: 1,     value: 1 },
    { key: 'bloom',    type: 'range', label: 'Bloom',                             min: 0,    max: 1,   step: 0.05,  value: 0 },
  ]},
  { title: 'Color', items: [
    { key: 'tonemap',  type: 'select', label: 'Tone mapping', value: 'exp', options: TONEMAPS },
    { key: 'exposure', type: 'range', label: 'Exposure (EV)', min: -3,  max: 3,   step: 0.05, value: 0 },
    { key: 'adapt',      type: 'check', label: 'Exposure adaptation (auto exposure)', value: true },
    { key: 'adaptKey',   type: 'range', label: 'Adaptation target brightness', min: 0.05, max: 1.5, step: 0.01, value: 0.2 },
    { key: 'adaptSpeed', type: 'range', label: 'Adaptation speed',             min: 0.1,  max: 4,   step: 0.1,  value: 1 },
    { key: 'adaptMin',   type: 'range', label: 'Max darkening (EV)',           min: -5,   max: 0,   step: 0.1,  value: -3 },
    { key: 'adaptMax',   type: 'range', label: 'Max brightening (EV)',         min: 0,    max: 5,   step: 0.1,  value: 2 },
    { type: 'note', label: 'Like an eye or camera: a sudden bright view is darkened quickly, a dark view is brightened slowly.' },
    { key: 'gamma',    type: 'range', label: 'Gamma',         min: 1.6, max: 2.8, step: 0.05, value: 2.2 },
    { key: 'contrast', type: 'range', label: 'Contrast',      min: 0.5, max: 1.8, step: 0.01, value: 1 },
    { key: 'sat',      type: 'range', label: 'Saturation',    min: 0,   max: 2,   step: 0.01, value: 1.2 },
    { key: 'vignette', type: 'check', label: 'Vignette',      value: false },
  ]},
  { title: 'Capture', items: [
    { type: 'heading', label: 'Photo' },
    { key: 'photoScale', type: 'range', label: 'Resolution (× screen size)', min: 1, max: 4, step: 0.5, value: 2 },
    { key: 'photoNoBg',  type: 'check', label: 'No background (transparent PNG, only the black hole)', value: false },
    { key: 'photoFmt',   type: 'select', label: 'File format', value: 'png', options: [
        ['png', 'PNG (lossless)'], ['jpeg', 'JPEG (smaller)'],
    ]},
    { type: 'note', label: 'No background always saves a PNG (JPEG cannot be transparent) and turns off vignette and bloom.' },
    { key: 'photo', type: 'button', primary: true, label: '📷  Capture photo' },

    { type: 'heading', label: 'Video' },
    { key: 'videoSecs',    type: 'range',  label: 'Length (seconds)', min: 1, max: 60, step: 1, value: 8 },
    { key: 'videoQuality', type: 'select', label: 'Quality', value: '1280', options: [
        ['640',  'Low · 640 px'],
        ['1280', 'HD · 720p'],
        ['1920', 'Full HD · 1080p'],
        ['2560', '2K · 1440p (maximum)'],
    ]},
    { key: 'videoFps',     type: 'select', label: 'Frame rate', value: '30', options: [
        ['24', '24 fps'], ['30', '30 fps'], ['60', '60 fps'],
    ]},
    { key: 'videoOrbit',   type: 'check',  label: 'Auto-orbit the camera during the video', value: true },
    { type: 'note', label: 'The orbit uses the speed, direction, inclination and ellipticality from the Simulation tab, starting from the current camera. Frames are rendered one by one, so a long, high-quality video can take a few minutes but never stutters. Saved as .webm. Tap or press any key to cancel.' },
    { key: 'video', type: 'button', primary: true, label: '🎬  Record video' },

    { type: 'heading', label: 'Both' },
    { key: 'photoMax', type: 'check', label: 'Maximum ray quality (600 steps, fine sampling)', value: true },
  ]},
];

// ===================== Live values =====================
const settings = {};
for (const sec of SECTIONS)
  for (const d of sec.items)
    if (d.key && d.type !== 'button' && d.type !== 'file') settings[d.key] = d.value;
Object.assign(settings, PRESETS.lowest);      // start on the lowest preset
settings.quality = 'lowest';

// ===================== Builder =====================
const controls = {};                          // key -> { set(value), setOptions(list, value) }

// Change a control from code (no change event is fired)
function setControl(key, value) {
  settings[key] = value;
  if (controls[key]) controls[key].set(value);
}

function renderInfo(rows) {
  const el = document.getElementById('bhInfo');
  if (el) el.innerHTML = rows.map(([k, v]) => `<div>${k}</div><div>${v}</div>`).join('');
}

function makeRow(d, onChange, onPreview) {
  const row = document.createElement('div');
  row.className = 'row';

  if (d.type === 'button') {
    const b = document.createElement('button');
    b.className = 'btn' + (d.primary ? ' primary' : '');
    b.textContent = d.label;
    b.onclick = () => onChange(d.key);
    row.appendChild(b);

  } else if (d.type === 'file') {
    const b = document.createElement('button');
    b.className = 'btn';
    b.textContent = d.label;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.hidden = true;
    b.onclick = () => input.click();
    input.onchange = () => { if (input.files[0]) onChange(d.key, input.files[0]); input.value = ''; };
    row.append(b, input);

  } else if (d.type === 'note') {
    row.className = 'note';
    row.textContent = d.label;

  } else if (d.type === 'heading') {
    row.className = 'sub';
    row.textContent = d.label;

  } else if (d.type === 'info') {
    row.className = 'info';
    row.id = d.id;

  } else if (d.type === 'check') {
    const lab = document.createElement('label');
    lab.className = 'check';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!settings[d.key];
    cb.onchange = () => { settings[d.key] = cb.checked; onChange(d.key); };
    lab.append(cb, d.label);
    row.appendChild(lab);
    controls[d.key] = { set: v => { cb.checked = !!v; } };

  } else if (d.type === 'select') {
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = d.label;
    const sel = document.createElement('select');
    const fill = (opts, val) => {
      sel.innerHTML = '';
      for (const [v, text] of opts) {
        const o = document.createElement('option');
        o.value = v; o.textContent = text;
        sel.appendChild(o);
      }
      sel.value = val;
    };
    fill(d.options, settings[d.key]);
    sel.onchange = () => { settings[d.key] = sel.value; onChange(d.key); };
    row.append(head, sel);
    controls[d.key] = {
      set: v => { sel.value = v; },
      setOptions: (opts, val) => { fill(opts, val); settings[d.key] = val; },   // e.g. the detected backgrounds
    };

  } else {                                    // range
    const decimals = (String(d.step).split('.')[1] || '').length;
    const fmt = d.fmt || (v => (+v).toFixed(decimals));
    const head = document.createElement('div');
    head.className = 'head';
    const name = document.createElement('span');
    name.textContent = d.label;
    const out = document.createElement('output');
    head.append(name, out);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = d.min; input.max = d.max; input.step = d.step;
    input.value = settings[d.key];

    const show = () => { out.textContent = fmt(input.value); };

    // preview sliders: fade the menu while the slider is held (or briefly after a keyboard change)
    let held = false, timer = 0;
    const live = on => { row.classList.toggle('live', on); onPreview(on); };
    if (d.preview) {
      input.addEventListener('pointerdown', () => { held = true; clearTimeout(timer); live(true); });
      const end = () => { if (held) { held = false; live(false); } };
      addEventListener('pointerup', end);
      addEventListener('pointercancel', end);
    }
    input.oninput = () => {
      settings[d.key] = +input.value; show(); onChange(d.key);
      if (d.preview && !held) { live(true); clearTimeout(timer); timer = setTimeout(() => live(false), 700); }
    };
    show();
    row.append(head, input);
    controls[d.key] = { set: v => { input.value = v; show(); } };
  }
  return row;
}

// Builds one page per section plus the bottom tab bar
function buildSettings(onChange, onPreview) {
  const content = document.getElementById('content');
  const tabsBar = document.getElementById('tabs');
  const title   = document.getElementById('secTitle');
  const inner = document.createElement('div');
  inner.className = 'tabs-inner';
  tabsBar.appendChild(inner);

  const pages = [], tabs = [];
  function show(i) {
    pages.forEach((p, j) => { p.hidden = j !== i; });
    tabs.forEach((t, j) => t.classList.toggle('active', j === i));
    title.textContent = SECTIONS[i].title;
    content.scrollTop = 0;
    tabs[i].scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  SECTIONS.forEach((sec, i) => {
    const page = document.createElement('section');
    page.className = 'page';
    page.hidden = true;
    for (const d of sec.items) page.appendChild(makeRow(d, onChange, onPreview));
    content.appendChild(page);
    pages.push(page);

    const tab = document.createElement('button');
    tab.className = 'tab';
    tab.textContent = sec.title;
    tab.onclick = () => show(i);
    inner.appendChild(tab);
    tabs.push(tab);
  });
  show(0);
}