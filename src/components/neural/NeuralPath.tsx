import { useEffect, useId, useState } from "react";

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => typeof window !== "undefined" && (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false));
  useEffect(() => {
    const query = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!query) return;
    const update = () => setReduced(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);
  return reduced;
}

export type NeuralMotion = "light" | "paws" | "off";

/** A road is presentation only: its geometry and state belong to its caller. */
export function NeuralPath({ d, active = false, motion = "light", fromId, toId }:  {
  d: string;
  fromId?: string;
  toId?: string;
  active?: boolean;
  motion?: NeuralMotion;
}) {
  const id = `road-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const reduced = useReducedMotion();
  if (reduced) motion = "off";
  return (
    <g className={`neural-road hierarchy${active ? " is-active" : ""}`} data-motion={motion} data-kind="hierarchy"
      data-edge={fromId && toId ? `${fromId}->${toId}` : undefined} data-from={fromId} data-to={toId}>
      <path className="neural-road-bed" d={d} />
      <path id={id} className="neural-road-line" d={d} />
      {motion === "light" && <path className="neural-road-light" d={d} pathLength={100} />}
      {motion === "paws" && [0, 1, 2].map((step) => (
        <g key={step} className={`neural-paw neural-paw-${step}`}>
          <animateMotion dur="9s" begin={`${-step * 0.6}s`} repeatCount="indefinite" rotate="auto">
            <mpath href={`#${id}`} />
          </animateMotion>
          <ellipse cx="0" cy="0" rx="3" ry="3.5" />
          <circle cx="4" cy="-4" r="1.5" />
          <circle cx="6" cy="0" r="1.5" />
          <circle cx="4" cy="4" r="1.5" />
        </g>
      ))}
    </g>
  );
}
