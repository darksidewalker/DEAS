import { useLayoutEffect, useRef, useState } from "react";
import { useI18n } from "../../i18n/I18nProvider";
import type { NeuralIncludedFeature } from "./NeuralIncludedFeatures";
import { NeuralBlob } from "./NeuralBlob";
import { NeuralChoiceGroup } from "./NeuralChoiceGroup";
import { NeuralHistory } from "./NeuralHistory";
import { NeuralPath, type NeuralMotion } from "./NeuralPath";

export interface NeuralChoice {
  id: string;
  label: string;
  description?: string;
  included?: NeuralIncludedFeature[];
  status?: string;
  suggested?: boolean;
  detected?: boolean;
  selected?: boolean;
  disabled?: boolean;
  suggests?: string[];
}
export interface NeuralNode {
  id: string;
  label: string;
  description?: string;
  included?: NeuralIncludedFeature[];
  status?: string;
  suggested?: boolean;
  detected?: boolean;
  parentId: string | null;
  column: number;
  order: number;
  disabled?: boolean;
  selected?: boolean;
  choices?: NeuralChoice[];
  selectionMode?: "single" | "multi";
}
export interface NeuralEdge { id: string; fromId: string; toId: string; kind: "hierarchy" | "suggested" }
export interface NeuralBounds { x: number; y: number; width: number; height: number }

/** Pixel-space ports keep roads in the gaps rather than through hit boxes. */
export function neuralRoad(parent: NeuralBounds, child: NeuralBounds, obstacles: NeuralBounds[] = []): string {
  const py = parent.y + parent.height / 2;
  const cy = child.y + child.height / 2;
  // Different snake rows connect through their shared horizontal gutter.
  if (child.y >= parent.y + parent.height + 8 || parent.y >= child.y + child.height + 8) {
    const px = parent.x + parent.width / 2;
    const cx = child.x + child.width / 2;
    if (Math.abs(px - cx) > Math.min(parent.width, child.width) / 2) {
      const down = child.y > parent.y;
      const sy = down ? parent.y + parent.height : parent.y;
      const ey = down ? child.y : child.y + child.height;
      const lane = (sy + ey) / 2;
      return `M ${px} ${sy} C ${px} ${lane}, ${cx} ${lane}, ${cx} ${ey}`;
    }
  }
  const right = child.x >= parent.x + parent.width + 8;
  const left = parent.x >= child.x + child.width + 8;
  if (right || left) {
    const px = right ? parent.x + parent.width : parent.x;
    const cx = right ? child.x : child.x + child.width;
    const blocked = obstacles.some(box => box !== parent && box !== child && box.x < Math.max(px, cx) && box.x + box.width > Math.min(px, cx) && box.y < Math.max(py, cy) + 1 && box.y + box.height > Math.min(py, cy));
    if (blocked) {
      const lane = Math.max(6, Math.min(parent.y, child.y) - 14);
      const sx = parent.x + parent.width / 2;
      const ex = child.x + child.width / 2;
      return `M ${sx} ${parent.y} C ${sx} ${lane}, ${sx} ${lane}, ${(sx + ex) / 2} ${lane} S ${ex} ${lane}, ${ex} ${child.y}`;
    }
    const lane = (px + cx) / 2;
    return `M ${px} ${py} C ${lane} ${py}, ${lane} ${cy}, ${cx} ${cy}`;
  }
  const lane = Math.max(10, Math.min(parent.x, child.x) - 24);
  return `M ${parent.x} ${py} C ${lane} ${py}, ${lane} ${py}, ${lane} ${(py + cy) / 2} S ${lane} ${cy}, ${child.x} ${cy}`;
}

/** Pack logical order into short rows; CSS reverses every other row visually. */
export function neuralSnakeRows(nodes: NeuralNode[], availableWidth: number): NeuralNode[][] {
  const rows: NeuralNode[][] = [];
  let row: NeuralNode[] = [];
  let used = 0;
  const available = Math.max(1, availableWidth - 32);
  for (const node of [...nodes].sort((a, b) => a.column - b.column || a.order - b.order)) {
    const width = Math.min(available, node.choices ? 360 : 144);
    if (row.length && (used + 36 + width > available || row.length === 4)) {
      rows.push(row); row = []; used = 0;
    }
    used += (row.length ? 36 : 0) + width;
    row.push(node);
  }
  if (row.length) rows.push(row);
  return rows;
}

export function NeuralGraph({ nodes, selectedId, onSelect, motion = "light", label, edges = [], history = [] }: {
  nodes: NeuralNode[];
  selectedId?: string | null;
  onSelect: (id: string) => void;
  motion?: NeuralMotion;
  label?: string;
  edges?: NeuralEdge[];
  history?: NeuralNode[];
}) {
  const { t } = useI18n();
  const choices = nodes.flatMap(node => node.choices ?? []);
  const suggested = choices.filter(choice => choice.selected).flatMap(choice => (choice.suggests ?? [])
    .filter(id => choices.some(target => target.id === id && !target.selected && !target.disabled))
    .map(id => ({ id: `${choice.id}->${id}`, fromId: choice.id, toId: id, kind: "suggested" as const })));
  const roads: NeuralEdge[] = [...nodes.filter(n => n.parentId).map(n => ({ id: n.id, fromId: n.parentId!, toId: n.id, kind: "hierarchy" as const })), ...edges, ...suggested]
    .filter((edge, index, all) => all.findIndex(other => other.kind === edge.kind && other.fromId === edge.fromId && other.toId === edge.toId) === index);
  const root = useRef<HTMLDivElement>(null);
  const elements = useRef(new Map<string, HTMLElement>());
  const [layout, setLayout] = useState<{ width: number; height: number; bounds: Map<string, NeuralBounds> }>({ width: 0, height: 0, bounds: new Map() });
  const rows = neuralSnakeRows(nodes, layout.width || 960);
  const rowSignature = rows.map(row => row.map(node => node.id).join(",")).join(";");
  const measureElement = (id: string, element: HTMLElement | null) => { if (element) elements.current.set(id, element); else elements.current.delete(id); };

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => {
      const box = element.getBoundingClientRect();
      const bounds = new Map<string, NeuralBounds>();
      elements.current.forEach((target, id) => {
        const rect = target.getBoundingClientRect();
        bounds.set(id, { x: rect.left - box.left, y: rect.top - box.top, width: rect.width, height: rect.height });
      });
      setLayout({ width: box.width, height: box.height, bounds });
    };
    measure();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    observer?.observe(element);
    elements.current.forEach(target => observer?.observe(target));
    window.addEventListener("resize", measure);
    let alive = true;
    void document.fonts?.ready.then(() => { if (alive) measure(); });
    return () => { alive = false; observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [nodes, rowSignature]);

  const select = (id: string) => { window.dispatchEvent(new Event("deas:neural-select")); onSelect(id); };
  const graphLabel = label ?? t("neural.connectedChoices");
  return <div className="neural-graph-container">
    <NeuralHistory nodes={history} onSelect={select} label={graphLabel} />

    <div ref={root} className="neural-graph" role="group" aria-label={graphLabel}>
      <svg className="neural-roads" width={layout.width} height={layout.height} aria-hidden="true">
        {roads.filter(edge => edge.kind === "hierarchy").map(edge => {
          const parent = layout.bounds.get(edge.fromId);
          const child = layout.bounds.get(edge.toId);
          const internal = choices.some(choice => choice.id === edge.fromId);
          const obstacles = [...layout.bounds.entries()].filter(([id]) => internal ? choices.some(choice => choice.id === id) : nodes.some(node => node.id === id)).map(([, bounds]) => bounds);
          return parent && child && parent.width > 0 && child.width > 0 ? <NeuralPath key={`${edge.kind}:${edge.fromId}:${edge.toId}`}
            fromId={edge.fromId} toId={edge.toId} d={neuralRoad(parent, child, obstacles)} motion={motion}
            active={selectedId === edge.toId || selectedId === edge.fromId || Boolean(nodes.find(n => n.id === edge.toId)?.selected) || Boolean(choices.find(choice => choice.id === edge.fromId)?.selected)} /> : null;
        })}
      </svg>
      {rows.map((row, index) => <div className={`neural-row${index % 2 ? " is-reversed" : ""}`} key={index}
        style={{ width: Math.max(0, ...rows.map(items => items.reduce((width, item) => width + (item.choices ? 360 : 144), 0) + Math.max(0, items.length - 1) * 36)), maxWidth: "100%" }}>
        {row.map(node => {
          const recommended=(id:string) => roads.some(edge=>edge.kind==='suggested' && edge.toId===id);
          const presentation={...node,suggested:node.suggested || recommended(node.id),choices:node.choices?.map(choice=>({...choice,suggested:choice.suggested || recommended(choice.id)}))};
          return presentation.choices ? <NeuralChoiceGroup key={node.id} node={{ ...presentation, selected: selectedId === node.id || node.selected }} onSelect={select}
            ref={element => measureElement(node.id, element)} measureChoice={measureElement} /> :
            <NeuralBlob key={node.id} {...presentation} selected={selectedId === node.id || Boolean(node.selected)} onSelect={select} ref={element => measureElement(node.id, element)} />;
        })}
      </div>)}
    </div>
  </div>;
}
