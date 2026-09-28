// The Nova scene: one THREE.Points draw call whose particles morph between five
// formations (galaxy → market sphere → price terrain → bullseye → rising chart)
// as the page scrolls. All motion happens in the vertex shader, so the CPU only
// writes a handful of uniforms per frame — that is what keeps it at 60fps on
// ordinary laptops and phones. Plain three.js (no React per frame).

import * as THREE from "three";
import { buildFormations } from "./formations";

const VERT = /* glsl */ `
uniform float uMorph;
uniform float uTime;
uniform float uScale;
uniform float uIntro;
attribute vec3 p1;
attribute vec3 p2;
attribute vec3 p3;
attribute vec3 p4;
attribute vec3 c0;
attribute vec3 c1;
attribute vec3 c2;
attribute vec3 c3;
attribute vec3 c4;
attribute vec4 aRnd;
varying vec3 vColor;
varying float vAlpha;

vec3 spinY(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z);
}
vec3 tiltX(vec3 p, float a) {
  float c = cos(a), s = sin(a);
  return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z);
}
// Weight of the hop into formation i; each particle starts its hop a little
// later than its neighbours, so shapes dissolve and re-form organically.
float hop(float i, float stagger) {
  float d = stagger * 0.35;
  return smoothstep(d, d + 0.65, uMorph - (i - 1.0));
}

void main() {
  float stagger = aRnd.x;
  float ph = aRnd.y;

  // 0 · galaxy: differential rotation (inner arms turn faster), then tilt.
  vec3 g = position;
  float r = length(g.xz);
  g = tiltX(spinY(g, uTime * (0.2 / (0.6 + r * 0.32))), 1.02);
  // 1 · sphere slowly turning.
  vec3 s = spinY(p1, uTime * 0.11);
  // 2 · terrain rolling like a live tape.
  vec3 t = p2;
  t.y += sin(t.x * 0.7 + uTime * 0.9) * 0.14 + cos(t.z * 0.6 + uTime * 0.7) * 0.1;
  // 3 · bullseye breathing outwards in rings.
  vec3 b = p3;
  b.xy *= 1.0 + 0.025 * sin(uTime * 2.2 - length(b.xy) * 1.6);
  // 4 · chart ribbon shimmer.
  vec3 c = p4;
  c.y += sin(uTime * 1.5 + c.x * 1.3 + ph) * 0.04;

  float k1 = hop(1.0, stagger);
  float k2 = hop(2.0, stagger);
  float k3 = hop(3.0, stagger);
  float k4 = hop(4.0, stagger);

  vec3 pos = mix(mix(mix(mix(g, s, k1), t, k2), b, k3), c, k4);
  vec3 col = mix(mix(mix(mix(c0, c1, k1), c2, k2), c3, k3), c4, k4);

  // Mid-hop burst: particles swirl outward, then settle into the new shape.
  float burst = sin(k1 * 3.14159) + sin(k2 * 3.14159) + sin(k3 * 3.14159) + sin(k4 * 3.14159);
  vec3 dir = normalize(vec3(sin(ph * 1.7), cos(ph * 2.3), sin(ph * 3.1 + aRnd.w * 6.28)) + 1e-4);
  pos += dir * burst * (0.7 + aRnd.w * 1.5);

  // Opening: particles stream in from a wide cloud.
  float intro = 1.0 - uIntro;
  pos += dir * intro * intro * (9.0 + aRnd.w * 9.0);

  // Idle float so the scene never looks frozen.
  pos += vec3(sin(uTime * 0.6 + ph), cos(uTime * 0.5 + ph * 1.3), sin(uTime * 0.4 + ph * 0.7)) * 0.035;

  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  float dist = -mv.z;
  gl_PointSize = clamp(aRnd.z * 0.048 * uScale / max(dist, 0.1), 1.0, 26.0);
  gl_Position = projectionMatrix * mv;

  vColor = col * (1.0 + burst * 0.3);
  vAlpha = smoothstep(34.0, 9.0, dist) * smoothstep(0.8, 2.6, dist) * uIntro;
}
`;

const FRAG = /* glsl */ `
uniform float uOpacity;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float d = length(gl_PointCoord - 0.5);
  if (d > 0.5) discard;
  float a = pow(smoothstep(0.5, 0.0, d), 1.7) * vAlpha * uOpacity;
  gl_FragColor = vec4(vColor, a);
}
`;

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

const smooth = (t: number) => t * t * (3 - 2 * t);
const FOV = 42;

export interface NovaSceneOptions {
  canvas: HTMLCanvasElement;
  count: number;
  maxDpr: number;
  /** Reduced motion: no intro, no idle drift, instant shape changes. */
  still?: boolean;
}

export class NovaScene {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private group = new THREE.Group();
  private material: THREE.ShaderMaterial;
  private geometry: THREE.BufferGeometry;
  private points: THREE.Points;

  private morphTarget = 0;
  private morph = 0;
  private pointerTarget = { x: 0, y: 0 };
  private pointer = { x: 0, y: 0 };
  private opacity = 1;
  private time = 0;
  private intro = 0;
  private last = 0;
  private running = false;
  private dpr: number;
  private width = 1;
  private height = 1;
  private frameTimes: number[] = [];
  private look = new THREE.Vector3();
  private lastTick = 0;
  private count: number;
  private drawFraction = 1;

  private still: boolean;

  constructor({ canvas, count, maxDpr, still = false }: NovaSceneOptions) {
    this.still = still;
    this.count = count;
    if (still) this.intro = 1;
    this.dpr = Math.min(window.devicePixelRatio || 1, maxDpr);
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "high-performance",
      depth: false,
      stencil: false,
    });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(this.dpr);

    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);

    const f = buildFormations(count);
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute("position", new THREE.BufferAttribute(f.positions[0], 3));
    for (let i = 1; i < 5; i++) this.geometry.setAttribute(`p${i}`, new THREE.BufferAttribute(f.positions[i], 3));
    for (let i = 0; i < 5; i++) this.geometry.setAttribute(`c${i}`, new THREE.BufferAttribute(f.colors[i], 3));
    this.geometry.setAttribute("aRnd", new THREE.BufferAttribute(f.random, 4));

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: {
        uMorph: { value: 0 },
        uTime: { value: 0 },
        uScale: { value: 1 },
        uIntro: { value: 0 },
        uOpacity: { value: 1 },
      },
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.AdditiveBlending,
    });

    this.points = new THREE.Points(this.geometry, this.material);
    // Positions move in the shader, so the CPU bounding sphere is meaningless.
    this.points.frustumCulled = false;
    this.group.add(this.points);
    this.scene.add(this.group);
  }

  setMorph(value: number) {
    this.morphTarget = Math.max(0, Math.min(4, value));
    this.wake();
  }

  setPointer(x: number, y: number) {
    this.pointerTarget.x = x;
    this.pointerTarget.y = y;
  }

  /** 0 hides the scene and stops the render loop entirely. */
  setOpacity(value: number) {
    this.opacity = value;
    this.material.uniforms.uOpacity.value = value;
    if (value <= 0.01) this.stop();
    else this.wake();
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    this.updateScale();
    if (!this.running) this.render(0);
  }

  start() {
    this.wake();
  }

  stop() {
    if (!this.running) return;
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  dispose() {
    this.stop();
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
  }

  private wake() {
    if (this.running || this.opacity <= 0.01 || document.hidden) return;
    this.running = true;
    this.last = performance.now();
    this.lastTick = this.last;
    this.frameTimes.length = 0;
    this.renderer.setAnimationLoop(this.tick);
  }

  private updateScale() {
    const px = this.height * this.dpr;
    this.material.uniforms.uScale.value = px / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
  }

  private tick = (now: number) => {
    // rAF interval = how fast the whole page is actually running.
    this.adaptQuality((now - this.lastTick) / 1000);
    this.lastTick = now;

    // While nothing is changing (no scroll, no pointer drift) the idle motion
    // only needs 30fps, which halves GPU work and leaves headroom for the page.
    const settled =
      this.intro >= 1 &&
      Math.abs(this.morphTarget - this.morph) < 0.002 &&
      Math.abs(this.pointerTarget.x - this.pointer.x) < 0.003 &&
      Math.abs(this.pointerTarget.y - this.pointer.y) < 0.003;
    if (settled && now - this.last < 31) return;

    const dt = Math.min(0.05, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    this.render(dt);
  };

  /**
   * Step quality down while the page can't hold ~45fps: first 1× pixel ratio,
   * then draw 60% and finally 40% of the particles. Slots are shuffled, so a
   * smaller draw range thins every shape evenly.
   */
  private adaptQuality(interval: number) {
    if (this.intro < 1 || interval <= 0 || interval > 0.25) return;
    this.frameTimes.push(interval);
    if (this.frameTimes.length < 60) return;
    const avg = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.frameTimes.length = 0;
    if (avg <= 0.022) return;
    if (this.dpr > 1) {
      this.dpr = 1;
      this.renderer.setPixelRatio(1);
      this.renderer.setSize(this.width, this.height, false);
      this.updateScale();
    } else if (this.drawFraction > 0.4) {
      this.drawFraction = this.drawFraction > 0.6 ? 0.6 : 0.4;
      this.geometry.setDrawRange(0, Math.floor(this.count * this.drawFraction));
    }
  }

  private render(dt: number) {
    if (!this.still) this.time += dt;
    this.intro = Math.min(1, this.intro + dt / 2.4);
    const introEased = 1 - Math.pow(1 - this.intro, 3);

    // Frame-rate independent easing toward the scroll-driven targets.
    const k = this.still ? 1 : 1 - Math.pow(1 - 0.085, dt * 60);
    this.morph += (this.morphTarget - this.morph) * k;
    const kp = 1 - Math.pow(1 - 0.05, dt * 60);
    this.pointer.x += (this.pointerTarget.x - this.pointer.x) * kp;
    this.pointer.y += (this.pointerTarget.y - this.pointer.y) * kp;

    const u = this.material.uniforms;
    u.uMorph.value = this.morph;
    u.uTime.value = this.time;
    u.uIntro.value = introEased;

    // Camera between the two nearest stops.
    const i = Math.min(3, Math.floor(this.morph));
    const f = smooth(Math.min(1, Math.max(0, this.morph - i)));
    const a = STOPS[i];
    const b = STOPS[i + 1];
    const aspect = this.width / this.height;
    const wide = aspect > 1.05;
    // Portrait screens are narrow: pull back so formations still fit.
    const pull = aspect < 1 ? 1 + (1 - aspect) * 0.95 : 1;
    const lerp = (p: number, q: number) => p + (q - p) * f;

    this.camera.position.set(
      lerp(a.pos[0], b.pos[0]) + this.pointer.x * 0.6,
      lerp(a.pos[1], b.pos[1]) + this.pointer.y * 0.4,
      lerp(a.pos[2], b.pos[2]) * pull,
    );
    this.look.set(lerp(a.look[0], b.look[0]), lerp(a.look[1], b.look[1]), lerp(a.look[2], b.look[2]));
    this.camera.lookAt(this.look);

    this.group.position.x = wide ? lerp(a.x, b.x) * Math.min(1, (aspect - 1.05) * 2.2) : 0;
    this.group.rotation.y = this.pointer.x * 0.1;
    this.group.rotation.x = -this.pointer.y * 0.05;

    this.renderer.render(this.scene, this.camera);
  }
}
