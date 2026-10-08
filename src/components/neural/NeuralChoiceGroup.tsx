import { forwardRef, useId, useState, type CSSProperties } from "react";
import type { NeuralChoice, NeuralNode } from "./NeuralGraph";
import { NeuralHelp } from "./NeuralHelp";
import { NeuralFlags } from "./NeuralFlags";
import { NeuralIncludedFeatures } from "./NeuralIncludedFeatures";

export function NeuralChoiceItem({ choice, index, onSelect, measure }: {
  choice: NeuralChoice;
  index: number;
  onSelect: (id: string) => void;
  measure?: (id: string, element: HTMLElement | null) => void;
}) {
  const helpId = useId();
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  return <div className="neural-choice-row" data-choice={choice.id} style={{ "--choice-step": index % 4 } as CSSProperties}
    ref={(element) => measure?.(choice.id, element)}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}>
    <button type="button" className={`neural-choice${choice.selected ? " is-selected" : ""}`}
      aria-label={choice.label} aria-pressed={Boolean(choice.selected)} disabled={choice.disabled}
      aria-describedby={choice.description ? helpId : undefined}
      onPointerDown={(event) => { if (event.pointerType === "touch") setFocused(true); }} onClick={() => { setHovered(false); setFocused(false); onSelect(choice.id); }}>
      <span className="neural-choice-label">{choice.label}</span>
      <span className="neural-choice-status">{choice.status}<span aria-hidden="true">{choice.selected ? "✓" : "↗"}</span></span>
      <NeuralFlags suggested={choice.suggested} detected={choice.detected} />
      <NeuralHelp id={helpId} description={choice.description} open={hovered || focused} />
    </button>
    <NeuralIncludedFeatures included={choice.included} />
  </div>;
}

/** One organic decision holds its alternatives in a compact staircase. */
export const NeuralChoiceGroup = forwardRef<HTMLDivElement, {
  node: NeuralNode;
  onSelect: (id: string) => void;
  measureChoice?: (id: string, element: HTMLElement | null) => void;
}>(function NeuralChoiceGroup({ node, onSelect, measureChoice }, ref) {
  const helpId = useId();
  const [open, setOpen] = useState(false);
  return <div ref={ref} data-node={node.id} className={`neural-blob neural-choice-group${node.selected ? " is-selected" : ""}`}
    role="group" aria-label={node.label} data-selection-mode={node.selectionMode ?? "single"}>
    <button className="neural-group-heading" type="button" aria-label={node.label}
      aria-describedby={node.description ? helpId : undefined} aria-pressed={Boolean(node.selected)} disabled={node.disabled}
      onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)} onFocus={() => setOpen(true)} onBlur={() => setOpen(false)}
      onPointerDown={(event) => { if (event.pointerType === "touch") setOpen(true); }} onClick={() => { setOpen(false); onSelect(node.id); }}>
      <span className="neural-blob-label">{node.label}</span>
      <span className="neural-blob-status">{node.status}<span aria-hidden="true">↗</span></span>
      <NeuralFlags suggested={node.suggested} detected={node.detected} />
      <NeuralHelp id={helpId} description={node.description} open={open} />
    </button>
    <NeuralIncludedFeatures included={node.included} />
    <div className="neural-choices">
      {node.choices?.map((choice, index) => <NeuralChoiceItem key={choice.id} choice={{ ...choice, disabled: node.disabled || choice.disabled }} index={index} onSelect={onSelect} measure={measureChoice} />)}
    </div>
  </div>;
});
