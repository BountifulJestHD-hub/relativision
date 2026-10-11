const VERT = `
attribute vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }
`;

const canvas = document.getElementById('gl');
const glow   = document.getElementById('glow');
const gctx   = glow.getContext('2d');
const gl = canvas.getContext('webgl', { preserveDrawingBuffer: true, antialias: false });

if (!gl) {
  document.body.innerHTML = '<p style="color:#fff;padding:20px">WebGL is not supported.</p>';
  throw new Error('WebGL not supported');
}
gl.getExtension('OES_standard_derivatives');       // needed by the background seam fix (before compiling)

function compile(type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
  return s;
}

const prog = gl.createProgram();
gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
gl.linkProgram(prog);
if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));
gl.useProgram(prog);

// Full-screen quad
const buf = gl.createBuffer();
gl.bindBuffer(gl.ARRAY_BUFFER, buf);
gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
const loc = gl.getAttribLocation(prog, 'aPos');
gl.enableVertexAttribArray(loc);
gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

const U = {};
['uRes', 'uPhase', 'uCam', 'uRoll', 'uSpin', 'uROut', 'uThick', 'uBright', 'uTurb', 'uOpacity',
 'uBeam', 'uSteps', 'uStepSize', 'uOctaves', 'uDisk', 'uShift',
 'uBg', 'uBgOn', 'uBgBright', 'uBgRot',
 'uTonemap', 'uExposure', 'uGamma', 'uContrast', 'uSat', 'uVignette',
 'uMeter', 'uTransparent'
].forEach(n => { U[n] = gl.getUniformLocation(prog, n); });

// ---- Helpers ----
const D2R = Math.PI / 180;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const wrap180 = a => ((a + 180) % 360 + 360) % 360 - 180;
const tick = () => new Promise(r => setTimeout(r, 0));
const raf  = () => new Promise(r => requestAnimationFrame(r));

// ---- State ----
// The camera lives in settings: camYaw / camPitch / camRoll (degrees) and camDist.
let phase = 0;
let settingsOpen = false;      // full-screen settings visible
let tuning = false;            // a camera slider is held: menu faded, simulation visible behind it
let photoMode = false;         // photo taken, UI hidden, waiting for a tap
let busy = false;              // photo / video being rendered
let recording = false, recCancel = false;
let adaptEV = 0;               // current auto-exposure offset (EV)
const isPaused = () => settingsOpen || photoMode || busy;

// ---- Camera orbit ----
// The orbit plane is tilted by orbitIncl from the equatorial plane. psi is the angle along the
// orbit, r(psi) = a(1 - e^2) / (1 + e cos psi) with a = camDist (semi-major axis).
// The angular speed follows Kepler's second law: orbitSpeed is the mean rate, the camera moves
// faster when it is closer.
let camR = settings.camDist;   // distance actually used (differs from camDist on an elliptical orbit)
let orbitPsi = 0;
let orbitDirty = true;         // true = re-aim the orbit at the current view before the next step
let orbitFlip = false;         // 180° roll added when the orbit passes over a pole (keeps the image continuous)

const syncR = () => { if (!settings.autoOrbit) camR = settings.camDist; };
function orbitRadius() {
  const e = settings.orbitEcc;
  return clamp(settings.camDist * (1 - e * e) / (1 + e * Math.cos(orbitPsi)), 6, 200);
}
function syncOrbitFromView() {                       // nearest point of the orbit to the current view
  const y = settings.camYaw * D2R, p = settings.camPitch * D2R, i = settings.orbitIncl * D2R;
  const ex = Math.cos(p) * Math.sin(y), ey = Math.sin(p), ez = Math.cos(p) * Math.cos(y);
  orbitPsi = Math.atan2(ey * Math.sin(i) + ez * Math.cos(i), ex);
  orbitDirty = false;
}
function orbitPlace(fresh) {                         // writes camYaw / camPitch / camR from psi
  const i = settings.orbitIncl * D2R;
  const dx = Math.cos(orbitPsi), dy = Math.sin(orbitPsi) * Math.sin(i), dz = Math.sin(orbitPsi) * Math.cos(i);
  const pitch = clamp(Math.asin(clamp(dy, -1, 1)) / D2R, -87, 87);   // never exactly on the pole
  const yaw = Math.atan2(dx, dz) / D2R;
  if (!fresh && Math.abs(pitch) > 60 && Math.abs(wrap180(yaw - settings.camYaw)) > 120) orbitFlip = !orbitFlip;
  settings.camYaw = yaw;
  settings.camPitch = pitch;
  camR = orbitRadius();
}
function orbitStep(dt) {
  const fresh = orbitDirty;
  if (orbitDirty) syncOrbitFromView();
  const e = settings.orbitEcc;
  const n = settings.orbitSpeed * D2R * (settings.orbitDir === 'retro' ? -1 : 1);
  const f = Math.pow(1 + e * Math.cos(orbitPsi), 2) / Math.pow(1 - e * e, 1.5);
  orbitPsi += n * f * dt;
  orbitPlace(fresh);
}
function refreshCamControls() {
  for (const k of ['camYaw', 'camPitch', 'camRoll', 'camDist']) setControl(k, settings[k]);
}

// ---- Background texture (texture unit 0) ----
const bgTex = gl.createTexture();
gl.activeTexture(gl.TEXTURE0);
gl.bindTexture(gl.TEXTURE_2D, bgTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
gl.uniform1i(U.uBg, 0);

// Uploads an image as a power-of-two (2:1) texture with mipmaps. Returns false if the
// browser refuses (a local file:// image taints the canvas).
function uploadBackground(img) {
  const maxW = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096);
  let W = 256;
  while (W * 2 <= Math.min(img.naturalWidth, maxW)) W *= 2;
  const H = Math.max(128, W >> 1);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  c.getContext('2d').drawImage(img, 0, 0, W, H);
  try {
    gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const an = gl.getExtension('EXT_texture_filter_anisotropic');
    if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    return true;
  } catch (e) {
    return false;
  }
}

function loadBackground(url, label) {
  const img = new Image();
  img.onload = () => {
    if (!uploadBackground(img))
      showToast('The browser blocked "' + label + '" (local file). Run a local web server, or use "Load an image from file…".', 6000);
    if (url.startsWith('blob:')) URL.revokeObjectURL(url);
  };
  img.onerror = () => showToast('Could not load ' + label);
  img.src = url;
}

// Finds bg1.png, bg2.png, ... and fills the Background select
let bgOptions = [];
async function probeBackgrounds() {
  const exists = src => new Promise(res => {
    const im = new Image();
    im.onload = () => res(true);
    im.onerror = () => res(false);
    im.src = src;
  });
  const found = [];
  for (let n = 1; n <= BG_MAX; n++) {
    const f = 'bg' + n + '.png';
    if (!(await exists(f))) break;
    found.push([f, 'Background ' + n]);
  }
  for (const e of BG_EXTRA) if (await exists(e[0])) found.push(e);
  bgOptions = found;
  if (found.length) {
    controls.bg.setOptions(found, found[0][0]);
    loadBackground(found[0][0], found[0][1]);
  } else {
    controls.bg.setOptions([['', 'No bg1.png found (use "Load an image…")']], '');
  }
}

// ---- Exposure metering: a tiny render of the scene, read back as log-luminance ----
const MW = 16;
const meterTex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, meterTex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, MW, 32, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
const meterFbo = gl.createFramebuffer();
gl.bindFramebuffer(gl.FRAMEBUFFER, meterFbo);
gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, meterTex, 0);
gl.bindFramebuffer(gl.FRAMEBUFFER, null);
gl.bindTexture(gl.TEXTURE_2D, bgTex);               // unit 0 must hold the background while drawing
const meterBuf = new Uint8Array(MW * 32 * 4);
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
let adaptReady = false;

function meterScene(dt, s = settings) {
  const MH = Math.max(4, Math.min(32, Math.round(MW * innerHeight / innerWidth)));
  gl.bindFramebuffer(gl.FRAMEBUFFER, meterFbo);
  gl.viewport(0, 0, MW, MH);
  setUniforms(s, MW, MH, true);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  gl.readPixels(0, 0, MW, MH, gl.RGBA, gl.UNSIGNED_BYTE, meterBuf);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.viewport(0, 0, canvas.width, canvas.height);

  // Centre-weighted log-average of the lit pixels (near-black space is ignored)
  let sw = 0, sl = 0;
  for (let y = 0; y < MH; y++) for (let x = 0; x < MW; x++) {
    const lg = meterBuf[(y * MW + x) * 4] / 255 * 12 - 8;           // log2 luminance
    const cx = (x + 0.5) / MW - 0.5, cy = (y + 0.5) / MH - 0.5;
    const w = Math.exp(-(cx * cx + cy * cy) / 0.18) * smooth(-6, -3, lg);
    sw += w; sl += w * lg;
  }
  const target = sw > 1e-3
    ? Math.min(settings.adaptMax, Math.max(settings.adaptMin, Math.log2(settings.adaptKey) - sl / sw))
    : 0;

  // Eye-like adaptation: darkening (bright scene) is fast, brightening (dark scene) is slow
  if (!adaptReady) { adaptEV = target; adaptReady = true; return; }
  const rate = (target < adaptEV ? 2.5 : 0.5) * settings.adaptSpeed;
  adaptEV += (target - adaptEV) * (1 - Math.exp(-rate * Math.min(dt, 0.5)));
}

// ---- Sizing + bloom ----
function resize() {
  canvas.width  = Math.max(2, Math.floor(innerWidth  * settings.scale));
  canvas.height = Math.max(2, Math.floor(innerHeight * settings.scale));
  glow.width    = Math.max(2, canvas.width  >> 2);
  glow.height   = Math.max(2, canvas.height >> 2);
  gl.viewport(0, 0, canvas.width, canvas.height);
}
function applyBloom() {
  glow.style.opacity = Math.min(1, settings.bloom) * 0.8;
  glow.style.filter  = `blur(14px) brightness(${1 + settings.bloom * 0.3})`;
}
addEventListener('resize', () => { if (!photoMode && !busy) resize(); });

// ---- Uniforms (takes any settings-like object, so photos can override things) ----
function setUniforms(s, w = canvas.width, h = canvas.height, meter = false) {
  gl.uniform2f(U.uRes, w, h);
  gl.uniform1f(U.uPhase, phase);
  gl.uniform3f(U.uCam, s.camYaw * D2R, s.camPitch * D2R, camR);
  gl.uniform1f(U.uRoll, (s.camRoll + (orbitFlip ? 180 : 0)) * D2R);
  gl.uniform1f(U.uSpin, s.spin);
  gl.uniform1f(U.uROut, s.outer);
  gl.uniform1f(U.uThick, s.thick);
  gl.uniform1f(U.uBright, s.bright);
  gl.uniform1f(U.uTurb, s.turb);
  gl.uniform1f(U.uOpacity, s.opacity);
  gl.uniform1f(U.uBeam, s.beam);
  gl.uniform1f(U.uSteps, s.steps);
  gl.uniform1f(U.uStepSize, s.stepSize);
  gl.uniform1f(U.uOctaves, s.octaves);
  gl.uniform1f(U.uDisk, s.disk ? 1 : 0);
  gl.uniform1f(U.uShift, s.shift ? 1 : 0);
  gl.uniform1f(U.uBgOn, s.bgOn ? 1 : 0);
  gl.uniform1f(U.uBgBright, s.bgBright);
  gl.uniform1f(U.uBgRot, s.bgRot / 360);
  gl.uniform1f(U.uTonemap, Math.max(0, TONEMAPS.findIndex(t => t[0] === s.tonemap)));
  gl.uniform1f(U.uExposure, s.exposure + (s.adapt ? adaptEV : 0));
  gl.uniform1f(U.uGamma, s.gamma);
  gl.uniform1f(U.uContrast, s.contrast);
  gl.uniform1f(U.uSat, s.sat);
  gl.uniform1f(U.uVignette, s.vignette ? 1 : 0);
  gl.uniform1f(U.uMeter, meter ? 1 : 0);
  gl.uniform1f(U.uTransparent, s.transparent ? 1 : 0);
}

// ---- Presets + info table ----
let applying = false;
function applyPreset(name) {
  const p = PRESETS[name];
  if (!p) return;                                   // 'custom' keeps current values
  applying = true;
  for (const k in p) setControl(k, p[k]);
  applying = false;
  resize();
  applyBloom();
}
function updateInfo() {
  renderInfo(kerrInfo(settings.logMass, settings.spin, settings.camDist, settings.simSpeed));
}

function onChange(key, extra) {
  if (key === 'quality') applyPreset(settings.quality);
  else if (PRESET_KEYS.has(key) && !applying) setControl('quality', 'custom');

  if (key === 'massPreset' && MASS_PRESETS[settings.massPreset] !== undefined)
    setControl('logMass', MASS_PRESETS[settings.massPreset]);
  if (key === 'logMass') setControl('massPreset', 'custom');

  if (key === 'scale') resize();
  if (key === 'bloom') applyBloom();
  if (key === 'photo') capturePhoto();
  if (key === 'video') recordVideo();
  if (key === 'adapt' && !settings.adapt) { adaptEV = 0; adaptReady = false; }

  // camera
  if (key === 'resetCam') {
    setControl('camYaw', 0); setControl('camPitch', 8); setControl('camRoll', 0); setControl('camDist', 55);
    orbitFlip = false; orbitDirty = true;
  }
  if (key === 'camYaw' || key === 'camPitch' || key === 'camDist' || key === 'orbitIncl') orbitDirty = true;
  if (key === 'autoOrbit') {
    orbitDirty = true;
    if (!settings.autoOrbit) {                      // stop exactly where the camera is
      setControl('camDist', clamp(Math.round(camR), 12, 120));
      if (orbitFlip) { setControl('camRoll', wrap180(settings.camRoll + 180)); orbitFlip = false; }
    }
  }

  if (key === 'bg' && settings.bg) {
    const o = bgOptions.find(b => b[0] === settings.bg);
    loadBackground(settings.bg, o ? o[1] : settings.bg);
    setControl('bgOn', true);
  }
  if (key === 'bgFile' && extra) {                  // image picked from disk (never blocked)
    loadBackground(URL.createObjectURL(extra), extra.name);
    controls.bg.setOptions(bgOptions.concat([['custom', extra.name]]), 'custom');
    setControl('bgOn', true);
  }
  updateInfo();
}

// ---- Full-screen settings (simulation paused while open) ----
function setTuning(on) {
  tuning = on && settingsOpen;
  document.body.classList.toggle('tuning', tuning);
  if (!tuning) document.querySelectorAll('.live').forEach(el => el.classList.remove('live'));
}
function openSettings() {
  if (photoMode || busy) return;
  settingsOpen = true;
  pointers.clear();
  refreshCamControls();                             // the camera may have moved (drag, auto-orbit)
  document.body.classList.add('settings-open');
}
function closeSettings() {
  setTuning(false);
  settingsOpen = false;
  document.body.classList.remove('settings-open');
}
document.getElementById('toggle').onclick = openSettings;
document.getElementById('close').onclick  = closeSettings;
document.getElementById('photoBtn').onclick = () => capturePhoto();

// ---- Saving + toast ----
const toastEl = document.getElementById('toast');
let toastTimer = 0;
function showToast(msg, ms = 2500) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function download(blob, ext) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'black-hole-' + new Date().toISOString().replace(/[:.]/g, '-') + '.' + ext;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 20000);
}

// Copies the WebGL canvas to a 2D canvas and adds the bloom layer (on screen it is a CSS layer)
function makeComposer(w, h, k) {
  const out = document.createElement('canvas');
  out.width = w; out.height = h;
  const c = out.getContext('2d');
  const small = document.createElement('canvas');
  small.width = Math.max(2, w >> 2); small.height = Math.max(2, h >> 2);
  const sc = small.getContext('2d');
  return (src, bloom) => {
    c.clearRect(0, 0, w, h);
    c.drawImage(src, 0, 0);
    if (bloom > 0 && 'filter' in c) {
      sc.drawImage(src, 0, 0, small.width, small.height);
      c.save();
      c.globalCompositeOperation = 'screen';
      c.globalAlpha = Math.min(1, bloom) * 0.8;
      c.filter = `blur(${14 * k}px) brightness(${1 + bloom * 0.3})`;
      c.drawImage(small, 0, 0, w, h);
      c.restore();
    }
    return out;
  };
}

// Output size for a given long side: screen aspect, limited by what the GPU can do
function outputSize(longSide, maxSide) {
  const long = Math.min(longSide, maxSide);
  const asp = innerWidth / innerHeight;
  let w = asp >= 1 ? long : Math.round(long * asp);
  let h = asp >= 1 ? Math.round(long / asp) : long;
  return [Math.max(2, w), Math.max(2, h)];
}
const gpuLimit = cap => Math.min(gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), gl.getParameter(gl.MAX_VIEWPORT_DIMS)[0], cap);

// Photo / video use the same quality overrides
const qualityOverride = s => Object.assign({}, s,
  s.photoMax ? { steps: 600, stepSize: Math.min(s.stepSize, 0.04), octaves: 3 } : {});

// Render the full frame in horizontal strips so a huge frame never hits the GPU watchdog
async function renderStrips(w, h, strips, yieldEach) {
  gl.enable(gl.SCISSOR_TEST);
  for (let i = 0; i < strips; i++) {
    const y0 = Math.floor(i * h / strips), y1 = Math.floor((i + 1) * h / strips);
    gl.scissor(0, y0, w, y1 - y0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.finish();
    if (yieldEach) await yieldEach();
  }
  gl.disable(gl.SCISSOR_TEST);
}

function beginCapture() {
  busy = true;                                      // pauses the simulation
  closeSettings();
  document.body.classList.add('photo');             // hides every UI element
  pointers.clear();
}

// ---- Photo capture ----
async function capturePhoto() {
  if (busy || photoMode) return;
  beginCapture();
  await raf(); await raf();                         // let the UI disappear
  syncR();                                          // the photo uses the current camera (yaw, pitch, roll, distance)

  const noBg = settings.photoNoBg;
  const s = Object.assign(qualityOverride(settings),
    noBg ? { bgOn: false, vignette: false, transparent: true } : {});   // transparent: only the hole is opaque

  // Output size: screen size x photoScale, limited to what the GPU / canvas can handle
  let k = settings.photoScale;
  k = Math.min(k, gpuLimit(8192) / Math.max(innerWidth, innerHeight), Math.sqrt(16.7e6 / (innerWidth * innerHeight)));
  const w = Math.round(innerWidth * k), h = Math.round(innerHeight * k);

  canvas.width = w; canvas.height = h;
  gl.viewport(0, 0, w, h);
  setUniforms(s);
  await renderStrips(w, h, Math.max(6, Math.ceil(w * h / 600000)), raf);

  const out = makeComposer(w, h, k)(canvas, noBg ? 0 : settings.bloom);

  // Save (JPEG cannot hold transparency, so "no background" always writes a PNG)
  const jpeg = settings.photoFmt === 'jpeg' && !noBg;
  const blob = await new Promise(res => out.toBlob(res, jpeg ? 'image/jpeg' : 'image/png', 0.95));
  if (blob) download(blob, jpeg ? 'jpg' : 'png');

  photoMode = true;                                 // stay paused with the UI hidden
  busy = false;
  showToast(blob ? 'Photo saved · tap or press any key to resume'
                 : 'Could not save the photo · tap to resume');
}

function exitPhoto() {
  photoMode = false;
  document.body.classList.remove('photo');
  toastEl.classList.remove('show');
  resize();                                         // back to the live preview resolution
}

// ---- Minimal WebM (Matroska) writer: one video track, frames from WebCodecs ----
function makeWebM(chunks, w, h, fps, codecId) {
  const uint = n => { const b = []; do { b.unshift(n % 256); n = Math.floor(n / 256); } while (n > 0); return new Uint8Array(b); };
  const f64  = x => { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, x); return b; };
  const str  = s => new TextEncoder().encode(s);
  const vsize = n => {                              // EBML variable-length size
    let len = 1;
    while (n >= Math.pow(2, 7 * len) - 1) len++;
    const b = new Uint8Array(len);
    for (let i = len - 1, v = n; i >= 0; i--) { b[i] = v % 256; v = Math.floor(v / 256); }
    b[0] |= 1 << (8 - len);
    return b;
  };
  const head = (id, size) => { const s = vsize(size), b = new Uint8Array(id.length + s.length); b.set(id); b.set(s, id.length); return b; };
  const el = (id, ...parts) => {
    const size = parts.reduce((a, p) => a + p.length, 0);
    const b = new Uint8Array(id.length + vsize(size).length + size);
    const hd = head(id, size);
    b.set(hd); let o = hd.length;
    for (const p of parts) { b.set(p, o); o += p.length; }
    return b;
  };

  const ebml = el([0x1A,0x45,0xDF,0xA3],
    el([0x42,0x86], uint(1)), el([0x42,0xF7], uint(1)), el([0x42,0xF2], uint(4)), el([0x42,0xF3], uint(8)),
    el([0x42,0x82], str('webm')), el([0x42,0x87], uint(2)), el([0x42,0x85], uint(2)));

  const durMs = chunks.length ? chunks[chunks.length - 1].ts + 1000 / fps : 0;
  const info = el([0x15,0x49,0xA9,0x66],
    el([0x2A,0xD7,0xB1], uint(1000000)),            // timestamps in milliseconds
    el([0x44,0x89], f64(durMs)),
    el([0x4D,0x80], str('black-hole-sim')), el([0x57,0x41], str('black-hole-sim')));

  const tracks = el([0x16,0x54,0xAE,0x6B],
    el([0xAE],
      el([0xD7], uint(1)), el([0x73,0xC5], uint(1)), el([0x83], uint(1)),
      el([0x86], str(codecId)),
      el([0x23,0xE3,0x83], uint(Math.round(1e9 / fps))),
      el([0xE0], el([0xB0], uint(w)), el([0xBA], uint(h)))));

  // Clusters start at every key frame
  const clusters = [];
  let cur = null;
  const flush = () => { if (cur) clusters.push(el([0x1F,0x43,0xB6,0x75], el([0xE7], uint(cur.ts)), ...cur.blocks)); cur = null; };
  for (const c of chunks) {
    if (!cur || c.key || c.ts - cur.ts > 30000) { flush(); cur = { ts: c.ts, blocks: [] }; }
    const rel = c.ts - cur.ts;
    const bh = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, c.key ? 0x80 : 0x00]);
    cur.blocks.push(el([0xA3], bh, c.d));
  }
  flush();

  const size = info.length + tracks.length + clusters.reduce((a, c) => a + c.length, 0);
  return new Blob([ebml, head([0x18,0x53,0x80,0x67], size), info, tracks, ...clusters], { type: 'video/webm' });
}

const fmtTime = s => s < 60 ? Math.max(1, Math.round(s)) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';

// ---- Video capture ----
// Frames are rendered one at a time (as slowly as needed) and timestamped by frame number,
// so the video is smooth and the right length at any quality.
async function recordVideo() {
  if (busy || photoMode) return;
  if (!('VideoEncoder' in window) || !('VideoFrame' in window)) {
    showToast('Video recording needs WebCodecs (Chrome, Edge, Safari 16.4+ or a recent Firefox).', 6000);
    return;
  }
  const fps = +settings.videoFps;
  const N = Math.max(1, Math.round(settings.videoSecs * fps));
  const [w0, h0] = outputSize(+settings.videoQuality, gpuLimit(4096));
  const w = w0 & ~1, h = h0 & ~1;                   // encoders want even sizes
  const bitrate = Math.min(60e6, Math.round(w * h * fps * 0.14));

  // pick a codec this browser can encode
  let cfg = null, codecId = '';
  for (const [codec, id] of [['vp09.00.50.08', 'V_VP9'], ['vp8', 'V_VP8']]) {
    const c = { codec, width: w, height: h, bitrate, framerate: fps, latencyMode: 'quality' };
    try { if ((await VideoEncoder.isConfigSupported(c)).supported) { cfg = c; codecId = id; break; } } catch (e) {}
  }
  if (!cfg) { showToast('This browser cannot encode ' + w + '×' + h + ' video. Try a lower quality.', 6000); return; }

  beginCapture();
  recording = true; recCancel = false;
  await raf(); await raf();

  const saved = { yaw: settings.camYaw, pitch: settings.camPitch, r: camR, psi: orbitPsi,
                  flip: orbitFlip, dirty: orbitDirty, phase, ev: adaptEV };
  syncR();
  const orbit = settings.videoOrbit;
  if (orbit) orbitDirty = true;                     // start the orbit from the current camera
  const s = Object.assign(qualityOverride(settings), { transparent: false });

  canvas.width = w; canvas.height = h;
  gl.viewport(0, 0, w, h);
  const compose = makeComposer(w, h, w / innerWidth);
  const strips = Math.max(1, Math.ceil(w * h / 600000));

  const chunks = [];
  let encErr = null;
  const enc = new VideoEncoder({
    output: ch => { const d = new Uint8Array(ch.byteLength); ch.copyTo(d); chunks.push({ ts: Math.round(ch.timestamp / 1000), key: ch.type === 'key', d }); },
    error: e => { encErr = e; },
  });
  enc.configure(cfg);

  const t0 = performance.now();
  try {
    for (let i = 0; i < N && !recCancel && !encErr; i++) {
      if (i > 0) {                                  // frame 0 is the current moment
        phase = (phase + settings.simSpeed / fps) % 12000;
        if (orbit) orbitStep(1 / fps);
      }
      if (settings.adapt) meterScene(1 / fps, s);
      setUniforms(s);
      await renderStrips(w, h, strips, strips > 1 ? tick : null);

      const src = settings.bloom > 0 ? compose(canvas, settings.bloom) : canvas;
      const vf = new VideoFrame(src, { timestamp: Math.round(i * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(vf, { keyFrame: i % (fps * 2) === 0 });
      vf.close();
      while (enc.encodeQueueSize > 4 && !encErr) await tick();

      const done = i + 1, spent = (performance.now() - t0) / 1000;
      showToast('Recording ' + done + ' / ' + N + ' frames · about ' + fmtTime(spent / done * (N - done)) + ' left · tap to cancel', 1500);
      await tick();                                 // lets the cancel tap through
    }
    if (!recCancel && !encErr) await enc.flush();
  } catch (e) { encErr = e; }
  try { enc.close(); } catch (e) {}

  // put everything back the way it was
  settings.camYaw = saved.yaw; settings.camPitch = saved.pitch; camR = saved.r;
  orbitPsi = saved.psi; orbitFlip = saved.flip; orbitDirty = true;
  phase = saved.phase; adaptEV = saved.ev;
  recording = false;
  busy = false;
  exitPhoto();

  if (recCancel) showToast('Recording cancelled');
  else if (encErr || !chunks.length) showToast('Recording failed' + (encErr && encErr.message ? ': ' + encErr.message : ''), 6000);
  else {
    download(makeWebM(chunks, w, h, fps, codecId), 'webm');
    showToast('Video saved (' + w + '×' + h + ', ' + settings.videoSecs + ' s)', 4000);
  }
}

// Any tap / key leaves photo mode or cancels a recording (capture phase, so the tap does not also orbit the camera)
addEventListener('pointerdown', e => {
  if (recording) { recCancel = true; e.stopPropagation(); return; }
  if (photoMode) { exitPhoto(); e.stopPropagation(); }
}, true);
addEventListener('keydown', e => {
  if (recording) { recCancel = true; return; }
  if (photoMode) { exitPhoto(); return; }
  if (e.key === 'Escape' && settingsOpen) closeSettings();
  else if ((e.key === 'p' || e.key === 'P') && !busy) capturePhoto();
});

// ---- Camera controls (drag, pinch, wheel) ----
const pointers = new Map();
let pinchStart = 0, distStart = 0;
const inUI = e => e.target.closest && e.target.closest('#hud, #settings');
const clampDist = d => clamp(d, 12, 120);

document.addEventListener('pointerdown', e => {
  if (inUI(e) || isPaused()) return;                // don't orbit while using the UI
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    pinchStart = Math.hypot(a.x - b.x, a.y - b.y);
    distStart = settings.camDist;
  }
});
document.addEventListener('pointermove', e => {
  const pt = pointers.get(e.pointerId);
  if (!pt) return;
  if (pointers.size === 1) {
    settings.camYaw   = wrap180(settings.camYaw - (e.clientX - pt.x) * 0.2865);
    settings.camPitch = clamp(settings.camPitch + (e.clientY - pt.y) * 0.2865, -85, 85);
    orbitDirty = true;                              // an auto-orbit continues from the new position
  }
  pt.x = e.clientX;
  pt.y = e.clientY;
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    setControl('camDist', clampDist(distStart * pinchStart / d));
    updateInfo();
  }
});
const release = e => pointers.delete(e.pointerId);
document.addEventListener('pointerup', release);
document.addEventListener('pointercancel', release);
document.addEventListener('wheel', e => {
  if (inUI(e) || isPaused()) return;
  setControl('camDist', clampDist(settings.camDist * (1 + e.deltaY * 0.001)));
  updateInfo();
}, { passive: true });

// ---- Start ----
buildSettings(onChange, setTuning);
resize();
applyBloom();
updateInfo();
probeBackgrounds();

// ---- Render loop ----
let last = 0, meterAcc = 0, frameNo = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - last) * 0.001);
  last = t;

  const running = !isPaused();
  const preview = tuning && settingsOpen && !photoMode && !busy;   // paused, but redraw for the faded menu
  if (!running && !preview) return;                 // nothing is drawn while paused

  if (running) {
    phase = (phase + dt * settings.simSpeed) % 12000; // 12000 = 100 x PERIOD (shader)
    if (settings.autoOrbit && pointers.size === 0) orbitStep(dt);

    // Exposure adaptation: meter a tiny version of the scene every few frames
    if (settings.adapt) {
      meterAcc += dt;
      if (++frameNo % 4 === 0) { meterScene(meterAcc); meterAcc = 0; }
    }
  } else if (settings.autoOrbit) {                  // previewing a slider while an orbit is set up
    if (orbitDirty) syncOrbitFromView();
    camR = orbitRadius();
  }
  syncR();

  setUniforms(settings);
  gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  if (settings.bloom > 0) gctx.drawImage(canvas, 0, 0, glow.width, glow.height);
}
requestAnimationFrame(frame);