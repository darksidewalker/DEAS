export interface NeuralIncludedFeature {
  id: string;
  label: string;
}

/** Passive, caller-translated parts of a parent capability, never choices. */
export function NeuralIncludedFeatures({ included }: { included?: NeuralIncludedFeature[] }) {
  if (!included?.length) return null;
  return <span className="neural-included-features">
    {included.map(feature => <span key={feature.id} className="neural-included-feature" data-included={feature.id} data-included-feature={feature.id}>{feature.label}</span>)}
  </span>;
}
