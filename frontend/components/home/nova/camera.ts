// Camera path shared by the WebGL scene and the 2D fallback, so both fly the
// same route through the five formations.

type V3 = [number, number, number];

// One camera stop per formation. `hw`/`hh` are the formation's half width and
// half height as seen by the camera (after the shader's tilt), measured from
// formations.ts, so each one can be scaled to fit the space it has. `fit` is
// off for the terrain, which is meant to fill the screen as you fly over it.
// `top` marks the story stops whose copy sits at the bottom of a phone
// screen; there the formation moves into the free space above it.
const STOPS: { pos: V3; look: V3; hw: number; hh: number; fit: boolean; top: boolean }[] = [
  { pos: [0, 2.3, 12.5], look: [0, 0, 0], hw: 6.6, hh: 6.4, fit: true, top: false }, // galaxy (sparse outer halo may bleed)
  { pos: [0, 0.4, 13.4], look: [0, 0, 0], hw: 6.8, hh: 4.2, fit: true, top: true }, // sphere + orbital ring
  { pos: [0, 2.4, 8.6], look: [0, -0.9, -3.5], hw: 11, hh: 6, fit: false, top: false }, // price terrain
  { pos: [0, 0.2, 13.2], look: [0, 0, 0], hw: 6.6, hh: 6.6, fit: true, top: true }, // bullseye with crosshair ticks
  { pos: [0.4, 0.6, 13.2], look: [0, 0.2, 0], hw: 7.1, hh: 3.2, fit: true, top: true }, // rising chart
];

export const FOV = 42;
const TAN = Math.tan(((FOV / 2) * Math.PI) / 180);

const smooth = (t: number) => t * t * (3 - 2 * t);

export interface View {
  pos: V3;
  look: V3;
  groupX: number;
  groupY: number;
  /** Uniform scale for the formation so it fits its space on this screen. */
  scale: number;
}

/**
 * Where a formation sits and how big it can be on a screen of this shape.
 *
 * Wide screens keep the copy in a left column, so the formation is centred at
 * 72% of the width and may use the right half (with a margin). Narrow screens
 * centre it behind the copy and let it use nearly the full width. A portrait
 * phone also pulls the camera back a little, but only a little: the shader
 * fades dots beyond ~20 units, so the rest of the fit comes from scaling the
 * formation down rather than flying further away.
 */
function frame(stop: (typeof STOPS)[number], aspect: number) {
  const pull = aspect < 1 ? 1 + (1 - aspect) * 0.5 : 1;
  const dx = stop.pos[0] - stop.look[0];
  const dy = stop.pos[1] - stop.look[1];
  const dz = stop.pos[2] - stop.look[2];
  const distance = Math.hypot(dx, dy, dz) * pull;
  const halfH = distance * TAN;
  const halfW = halfH * aspect;
  // 0 on narrow screens, 1 from a little past square: a smooth hand-off.
  const wide = Math.min(1, Math.max(0, (aspect - 1.05) * 2.2));
  const centre = 0.44 * wide; // NDC: 0.44 is 72% across the screen
  const room = 0.92 + (0.5 - 0.92) * wide; // NDC half-width the formation may use
  // Narrow screens: story copy is at the bottom, so lift those formations into
  // the top half and give them that half's height.
  const lift = stop.top ? 1 - wide : 0;
  const centreY = 0.36 * lift;
  const roomY = 0.84 + (0.5 - 0.84) * lift;
  const scale = stop.fit ? Math.min(1, (room * halfW) / stop.hw, (roomY * halfH) / stop.hh) : 1;
  return { pull, groupX: centre * halfW, groupY: centreY * halfH, scale };
}

/** Camera position, look target, formation offset and scale for a morph value 0..4. */
export function viewAt(morph: number, aspect: number, pointer: { x: number; y: number }): View {
  const i = Math.min(3, Math.floor(morph));
  const f = smooth(Math.min(1, Math.max(0, morph - i)));
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const fa = frame(a, aspect);
  const fb = frame(b, aspect);
  const lerp = (p: number, q: number) => p + (q - p) * f;
  const pull = lerp(fa.pull, fb.pull);
  return {
    pos: [lerp(a.pos[0], b.pos[0]) + pointer.x * 0.6, lerp(a.pos[1], b.pos[1]) + pointer.y * 0.4, lerp(a.pos[2], b.pos[2]) * pull],
    look: [lerp(a.look[0], b.look[0]), lerp(a.look[1], b.look[1]), lerp(a.look[2], b.look[2])],
    groupX: lerp(fa.groupX, fb.groupX),
    groupY: lerp(fa.groupY, fb.groupY),
    scale: lerp(fa.scale, fb.scale),
  };
}
