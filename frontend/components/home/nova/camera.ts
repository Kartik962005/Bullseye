// Camera path shared by the WebGL scene and the 2D fallback, so both fly the
// same route through the five formations.

type V3 = [number, number, number];

// One camera stop per formation. `x` shifts the whole formation sideways so it
// sits opposite that act's copy on wide screens.
const STOPS: { pos: V3; look: V3; x: number }[] = [
  { pos: [0, 2.3, 12.5], look: [0, 0, 0], x: 3.1 },
  { pos: [0, 0.4, 12.8], look: [0, 1.4, 0], x: 0 },
  { pos: [0, 2.4, 8.4], look: [0, -0.9, -3.5], x: -2.2 },
  { pos: [0, 0.2, 12.4], look: [0, -1.5, 0], x: 0 },
  { pos: [0.4, 0.6, 12.6], look: [0, 0.2, 0], x: -2.6 },
];

export const FOV = 42;

const smooth = (t: number) => t * t * (3 - 2 * t);

export interface View {
  pos: V3;
  look: V3;
  groupX: number;
}

/** Camera position, look target and formation offset for a morph value 0..4. */
export function viewAt(morph: number, aspect: number, pointer: { x: number; y: number }): View {
  const i = Math.min(3, Math.floor(morph));
  const f = smooth(Math.min(1, Math.max(0, morph - i)));
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const lerp = (p: number, q: number) => p + (q - p) * f;
  const wide = aspect > 1.05;
  // Portrait screens are narrow: pull back so formations still fit.
  const pull = aspect < 1 ? 1 + (1 - aspect) * 0.95 : 1;
  return {
    pos: [lerp(a.pos[0], b.pos[0]) + pointer.x * 0.6, lerp(a.pos[1], b.pos[1]) + pointer.y * 0.4, lerp(a.pos[2], b.pos[2]) * pull],
    look: [lerp(a.look[0], b.look[0]), lerp(a.look[1], b.look[1]), lerp(a.look[2], b.look[2])],
    groupX: wide ? lerp(a.x, b.x) * Math.min(1, (aspect - 1.05) * 2.2) : 0,
  };
}
