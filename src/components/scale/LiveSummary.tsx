"use client";

import { useEffect, useRef, useState } from "react";

/** Screen-reader summary, throttled so it updates at most every 5 s (PLAN §13); the last text always lands. */
export function LiveSummary({ text }: { text: string }) {
  const [shown, setShown] = useState(text);
  const last = useRef(0);
  useEffect(() => {
    if (text === shown) return;
    const t = setTimeout(() => {
      last.current = Date.now();
      setShown(text);
    }, Math.max(0, last.current + 5000 - Date.now()));
    return () => clearTimeout(t);
  }, [text, shown]);
  return (
    <p aria-live="polite" className="sr-only">
      {shown}
    </p>
  );
}
