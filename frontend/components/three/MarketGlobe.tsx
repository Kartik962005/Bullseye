"use client";

// Market Globe — a rotating sphere of ~2,200 glowing "stock" nodes with arcs
// between them, in emerald + gold on black. The page scroll drives the camera:
// it orbits the globe, dives toward a cluster (which flares gold), swings to a
// second region, then pulls back out as the globe re-forms.
//
// Perf: one THREE.Points draw call for every node (custom shader handles size,
// twinkle and the gold highlight), one LineSegments call for the arcs. DPR is
// capped and rendering pauses when the tab is hidden.

import { Canvas, useFrame } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";

const NODE_COUNT = 2200;
const GLOBE_RADIUS = 3.2;
const ARC_COUNT = 70;

const EMERALD = "#34d399";
const GOLD = "#ff4fa3";

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** Evenly distribute points on a sphere (deterministic). */
function buildNodes(count: number, radius: number) {
  const positions = new Float32Array(count * 3);
  const rands = new Float32Array(count);
  const rng = makeRng(20260720);
  const golden = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < count; i++) {
    const y = 1 - (i / Math.max(1, count - 1)) * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = golden * i;
    // Slight radial jitter so it reads organic, not like a perfect lattice.
    const rad = radius * (0.985 + rng() * 0.03);
    positions[i * 3] = Math.cos(theta) * r * rad;
    positions[i * 3 + 1] = y * rad;
    positions[i * 3 + 2] = Math.sin(theta) * r * rad;
    rands[i] = rng();
  }
  return { positions, rands };
}

/** Great-circle-ish arcs lifted off the surface, as line segments. */
function buildArcs(positions: Float32Array, count: number) {
  const rng = makeRng(913377);
  const nodeCount = positions.length / 3;
  const segments = 26;
  const verts: number[] = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const mid = new THREE.Vector3();
  const point = new THREE.Vector3();
  const prev = new THREE.Vector3();

  for (let i = 0; i < count; i++) {
    const ai = Math.floor(rng() * nodeCount);
    const bi = Math.floor(rng() * nodeCount);
    a.fromArray(positions, ai * 3);
    b.fromArray(positions, bi * 3);
    if (a.distanceTo(b) < GLOBE_RADIUS * 0.55) continue; // skip trivially short hops

    mid.copy(a).add(b).multiplyScalar(0.5).normalize().multiplyScalar(GLOBE_RADIUS * 1.45);
    const curve = new THREE.QuadraticBezierCurve3(a.clone(), mid.clone(), b.clone());

    for (let s = 0; s <= segments; s++) {
      curve.getPoint(s / segments, point);
      if (s > 0) {
        verts.push(prev.x, prev.y, prev.z, point.x, point.y, point.z);
      }
      prev.copy(point);
    }
  }
  return new Float32Array(verts);
}

const VERTEX = /* glsl */ `
  uniform float uTime;
  uniform vec3  uHighlight;
  uniform float uSize;
  attribute float aRand;
  varying float vHot;
  void main() {
    vec3 n = normalize(position);
    float d = dot(n, normalize(uHighlight));
    float hot = smoothstep(0.70, 0.97, d);
    vHot = hot;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    float twinkle = 0.72 + 0.28 * sin(uTime * 1.6 + aRand * 42.0);
    // Perspective attenuation. This factor must stay small — at ~300 every node
    // draws ~100px wide and 2k additive points merge into one white blob.
    gl_PointSize = uSize * (1.0 + hot * 1.8) * twinkle * (34.0 / max(0.001, -mv.z));
    gl_PointSize = clamp(gl_PointSize, 0.6, 7.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uBase;
  uniform vec3 uHot;
  varying float vHot;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float dist = length(c);
    if (dist > 0.5) discard;
    float alpha = smoothstep(0.5, 0.05, dist);
    vec3 col = mix(uBase, uHot, vHot);
    // Keep total additive energy low so the scene never washes the page out.
    gl_FragColor = vec4(col, alpha * (0.30 + vHot * 0.45));
  }
`;

function Globe({ progress }: { progress: React.RefObject<number> }) {
  const groupRef = useRef<THREE.Group>(null);
  const matRef = useRef<THREE.ShaderMaterial>(null);
  const arcMatRef = useRef<THREE.LineBasicMaterial>(null);

  const { positions, rands } = useMemo(() => buildNodes(NODE_COUNT, GLOBE_RADIUS), []);
  const arcs = useMemo(() => buildArcs(positions, ARC_COUNT), [positions]);

  const uniforms = useMemo(
    () => ({
      uTime: { value: 0 },
      uHighlight: { value: new THREE.Vector3(1, 0, 0) },
      uSize: { value: 1.6 },
      uBase: { value: new THREE.Color(EMERALD) },
      uHot: { value: new THREE.Color(GOLD) },
    }),
    []
  );

  useFrame((state, delta) => {
    const p = progress.current ?? 0;
    uniforms.uTime.value = state.clock.elapsedTime;

    // The gold "active cluster" sweeps around the globe as you scroll.
    const hx = Math.sin(p * Math.PI * 2.0 + 0.6);
    const hy = Math.cos(p * Math.PI * 1.3) * 0.7;
    const hz = Math.cos(p * Math.PI * 2.0 + 0.6);
    uniforms.uHighlight.value.set(hx, hy, hz).normalize();

    // Globe keeps a slow idle spin, nudged along by scroll.
    if (groupRef.current) {
      groupRef.current.rotation.y += delta * 0.06;
      groupRef.current.rotation.y = THREE.MathUtils.damp(
        groupRef.current.rotation.y,
        groupRef.current.rotation.y + p * 0.6,
        1.2,
        delta
      );
      groupRef.current.rotation.x = THREE.MathUtils.damp(
        groupRef.current.rotation.x,
        Math.sin(p * Math.PI) * 0.28,
        1.5,
        delta
      );
    }

    if (arcMatRef.current) {
      arcMatRef.current.opacity = 0.05 + Math.sin(p * Math.PI) * 0.10;
    }

    // Camera: orbit + dive toward a cluster, then pull back out at the end.
    const radius =
      p < 0.35
        ? THREE.MathUtils.lerp(10.5, 5.6, p / 0.35)
        : p < 0.72
          ? THREE.MathUtils.lerp(5.6, 5.0, (p - 0.35) / 0.37)
          : THREE.MathUtils.lerp(5.0, 11.5, (p - 0.72) / 0.28);
    const theta = p * Math.PI * 2.1 + 0.4;
    const phi = Math.PI / 2 - Math.sin(p * Math.PI) * 0.55;

    const tx = radius * Math.sin(phi) * Math.cos(theta);
    const ty = radius * Math.cos(phi);
    const tz = radius * Math.sin(phi) * Math.sin(theta);

    const cam = state.camera;
    cam.position.x = THREE.MathUtils.damp(cam.position.x, tx, 3, delta);
    cam.position.y = THREE.MathUtils.damp(cam.position.y, ty, 3, delta);
    cam.position.z = THREE.MathUtils.damp(cam.position.z, tz, 3, delta);
    cam.lookAt(0, 0, 0);
  });

  return (
    <group ref={groupRef}>
      <points>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[positions, 3]} />
          <bufferAttribute attach="attributes-aRand" args={[rands, 1]} />
        </bufferGeometry>
        <shaderMaterial
          ref={matRef}
          vertexShader={VERTEX}
          fragmentShader={FRAGMENT}
          uniforms={uniforms}
          transparent
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </points>

      <lineSegments>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[arcs, 3]} />
        </bufferGeometry>
        <lineBasicMaterial
          ref={arcMatRef}
          color={EMERALD}
          transparent
          opacity={0.08}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
        />
      </lineSegments>
    </group>
  );
}

/** Page scroll -> 0..1, written to a ref (no re-renders). */
function useScrollProgress() {
  const progress = useRef(0);
  useEffect(() => {
    const update = () => {
      const doc = document.documentElement;
      const max = Math.max(1, doc.scrollHeight - window.innerHeight);
      progress.current = Math.min(1, Math.max(0, window.scrollY / max));
    };
    update();
    window.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  return progress;
}

export default function MarketGlobe({ className }: { className?: string }) {
  const progress = useScrollProgress();
  const [visible, setVisible] = useState(true);
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const onVisibility = () => setVisible(!document.hidden);
    const onResize = () => setIsMobile(window.innerWidth < 768);
    onVisibility();
    onResize();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
    };
  }, []);

  return (
    <div className={className} style={{ position: "absolute", inset: 0 }}>
      <Canvas
        frameloop={visible ? "always" : "never"}
        dpr={[1, isMobile ? 1.25 : 1.75]}
        gl={{ antialias: !isMobile, alpha: true, powerPreference: "high-performance" }}
        camera={{ fov: 55, near: 0.1, far: 120, position: [0, 0, 10.5] }}
      >
        <Globe progress={progress} />
      </Canvas>
    </div>
  );
}
