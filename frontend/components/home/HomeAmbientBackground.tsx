"use client";

// Full-viewport immersive background for the homepage: the Market Globe 3D
// scene (three.js) that the camera orbits and dives into as the page scrolls.
// A black base always renders underneath, so reduced-motion users and any
// device without WebGL still get a clean, consistent dark page.

import dynamic from "next/dynamic";
import { useEffect, useState } from "react";

const MarketGlobe = dynamic(() => import("@/components/three/MarketGlobe"), {
  ssr: false,
});

export function HomeAmbientBackground() {
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const check = () => {
      const supportsWebGL = (() => {
        try {
          const canvas = document.createElement("canvas");
          return !!(canvas.getContext("webgl2") || canvas.getContext("webgl"));
        } catch {
          return false;
        }
      })();
      setEnabled(!media.matches && supportsWebGL);
    };
    check();
    media.addEventListener?.("change", check);
    return () => media.removeEventListener?.("change", check);
  }, []);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
      {/* Black base — always present so the page never flashes light. */}
      <div className="absolute inset-0 bg-black" />
      {/* Emerald/gold ambience behind the globe. */}
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(760px 520px at 50% 45%, rgba(52,211,153,0.10), transparent 65%), radial-gradient(620px 460px at 72% 28%, rgba(255,79,163,0.07), transparent 60%)",
        }}
      />

      {enabled && <MarketGlobe />}

      {/* Vignette so foreground content stays readable over the scene. */}
      <div
        className="absolute inset-0"
        style={{
          // Hero stays open so the globe reads; everything below is scrimmed
          // hard so body copy never competes with the scene behind it.
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.55) 0%, rgba(0,0,0,0.18) 20%, rgba(0,0,0,0.60) 42%, rgba(0,0,0,0.80) 70%, rgba(0,0,0,0.93) 100%)",
        }}
      />
    </div>
  );
}

export default HomeAmbientBackground;
