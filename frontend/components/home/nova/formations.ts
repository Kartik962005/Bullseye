// Particle formations for the Nova homepage scene. Every formation fills the
// same N slots, so the shader can morph slot i from one shape to the next as
// the page scrolls. Built once on the CPU with a seeded RNG (stable layout on
// every visit), then uploaded as static attributes — the GPU does the rest.

export const PALETTE = {
  amber: [1.0, 0.72, 0.3],
  pink: [1.0, 0.18, 0.59],
  violet: [0.55, 0.36, 0.96],
  cyan: [0.0, 0.9, 1.0],
  lime: [0.72, 1.0, 0.24],
  white: [1.0, 0.95, 0.88],
  deepViolet: [0.36, 0.13, 0.71],
} as const;

type RGB = readonly [number, number, number] | readonly number[];

export interface Formations {
  count: number;
  positions: Float32Array[]; // 5 × (N*3)
  colors: Float32Array[]; // 5 × (N*3)
  random: Float32Array; // N*4: stagger, phase, size, spare
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mix(a: RGB, b: RGB, t: number, out: number[]) {
  out[0] = a[0] + (b[0] - a[0]) * t;
  out[1] = a[1] + (b[1] - a[1]) * t;
  out[2] = a[2] + (b[2] - a[2]) * t;
  return out;
}

/** Piecewise gradient through several stops at t ∈ [0,1]. */
function ramp(stops: RGB[], t: number, out: number[]) {
  const x = Math.min(0.9999, Math.max(0, t)) * (stops.length - 1);
  const i = Math.floor(x);
  return mix(stops[i], stops[i + 1], x - i, out);
}

export function buildFormations(count: number): Formations {
  const N = count;
  const rnd = mulberry32(20260928);
  const positions = Array.from({ length: 5 }, () => new Float32Array(N * 3));
  const colors = Array.from({ length: 5 }, () => new Float32Array(N * 3));
  const random = new Float32Array(N * 4);
  const c: number[] = [0, 0, 0];

  const put = (f: number, i: number, x: number, y: number, z: number, col: RGB, gain = 1) => {
    positions[f][i * 3] = x;
    positions[f][i * 3 + 1] = y;
    positions[f][i * 3 + 2] = z;
    colors[f][i * 3] = col[0] * gain;
    colors[f][i * 3 + 1] = col[1] * gain;
    colors[f][i * 3 + 2] = col[2] * gain;
  };

  for (let i = 0; i < N; i++) {
    random[i * 4] = rnd(); // morph stagger
    random[i * 4 + 1] = rnd() * Math.PI * 2; // idle phase
    // Mostly small points with a sprinkling of bright "stars".
    random[i * 4 + 2] = rnd() < 0.035 ? 2.6 + rnd() * 1.6 : 0.55 + Math.pow(rnd(), 2) * 1.1;
    random[i * 4 + 3] = rnd();
  }

  // ── 0 · Spiral galaxy (hero). Local XZ plane; the shader spins + tilts it.
  {
    const arms = 4;
    const R = 7.2;
    const stops = [PALETTE.white, PALETTE.amber, PALETTE.pink, PALETTE.violet, PALETTE.cyan];
    for (let i = 0; i < N; i++) {
      const core = rnd() < 0.12;
      const r = core ? Math.pow(rnd(), 2.2) * 1.3 : 0.35 + Math.pow(rnd(), 1.35) * R;
      const branch = ((i % arms) / arms) * Math.PI * 2;
      const angle = branch + r * 0.62;
      const spread = 0.18 + r * 0.075;
      const jx = Math.pow(rnd(), 2.4) * (rnd() < 0.5 ? 1 : -1) * spread * 2.4;
      const jy = Math.pow(rnd(), 2.4) * (rnd() < 0.5 ? 1 : -1) * (core ? 0.45 : 0.28) * (1.2 - r / R);
      const jz = Math.pow(rnd(), 2.4) * (rnd() < 0.5 ? 1 : -1) * spread * 2.4;
      ramp(stops, r / R, c);
      put(0, i, Math.cos(angle) * r + jx, jy, Math.sin(angle) * r + jz, c, core ? 1.1 : 0.85 + rnd() * 0.3);
    }
  }

  // ── 1 · Market sphere with an orbital ring ("the whole market, at once").
  {
    const shell = Math.floor(N * 0.72);
    const golden = Math.PI * (3 - Math.sqrt(5));
    const stops = [PALETTE.cyan, PALETTE.violet, PALETTE.pink];
    for (let i = 0; i < N; i++) {
      if (i < shell) {
        const y = 1 - (i / (shell - 1)) * 2;
        const rad = Math.sqrt(1 - y * y);
        const th = golden * i;
        const R = 4.0 + (rnd() - 0.5) * 0.12;
        ramp(stops, (1 - y) / 2, c);
        const lit = rnd() < 0.05 ? 1.6 : 0.8 + rnd() * 0.3;
        put(1, i, Math.cos(th) * rad * R, y * R, Math.sin(th) * rad * R, c, lit);
      } else {
        const a = rnd() * Math.PI * 2;
        const R = 5.3 + Math.pow(rnd(), 1.5) * 1.9;
        const x = Math.cos(a) * R;
        const z = Math.sin(a) * R;
        const y = (rnd() - 0.5) * 0.12;
        // Tilt the ring ~22° around X so it reads as a 3D orbit.
        const tilt = 0.38;
        const col = rnd() < 0.7 ? mix(PALETTE.amber, PALETTE.pink, rnd() * 0.6, c) : PALETTE.lime;
        put(1, i, x, y * Math.cos(tilt) - z * Math.sin(tilt), y * Math.sin(tilt) + z * Math.cos(tilt), col, 0.75 + rnd() * 0.35);
      }
    }
  }

  // ── 2 · Price terrain ("we fly the tape"): a height field of the market.
  {
    const grid = Math.floor(Math.sqrt(N * 0.9));
    const gridCount = grid * grid;
    const W = 22;
    const D = 18;
    const stops = [PALETTE.violet, PALETTE.pink, PALETTE.amber, PALETTE.lime];
    const h = (x: number, z: number) =>
      1.05 * Math.sin(x * 0.42) * Math.cos(z * 0.33) +
      0.55 * Math.sin(x * 1.05 + z * 0.72) +
      0.28 * Math.cos(x * 2.1 - z * 1.3) +
      0.6 * Math.exp(-((x - 2.5) ** 2 + (z + 1) ** 2) / 6);
    for (let i = 0; i < N; i++) {
      if (i < gridCount) {
        const gx = i % grid;
        const gz = Math.floor(i / grid);
        const x = (gx / (grid - 1) - 0.5) * W + (rnd() - 0.5) * 0.05;
        const z = (gz / (grid - 1) - 0.5) * D - 3;
        const y = h(x, z);
        const t = (y + 2.1) / 4.2;
        ramp(stops, t, c);
        const peak = t > 0.82 && rnd() < 0.18;
        put(2, i, x, y - 2.0, z, peak ? PALETTE.lime : c, peak ? 1.6 : 0.85 + t * 0.75);
      } else {
        // Dust drifting above the terrain.
        const x = (rnd() - 0.5) * W;
        const z = (rnd() - 0.5) * D - 3;
        put(2, i, x, h(x, z) - 2 + 0.6 + rnd() * 3.2, z, rnd() < 0.5 ? PALETTE.cyan : PALETTE.pink, 0.45);
      }
    }
  }

  // ── 3 · The bullseye ("then it commits to one"). XY plane, facing camera.
  {
    const rings = [
      { r: 1.15, w: 0.12, col: PALETTE.pink },
      { r: 2.1, w: 0.13, col: PALETTE.cyan },
      { r: 3.05, w: 0.14, col: PALETTE.violet },
      { r: 4.0, w: 0.15, col: PALETTE.pink },
      { r: 4.95, w: 0.16, col: PALETTE.cyan },
    ];
    const totalR = rings.reduce((s, r) => s + r.r, 0);
    const centre = Math.floor(N * 0.07);
    const ticks = Math.floor(N * 0.05);
    let i = 0;
    for (; i < centre; i++) {
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 0.7) * 0.5;
      mix(PALETTE.white, PALETTE.amber, r / 0.5, c);
      put(3, i, Math.cos(a) * r, Math.sin(a) * r, (rnd() - 0.5) * 0.2, c, 1.25);
    }
    for (let k = 0; k < ticks; k++, i++) {
      // Crosshair ticks outside the last ring.
      const dir = k % 4;
      const d = 5.45 + rnd() * 1.3;
      const off = (rnd() - 0.5) * 0.06;
      const x = dir === 0 ? d : dir === 1 ? -d : off;
      const y = dir === 2 ? d : dir === 3 ? -d : off;
      put(3, i, x, y, (rnd() - 0.5) * 0.1, PALETTE.lime, 1.0);
    }
    const rest = N - i;
    let placed = 0;
    rings.forEach((ring, ri) => {
      const n = ri === rings.length - 1 ? rest - placed : Math.floor((rest * ring.r) / totalR);
      for (let k = 0; k < n; k++, i++) {
        const a = rnd() * Math.PI * 2;
        const r = ring.r + (rnd() - 0.5) * ring.w * 2 * Math.pow(rnd(), 0.6);
        put(3, i, Math.cos(a) * r, Math.sin(a) * r, (rnd() - 0.5) * 0.35, ring.col, 0.8 + rnd() * 0.35);
      }
      placed += n;
    });
  }

  // ── 4 · Rising 3D chart ribbon + glowing area fill ("see your number").
  {
    const x0 = -6.6;
    const x1 = 6.6;
    const curve = (x: number) => {
      const t = (x - x0) / (x1 - x0);
      return {
        y: -2.3 + t * 4.8 + 0.5 * Math.sin(x * 2.2) + 0.28 * Math.sin(x * 5.3 + 1.0),
        z: Math.sin(x * 0.45) * 1.4,
        t,
      };
    };
    const line = Math.floor(N * 0.55);
    const head = Math.floor(N * 0.04);
    const stops = [PALETTE.pink, PALETTE.amber, PALETTE.lime];
    let i = 0;
    for (; i < line; i++) {
      const x = x0 + (i / line) * (x1 - x0);
      const p = curve(x);
      const a = rnd() * Math.PI * 2;
      const r = Math.pow(rnd(), 1.8) * 0.16;
      ramp(stops, p.t, c);
      put(4, i, x, p.y + Math.cos(a) * r, p.z + Math.sin(a) * r, c, 1.0 + rnd() * 0.25);
    }
    // Arrowhead burst at the end of the line.
    const end = curve(x1);
    for (let k = 0; k < head; k++, i++) {
      const a = rnd() * Math.PI * 2;
      const b = Math.acos(2 * rnd() - 1);
      const r = Math.pow(rnd(), 1.5) * 0.55;
      put(4, i, x1 + Math.sin(b) * Math.cos(a) * r, end.y + Math.sin(b) * Math.sin(a) * r, end.z + Math.cos(b) * r, PALETTE.white, 1.3);
    }
    // Area under the curve, fading toward the baseline.
    for (; i < N; i++) {
      const x = x0 + rnd() * (x1 - x0);
      const p = curve(x);
      const base = -3.0;
      const f = Math.pow(rnd(), 1.7);
      const y = p.y - f * (p.y - base);
      const col = mix(PALETTE.violet, PALETTE.cyan, rnd() * 0.5 + p.t * 0.4, c);
      put(4, i, x, y, p.z + (rnd() - 0.5) * 0.1, col, 0.55 * (1 - f * 0.75));
    }
  }

  return { count: N, positions, colors, random };
}
