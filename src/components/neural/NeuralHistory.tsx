import type { CSSProperties } from "react";
import type { NeuralNode } from "./NeuralGraph";
import { NeuralBlob } from "./NeuralBlob";

/** Earlier decisions stay returnable, but recede into a quiet, bounded rail. */
export function NeuralHistory({ nodes, onSelect, label }: {
  nodes: NeuralNode[];
  onSelect: (id: string) => void;
  label: string;
}) {
  if (!nodes.length) return null;
  return <div className="neural-history" role="group" aria-label={label}>
    {nodes.map((node, index) => <div className="neural-history-entry" key={node.id}
      style={{ "--history-index": index } as CSSProperties}>
      <NeuralBlob {...node} selected={false} onSelect={onSelect} />
    </div>)}
  </div>;
}
