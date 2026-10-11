// Physical constants (SI) and Kerr black-hole quantities for the info panel.
// The renderer itself is scale-free (units of GM/c^2); mass only sets real-world units.
const PHYS = {
  G: 6.67430e-11, c: 299792458, hbar: 1.054571817e-34, kB: 1.380649e-23,
  Msun: 1.98847e30, AU_km: 1.495978707e8,
};
const RG_SUN_KM = PHYS.G * PHYS.Msun / (PHYS.c ** 2) / 1000;   // GM/c^2 of 1 Msun ≈ 1.4766 km
const TAU_SUN_S = PHYS.G * PHYS.Msun / (PHYS.c ** 3);          // GM/c^3 of 1 Msun ≈ 4.9255e-6 s

const SUP = { '-': '⁻', '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
              '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹' };

// Number formatting: plain for mid-range values, 1.23×10⁶ style otherwise
function sci(x, digits = 3) {
  if (!isFinite(x) || x === 0) return String(x);
  const e = Math.floor(Math.log10(Math.abs(x)));
  if (e >= -2 && e < 5) return String(+x.toPrecision(digits));
  const m = x / Math.pow(10, e);
  return m.toFixed(digits - 1) + '×10' + [...String(e)].map(ch => SUP[ch]).join('');
}
function fmtLen(km) {
  return km < 1.5e7 ? sci(km) + ' km' : sci(km / PHYS.AU_km) + ' AU';
}

// ---- Kerr formulas, all in units of GM/c^2 ----
function horizonM(a)      { return 1 + Math.sqrt(1 - a * a); }
function photonSphereM(a) { return 2 * (1 + Math.cos((2 / 3) * Math.acos(-a))); }   // prograde
function iscoM(a) {                                                                   // prograde
  const z1 = 1 + Math.cbrt(1 - a * a) * (Math.cbrt(1 + a) + Math.cbrt(1 - a));
  const z2 = Math.sqrt(3 * a * a + z1 * z1);
  return 3 + z2 - Math.sqrt((3 - z1) * (3 + z1 + 2 * z2));
}

// Rows for the "Black hole" info table
function kerrInfo(logMass, a, camDistM, simSpeed) {
  const m   = Math.pow(10, logMass);            // mass in solar masses
  const rg  = RG_SUN_KM * m;                    // GM/c^2 in km
  const tau = TAU_SUN_S * m;                    // GM/c^3 in s
  const Mkg = PHYS.Msun * m;
  const both = xM => sci(xM) + ' rg · ' + fmtLen(xM * rg);

  const rp = horizonM(a), isco = iscoM(a);
  const periodISCO = 2 * Math.PI * (Math.pow(isco, 1.5) + a) * tau;       // seconds
  const J   = a * PHYS.G * Mkg * Mkg / PHYS.c;                            // kg m^2 / s
  const omegaH = a / (2 * rp) / tau;                                      // rad / s
  const TH  = PHYS.hbar * PHYS.c ** 3 / (8 * Math.PI * PHYS.G * Mkg * PHYS.kB);

  return [
    ['Mass',                      sci(m) + ' M☉  (' + sci(Mkg) + ' kg)'],
    ['Gravitational radius rg',   fmtLen(rg) + '  (GM/c²)'],
    ['Schwarzschild radius rs',   fmtLen(2 * rg) + '  (2GM/c²)'],
    ['Event horizon r₊',          both(rp)],
    ['Ergosphere (equator)',      both(2)],
    ['Photon sphere (prograde)',  both(photonSphereM(a))],
    ['ISCO (prograde)',           both(isco)],
    ['Orbital period at ISCO',    sci(periodISCO) + ' s'],
    ['Angular momentum J',        sci(J) + ' kg·m²/s'],
    ['Horizon spin rate Ω_H',     sci(omegaH) + ' rad/s'],
    ['Hawking temperature',       sci(TH) + ' K'],
    ['Camera distance',           both(camDistM)],
    ['1 s on screen =',           sci(simSpeed * tau) + ' s real time'],
  ];
}