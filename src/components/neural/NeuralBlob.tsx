import { forwardRef, useId, useState } from "react";
import { NeuralHelp } from "./NeuralHelp";
import { NeuralFlags } from "./NeuralFlags";
import { NeuralIncludedFeatures, type NeuralIncludedFeature } from "./NeuralIncludedFeatures";

export interface NeuralBlobProps {
  id: string;
  label: string;
  description?: string;
  included?: NeuralIncludedFeature[];
  status?: string;
  suggested?: boolean;
  detected?: boolean;
  selected?: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
}

/** A stable measured shell; hover and focus only reveal reserved inline help. */
export const NeuralBlob = forwardRef<HTMLDivElement, NeuralBlobProps>(
  function NeuralBlob({ id, label, description, included, status, suggested, detected, selected = false, disabled, onSelect }, ref) {
    const helpId = useId();
    const [hovered, setHovered] = useState(false);
    const [focused, setFocused] = useState(false);
    return (
      <div ref={(element) => { if (typeof ref === "function") ref(element); else if (ref) ref.current = element; }}
        data-node={id} className={`neural-blob${selected ? " is-selected" : ""}${disabled ? " is-disabled" : ""}`}
        onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
        onFocus={() => setFocused(true)} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}>
        <button type="button" className="neural-blob-trigger" aria-label={label}
          aria-describedby={description ? helpId : undefined} aria-expanded={selected} aria-pressed={selected}
          disabled={disabled} onPointerDown={(event) => { if (event.pointerType === "touch") setFocused(true); }} onClick={() => { setHovered(false); setFocused(false); onSelect(id); }}>
          <span className="neural-blob-label">{label}</span>
          <span className="neural-blob-status">{status}<span aria-hidden="true">↗</span></span>
          <NeuralFlags suggested={suggested} detected={detected} />
          <NeuralHelp id={helpId} description={description} open={hovered || focused} />
        </button>
        <NeuralIncludedFeatures included={included} />
      </div>
    );
  },
);
