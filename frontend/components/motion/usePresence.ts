"use client";

// Keeps a popover/dialog mounted for a moment after it is closed so it can
// play its closing animation instead of vanishing. Pair the returned `state`
// with the .anim-pop / .anim-dialog / .anim-fade classes in globals.css:
//
//   const menu = usePresence(open);
//   {menu.mounted && <div className="anim-pop" data-state={menu.state}>…</div>}

import { useEffect, useState } from "react";

export function usePresence(show: boolean, exitMs = 180) {
  const [rendered, setRendered] = useState(show);
  // Opening: mount straight away (adjusting state during render on a prop
  // change is the React-recommended pattern; no extra effect pass).
  if (show && !rendered) setRendered(true);

  useEffect(() => {
    if (show || !rendered) return;
    const timer = window.setTimeout(() => setRendered(false), exitMs);
    return () => window.clearTimeout(timer);
  }, [show, rendered, exitMs]);

  return { mounted: show || rendered, state: (show ? "open" : "closed") as "open" | "closed" };
}

export default usePresence;
