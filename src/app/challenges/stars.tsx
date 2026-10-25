"use client";

import { useProgress } from "@/components/lesson/progress";

/** Stars earned on a challenge: text and shape, three slots. */
export function ChallengeStars({ id }: { id: string }) {
  const progress = useProgress();
  const stars = progress?.get(`challenge:${id}`)?.stars ?? 0;
  return (
    <span className="num shrink-0 text-lg tracking-widest" role="img" aria-label={progress ? `${stars} of 3 stars` : "Stars loading"}>
      <span aria-hidden className={stars ? "text-success" : "text-muted"}>
        {"★".repeat(stars)}
        <span className="text-rule">{"☆".repeat(3 - stars)}</span>
      </span>
    </span>
  );
}
