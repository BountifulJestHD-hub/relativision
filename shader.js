// Kerr null-geodesic ray tracer with a thin accretion disk.
// Units: G = c = M = 1  (1 unit = GM/c^2).
// Boyer-Lindquist coordinates, Mino time tau (d tau = d lambda / Sigma).
// State per ray: r, rho = dr/dtau, mu = cos(theta), nu = dmu/dtau, phi.
// Conserved: E = 1, L (axial angular momentum), K (Carter constant).
const FRAG = `
#extension GL_OES_standard_derivatives : enable
precision highp float;

uniform vec2  uRes;
uniform float uPhase;      // disk time in GM/c^3 units
uniform vec3  uCam;        // yaw, pitch (radians), distance (GM/c^2)
uniform float uRoll;       // camera roll about the view axis (radians)
uniform float uSpin;       // a/M
uniform float uROut;       // disk outer radius
uniform float uThick;      // disk scale height H/r (sets the slab thickness)
uniform float uBright;
uniform float uTurb;
uniform float uOpacity;
uniform float uBeam;       // beaming exponent
uniform float uSteps;
uniform float uStepSize;
uniform float uOctaves;
uniform float uDisk;       // module flags (0 / 1)
uniform float uShift;
// background (equirectangular texture)
uniform sampler2D uBg;
uniform float uBgOn;
uniform float uBgBright;
uniform float uBgRot;      // rotation in turns (0..1)
// colour pipeline
uniform float uTonemap;    // index, see tonemap()
uniform float uExposure;   // EV stops (manual + auto adaptation)
uniform float uGamma;
uniform float uContrast;
uniform float uSat;
uniform float uVignette;
// special passes
uniform float uMeter;        // 1 = output log-luminance for auto exposure
uniform float uTransparent;  // 1 = premultiplied alpha, only the black hole is opaque

const float PERIOD = 120.0;     // noise crossfade period (keep in sync with main.js)
const int   MAXSTEPS = 600;

float gRin;                     // disk inner edge = ISCO
float gPx;                      // world units covered by one pixel (anti-aliases the fine noise)

// ---------------- noise ----------------
float hash31(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
        mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
    mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
        mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
}
// fp = size of one pixel in noise space: octaves finer than ~2 pixels fade to their mean
float fbm(vec3 p, float oct, float fp) {
  float a = 0.5, s = 0.0, n = 0.0;
  for (int i = 0; i < 3; i++) {
    if (float(i) >= oct) break;
    float w = 1.0 - smoothstep(0.3, 0.7, fp);
    s += a * mix(0.5, vnoise(p), w);
    n += a;
    p *= 2.03;
    fp *= 2.03;
    a *= 0.5;
  }
  return s / n;
}

// ---------------- background ----------------
// Equirectangular lookup. The u coordinate has a seam where atan() wraps; picking the
// copy of u with the smaller derivative keeps mip-mapping correct across it.
vec3 bgSample(vec3 d) {
  float u = atan(d.z, d.x) * 0.15915494 + 0.5 + uBgRot;
  float v = acos(clamp(d.y, -1.0, 1.0)) * 0.31830989;
  float ua = fract(u);
  float ub = fract(u + 0.5) - 0.5;
#ifdef GL_OES_standard_derivatives
  float uu = fwidth(ua) <= fwidth(ub) ? ua : ub;
#else
  float uu = ua;
#endif
  return pow(texture2D(uBg, vec2(uu, v)).rgb, vec3(2.2)) * uBgBright;   // sRGB -> linear
}

// Warm orange palette: deep red (cool) -> orange -> amber -> pale yellow (hottest)
vec3 blackbody(float t) {
  vec3 c = mix(vec3(0.55, 0.07, 0.01), vec3(1.00, 0.30, 0.03), smoothstep(0.02, 0.5, t));
  c = mix(c, vec3(1.00, 0.50, 0.10), smoothstep(0.45, 1.0, t));
  return mix(c, vec3(1.00, 0.78, 0.40), smoothstep(1.0, 1.7, t));
}

// ---------------- tone mapping ----------------
vec3 acesFitted(vec3 v) {
  const mat3 inM  = mat3(0.59719, 0.07600, 0.02840,
                         0.35458, 0.90834, 0.13383,
                         0.04823, 0.01566, 0.83777);
  const mat3 outM = mat3( 1.60475, -0.10208, -0.00327,
                         -0.53108,  1.10813, -0.07276,
                         -0.07367, -0.00605,  1.07602);
  v = inM * (v / 0.6);
  v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081);
  return clamp(outM * v, 0.0, 1.0);
}
vec3 hable(vec3 x) {
  const float A = 0.15, B = 0.50, C = 0.10, D = 0.20, E = 0.02, F = 0.30;
  return ((x * (A * x + C * B) + D * E) / (x * (A * x + B) + D * F)) - E / F;
}
vec3 khronosNeutral(vec3 c) {
  const float startCompression = 0.8 - 0.04;
  const float desaturation = 0.15;
  float x = min(c.r, min(c.g, c.b));
  float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  c -= offset;
  float peak = max(c.r, max(c.g, c.b));
  if (peak < startCompression) return c;
  float d = 1.0 - startCompression;
  float newPeak = 1.0 - d * d / (peak + d - startCompression);
  c *= newPeak / peak;
  float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
  return mix(c, newPeak * vec3(1.0), g);
}
vec3 tonemap(vec3 c) {
  if (uTonemap < 0.5)      return 1.0 - exp(-c * 1.1);                                   // exponential
  else if (uTonemap < 1.5) return c / (1.0 + c);                                         // Reinhard
  else if (uTonemap < 2.5) return clamp((c * (2.51 * c + 0.03)) / (c * (2.43 * c + 0.59) + 0.14), 0.0, 1.0); // ACES (fast)
  else if (uTonemap < 3.5) return acesFitted(c);                                         // ACES (fitted)
  else if (uTonemap < 4.5) return hable(c * 2.0) / hable(vec3(11.2));                    // filmic (Hable)
  else if (uTonemap < 5.5) return khronosNeutral(c);                                     // Khronos PBR Neutral
  return clamp(c, 0.0, 1.0);                                                             // linear
}

// ---------------- Kerr helpers ----------------
// Prograde ISCO radius (units of GM/c^2): 6 at a=0, 1 at a=1
float iscoRadius(float a) {
  float z1 = 1.0 + pow(1.0 - a * a, 1.0 / 3.0)
                 * (pow(1.0 + a, 1.0 / 3.0) + pow(1.0 - a, 1.0 / 3.0));
  float z2 = sqrt(3.0 * a * a + z1 * z1);
  return 3.0 + z2 - sqrt((3.0 - z1) * (3.0 + z1 + 2.0 * z2));
}

// Mino-time equations of motion. s = (r, rho, mu, nu)
vec4 deriv(vec4 s, float a, float L, float K) {
  float r = s.x, mu = s.z;
  float P = r * r + a * a - a * L;
  return vec4(
    s.y,
    2.0 * r * P - (r - 1.0) * K,
    s.w,
    -mu * (K + 2.0 * a * L - 2.0 * a * a * (1.0 - mu * mu))
  );
}
float dphi(vec4 s, float a, float L) {
  float r = s.x, mu = s.z;
  float D  = max(r * r - 2.0 * r + a * a, 1e-3);
  float sn = max((1.0 - mu) * (1.0 + mu), 1e-7);   // precise near the poles
  return a * (2.0 * r - a * L) / D + L / sn;
}

// ---------------- accretion disk ----------------
// Returns the thermal source function of the gas at (r, phi) in the disk plane and
// the optical depth dtau of a path of length seg through the disk slab.
vec3 diskSample(float r, float phi, float L, float Eu, float seg, out float dtau) {
  float a = uSpin;
  float edge = smoothstep(gRin, gRin * 1.2 + 0.2, r)
             * (1.0 - smoothstep(0.5 * uROut, uROut, r));
  float r15 = pow(r, 1.5);
  float Om  = 1.0 / (r15 + a);                 // Kerr circular-orbit angular velocity

  // Turbulence: two noise layers advected with differential rotation, crossfaded
  float f1 = fract(uPhase / PERIOD);
  float f2 = fract(f1 + 0.5);
  float w1 = 1.0 - abs(2.0 * f1 - 1.0);
  float w2 = 1.0 - abs(2.0 * f2 - 1.0);
  float a1 = phi - Om * f1 * PERIOD;
  float a2 = phi - Om * f2 * PERIOD;
  // Filamentary rings: fine across the orbit (radius), long along it (azimuth), plus
  // thin concentric grooves. The azimuth sits on a circle so the pattern is seamless.
  float fp = gPx * 2.4;
  float n1 = fbm(vec3(r * 2.4, cos(a1) * 1.5, sin(a1) * 1.5), uOctaves, fp);
  float n2 = fbm(vec3(r * 2.4, cos(a2) * 1.5, sin(a2) * 1.5), uOctaves, fp);
  float ring = mix(0.5, vnoise(vec3(r * 5.0, 3.1, 1.7)), 1.0 - smoothstep(0.3, 0.7, gPx * 5.0)) * 0.6
             + mix(0.5, vnoise(vec3(r * 12.0, 9.2, 4.4)), 1.0 - smoothstep(0.3, 0.7, gPx * 12.0)) * 0.4;
  float n  = w1 * n1 + w2 * n2;
  n = mix(n, ring, 0.35);
  n = clamp((n - 0.5) * 4.0 + 0.5, 0.0, 1.0);     // strong streak contrast

  float dens = pow(gRin / r, 0.7) * edge
             * max(mix(0.8, 0.2 + 1.3 * n, uTurb), 0.02);
  dtau = dens * seg * uOpacity * 1.2;

  // Temperature: Novikov-Thorne-like profile (zero torque at the ISCO)
  float q = sqrt(gRin / r);
  float temp = pow(q, 1.5) * pow(max(1.0 - q, 0.0), 0.25) / 0.488;

  // Total frequency shift g = nu_obs / nu_emit = 1 / (E u^t (1 - Omega L))
  float g = 1.0;
  if (uShift > 0.5) {
    float ut = (r15 + a) / (pow(r, 0.75) * sqrt(max(r15 - 3.0 * sqrt(r) + 2.0 * a, 1e-3)));
    g = clamp(1.0 / (Eu * ut * (1.0 - Om * L)), 0.05, 3.5);
  }
  float inten = pow(temp, 1.8) * pow(g, uBeam);     // gentle fall-off keeps the outer disk visible
  float streak = mix(1.0, 0.08 + 1.8 * n, uTurb);   // bright / dark filaments
  return blackbody(temp * g) * inten * 1.1 * uBright * streak;
}

void main() {
  vec2 uv = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;

  float a  = uSpin;
  float rp = 1.0 + sqrt(max(1.0 - a * a, 0.0));   // outer horizon
  gRin = iscoRadius(a);
  float h = uThick;
  gPx = uCam.z / (1.6 * uRes.y);                    // roughly one pixel in world units at the hole

  // ---- camera (static ZAMO observer at r = rc) ----
  float yaw = uCam.x, pit = uCam.y, rc = uCam.z;
  vec3 er  = vec3(cos(pit) * sin(yaw), sin(pit), cos(pit) * cos(yaw));
  float mu0  = er.y;                               // cos(theta)
  float phi0 = atan(er.z, er.x);
  float sn0  = sqrt(max(1.0 - mu0 * mu0, 1e-5));
  vec3 eth = vec3(mu0 * cos(phi0), -sn0, mu0 * sin(phi0));
  vec3 eph = vec3(-sin(phi0), 0.0, cos(phi0));

  vec3 fw  = -er;
  vec3 rt  = vec3(cos(yaw), 0.0, -sin(yaw));       // from yaw directly, so it stays valid over the poles
  vec3 upv = cross(rt, fw);
  float cr = cos(uRoll), sr = sin(uRoll);
  vec2 uvr = vec2(cr * uv.x - sr * uv.y, sr * uv.x + cr * uv.y);   // roll about the view axis
  vec3 rd  = normalize(fw * 1.6 + rt * uvr.x + upv * uvr.y);

  // The photon travels toward the camera, so its local direction is -rd.
  float nr  = -dot(rd, er);
  float nth = -dot(rd, eth);
  float nph = -dot(rd, eph);

  // ---- constants of motion from the local direction ----
  float s0  = 1.0 - mu0 * mu0;
  float Sig = rc * rc + a * a * mu0 * mu0;
  float Del = rc * rc - 2.0 * rc + a * a;
  float A   = pow(rc * rc + a * a, 2.0) - a * a * Del * s0;
  float alpha = sqrt(Sig * Del / A);
  float omega = 2.0 * a * rc / A;
  float Lu  = nph * sqrt(A * s0 / Sig);
  float Eu  = alpha + omega * Lu;                  // so local energy = 1
  float L   = Lu / Eu;                             // rescale to E = 1
  float rho = nr * sqrt(Sig * Del) / Eu;
  float pth = nth * sqrt(Sig) / Eu;
  float nu  = -sqrt(s0) * pth;
  float K   = pow(L - a * s0, 2.0) / s0 + pth * pth;   // Carter constant

  vec4  s   = vec4(rc, rho, mu0, nu);
  float phi = phi0;

  vec3  col = vec3(0.0);
  float T = 1.0;
  bool  captured = false;
  float rEsc = rc * 1.5 + 20.0;

  for (int i = 0; i < MAXSTEPS; i++) {
    if (float(i) >= uSteps) break;

    float r = s.x, mu = s.z;
    if (r < rp + 0.003) { captured = true; break; }
    if (r > rEsc && s.y < 0.0) break;              // escaped (backward-traced ray leaves)

    // step length: geometric far away, finer near the hole
    float dl = max(uStepSize * (r - 0.8 * rp), 0.01);
    // near the spin axis the azimuth changes fast: resolve it
    dl = min(dl, max(0.4 * r * sqrt(max((1.0 - mu) * (1.0 + mu), 0.0)), 0.004));

    float Sg = r * r + a * a * mu * mu;
    float dt = -dl / Sg;                           // negative: tracing backward in time

    // RK4
    vec4  k1 = deriv(s, a, L, K);              float f1 = dphi(s, a, L);
    vec4  s2 = s + 0.5 * dt * k1;
    vec4  k2 = deriv(s2, a, L, K);             float f2 = dphi(s2, a, L);
    vec4  s3 = s + 0.5 * dt * k2;
    vec4  k3 = deriv(s3, a, L, K);             float f3 = dphi(s3, a, L);
    vec4  s4 = s + dt * k3;
    vec4  k4 = deriv(s4, a, L, K);             float f4 = dphi(s4, a, L);

    float rOld = r, muOld = mu, phiOld = phi;
    s   += dt / 6.0 * (k1 + 2.0 * k2 + 2.0 * k3 + k4);
    phi += dt / 6.0 * (f1 + 2.0 * f2 + 2.0 * f3 + f4);
    s.z  = clamp(s.z, -1.0, 1.0);

    // Radial motion is a saddle in backward integration: errors grow exponentially.
    // Re-impose the null constraint rho^2 = P^2 - Delta*K (keeping the sign of rho).
    {
      float Pn = s.x * s.x + a * a - a * L;
      float Dn = s.x * s.x - 2.0 * s.x + a * a;
      float R  = Pn * Pn - Dn * K;
      if (R > 0.0 && abs(s.y) > 0.2 * abs(Pn)) s.y = sign(s.y) * sqrt(R);
    }

    float rn = s.x, mun = s.z;

    // thin disk: the equatorial-plane crossing is treated as a slab of thickness ~2.5 H
    if (uDisk > 0.5) {
      if (muOld * mun < 0.0) {
        float t  = muOld / (muOld - mun);
        float rx = mix(rOld, rn, t);
        float px = mix(phiOld, phi, t);
        if (rx > gRin && rx < uROut) {
          float cosv = clamp(abs(rn * mun - rOld * muOld) / dl, 0.05, 1.0);
          float dtau;
          vec3 S = diskSample(rx, px, L, Eu, 2.5 * h * rx / cosv, dtau);
          float tr = exp(-dtau);
          col += T * S * (1.0 - tr);               // emission-absorption integral
          T *= tr;
        }
      }
      if (T < 0.01) break;
    }
  }

  // ---- background: outgoing direction of the traced ray (flat-space limit) ----
  // Sampled for every pixel (outside any branch) so texture derivatives are valid.
  float rr = s.x, mm = s.z;
  float sn = sqrt(max(1.0 - mm * mm, 1e-5));
  float cp = cos(phi), sp = sin(phi);
  vec3 e_r = vec3(sn * cp, mm, sn * sp);
  vec3 e_t = vec3(mm * cp, -sn, mm * sp);
  vec3 e_p = vec3(-sp, 0.0, cp);
  float thd = -s.w / sn;
  float phd = dphi(s, a, L);
  vec3 vb = -(s.y * e_r + rr * thd * e_t + rr * sn * phd * e_p);
  float vl = length(vb);
  vb = vl > 1e-6 ? vb / vl : vec3(0.0, 0.0, 1.0);
  vec3 bg = bgSample(vb);
  if (!captured && uBgOn > 0.5) col += T * bg;

  // ---- exposure metering pass: write log2 luminance, encoded 2^-8 .. 2^4 -> 0..1 ----
  if (uMeter > 0.5) {
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    gl_FragColor = vec4(clamp((log2(max(lum, 1e-4)) + 8.0) / 12.0, 0.0, 1.0), 0.0, 0.0, 1.0);
    return;
  }

  // ---- transparent output: only the hole (shadow + disk) is opaque ----
  float oa = 1.0;
  if (uTransparent > 0.5) {
    oa = captured ? 1.0 : 1.0 - T;
    col /= max(oa, 1e-3);                          // premultiplied -> straight colour
  }

  // ---- colour pipeline: exposure -> tone map -> gamma -> contrast -> saturation ----
  col *= exp2(uExposure);
  col = tonemap(col);
  col = pow(max(col, vec3(0.0)), vec3(1.0 / uGamma));
  col = (col - 0.5) * uContrast + 0.5;
  float lum2 = dot(col, vec3(0.2126, 0.7152, 0.0722));
  col = mix(vec3(lum2), col, uSat);
  col = clamp(col, 0.0, 1.0);
  if (uVignette > 0.5) col *= 1.0 - 0.35 * dot(uv, uv);
  gl_FragColor = vec4(col * oa, oa);               // premultiplied alpha
}
`;