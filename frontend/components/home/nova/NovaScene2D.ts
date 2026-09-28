// Fallback for browsers without WebGL (hardware acceleration off, blocked GPU
// drivers): the same five formations and camera path, projected on the CPU and
// drawn with Canvas 2D. Far fewer particles and a 30fps cap keep it light.
// Mirrors the maths in NovaScene's vertex shader.

import * as THREE from "three";
import { buildFormations, type Formations } from "./formations";
import { FOV, viewAt } from "./camera";

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

export interface NovaScene2DOptions {
  canvas: HTMLCanvasElement;
  count: number;
  still?: boolean;
}

export class NovaScene2D {
  private ctx: CanvasRenderingContext2D;
  private f: Formations;
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 80);
  private group = new THREE.Object3D();
  private m = new THREE.Matrix4();
  private look = new THREE.Vector3();

  private morphTarget = 0;
  private morph = 0;
  private pointerTarget = { x: 0, y: 0 };
  private pointer = { x: 0, y: 0 };
  private opacity = 1;
  private time = 0;
  private intro = 0;
  private last = 0;
  private raf = 0;
  private width = 1;
  private height = 1;
  private still: boolean;

  constructor({ canvas, count, still = false }: NovaScene2DOptions) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    this.ctx = ctx;
    this.still = still;
    if (still) this.intro = 1;
    this.f = buildFormations(count);
  }

  setMorph(value: number) {
    this.morphTarget = Math.max(0, Math.min(4, value));
    this.start();
  }

  setPointer(x: number, y: number) {
    this.pointerTarget.x = x;
    this.pointerTarget.y = y;
  }

  setOpacity(value: number) {
    this.opacity = value;
    if (value <= 0.01) this.stop();
    else this.start();
  }

  resize(width: number, height: number) {
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);
    const canvas = this.ctx.canvas;
    canvas.width = this.width;
    canvas.height = this.height;
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
    if (!this.raf) this.draw(0);
  }

  start() {
    if (this.raf || this.opacity <= 0.01 || document.hidden) return;
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.tick);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  dispose() {
    this.stop();
  }

  private tick = (now: number) => {
    this.raf = requestAnimationFrame(this.tick);
    if (now - this.last < 31) return; // 30fps is plenty for a CPU renderer
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.draw(dt);
  };

  private draw(dt: number) {
    if (!this.still) this.time += dt;
    this.intro = Math.min(1, this.intro + dt / 2.4);
    const intro = 1 - Math.pow(1 - this.intro, 3);
    const k = this.still ? 1 : 1 - Math.pow(1 - 0.085, dt * 60);
    this.morph += (this.morphTarget - this.morph) * k;
    const kp = 1 - Math.pow(1 - 0.05, dt * 60);
    this.pointer.x += (this.pointerTarget.x - this.pointer.x) * kp;
    this.pointer.y += (this.pointerTarget.y - this.pointer.y) * kp;

    const view = viewAt(this.morph, this.width / this.height, this.pointer);
    this.camera.position.set(...view.pos);
    this.look.set(...view.look);
    this.camera.lookAt(this.look);
    this.camera.updateMatrixWorld();
    this.group.position.set(view.groupX, 0, 0);
    this.group.rotation.set(-this.pointer.y * 0.05, this.pointer.x * 0.1, 0);
    this.group.updateMatrixWorld();
    const e = this.m.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse).multiply(this.group.matrixWorld).elements;

    const { ctx, width: W, height: H } = this;
    ctx.globalCompositeOperation = "source-over";
    ctx.clearRect(0, 0, W, H);
    ctx.globalCompositeOperation = "lighter";

    const { positions: P, colors: C, random: R, count: N } = this.f;
    const t = this.time;
    const m = this.morph;
    const scale = H / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)));
    const tc = Math.cos(1.02);
    const ts = Math.sin(1.02);
    const sc = Math.cos(t * 0.11);
    const ss = Math.sin(t * 0.11);

    for (let i = 0; i < N; i++) {
      const i3 = i * 3;
      const stagger = R[i * 4] * 0.35;
      const ph = R[i * 4 + 1];
      const w = R[i * 4 + 3];
      const k1 = smoothstep(stagger, stagger + 0.65, m);
      const k2 = smoothstep(stagger, stagger + 0.65, m - 1);
      const k3 = smoothstep(stagger, stagger + 0.65, m - 2);
      const k4 = smoothstep(stagger, stagger + 0.65, m - 3);

      // 0 · galaxy: spin (faster near the core), then tilt toward the camera.
      let gx = P[0][i3];
      const gy0 = P[0][i3 + 1];
      let gz = P[0][i3 + 2];
      const ga = t * (0.2 / (0.6 + Math.hypot(gx, gz) * 0.32));
      const gc = Math.cos(ga);
      const gs = Math.sin(ga);
      const rx = gc * gx + gs * gz;
      gz = -gs * gx + gc * gz;
      gx = rx;
      const gy = tc * gy0 - ts * gz;
      gz = ts * gy0 + tc * gz;

      // 1 · sphere turning.
      const s0 = P[1][i3];
      const s2 = P[1][i3 + 2];
      const sx = sc * s0 + ss * s2;
      const sy = P[1][i3 + 1];
      const sz = -ss * s0 + sc * s2;

      // 2 · terrain rolling.
      const tx = P[2][i3];
      const tz = P[2][i3 + 2];
      const ty = P[2][i3 + 1] + Math.sin(tx * 0.7 + t * 0.9) * 0.14 + Math.cos(tz * 0.6 + t * 0.7) * 0.1;

      // 3 · bullseye breathing.
      const bx0 = P[3][i3];
      const by0 = P[3][i3 + 1];
      const pulse = 1 + 0.025 * Math.sin(t * 2.2 - Math.hypot(bx0, by0) * 1.6);

      // 4 · chart shimmer.
      const cx4 = P[4][i3];
      const cy4 = P[4][i3 + 1] + Math.sin(t * 1.5 + cx4 * 1.3 + ph) * 0.04;

      const mix = (a: number, b: number, k: number) => a + (b - a) * k;
      let x = mix(mix(mix(mix(gx, sx, k1), tx, k2), bx0 * pulse, k3), cx4, k4);
      let y = mix(mix(mix(mix(gy, sy, k1), ty, k2), by0 * pulse, k3), cy4, k4);
      let z = mix(mix(mix(mix(gz, sz, k1), tz, k2), P[3][i3 + 2], k3), P[4][i3 + 2], k4);

      const burst = Math.sin(k1 * Math.PI) + Math.sin(k2 * Math.PI) + Math.sin(k3 * Math.PI) + Math.sin(k4 * Math.PI);
      let dx = Math.sin(ph * 1.7);
      let dy = Math.cos(ph * 2.3);
      let dz = Math.sin(ph * 3.1 + w * 6.28);
      const dl = Math.hypot(dx, dy, dz) || 1;
      dx /= dl;
      dy /= dl;
      dz /= dl;
      const push = burst * (0.7 + w * 1.5) + (1 - intro) * (1 - intro) * (9 + w * 9);
      x += dx * push;
      y += dy * push;
      z += dz * push;

      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw < 0.8) continue;
      const px = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw) * 0.5 + 0.5;
      const py = 0.5 - ((e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) * 0.5;
      const sxp = px * W;
      const syp = py * H;
      if (sxp < -20 || sxp > W + 20 || syp < -20 || syp > H + 20) continue;

      const alpha = smoothstep(34, 9, cw) * smoothstep(0.8, 2.6, cw) * intro * this.opacity;
      if (alpha < 0.02) continue;
      const cr = mix(mix(mix(mix(C[0][i3], C[1][i3], k1), C[2][i3], k2), C[3][i3], k3), C[4][i3], k4) * (1 + burst * 0.3);
      const cg = mix(mix(mix(mix(C[0][i3 + 1], C[1][i3 + 1], k1), C[2][i3 + 1], k2), C[3][i3 + 1], k3), C[4][i3 + 1], k4) * (1 + burst * 0.3);
      const cb = mix(mix(mix(mix(C[0][i3 + 2], C[1][i3 + 2], k1), C[2][i3 + 2], k2), C[3][i3 + 2], k3), C[4][i3 + 2], k4) * (1 + burst * 0.3);
      const r = Math.min(255, cr * 255) | 0;
      const g = Math.min(255, cg * 255) | 0;
      const b = Math.min(255, cb * 255) | 0;
      const radius = Math.min(9, Math.max(0.7, (R[i * 4 + 2] * 0.048 * scale) / cw) * 0.32);

      if (radius > 2.2) {
        // Bright "stars" get a faint halo.
        ctx.fillStyle = `rgba(${r},${g},${b},${(alpha * 0.18).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(sxp, syp, radius * 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(${r},${g},${b},${(alpha * 0.9).toFixed(3)})`;
      if (radius < 1.3) {
        ctx.fillRect(sxp - radius, syp - radius, radius * 2, radius * 2);
      } else {
        ctx.beginPath();
        ctx.arc(sxp, syp, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }
}
