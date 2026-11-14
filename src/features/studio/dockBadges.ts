import { defaultOptions, type OptionsPref } from './OptionsPanel';
import type { TvePref } from './TvePostControls';
import { defaultWildcard, type WildcardRules } from '../../lib/wildcard';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Options fields that differ from their defaults (absent fields from older saves count as default). */
export function changedOptions(pref: OptionsPref): string[] {
  return (Object.keys(defaultOptions) as (keyof OptionsPref)[]).filter(k => pref[k] !== undefined && !same(pref[k], defaultOptions[k]));
}

/** Wildcards: the switch plus authored rules; seed, rerolls and picked values change on their own and are not "settings". */
export function activeWildcards(enabled: boolean, rules: WildcardRules): string[] {
  const authored = (['style', 'token_budget', 'auto_reroll', 'variables_json'] as const).filter(k => !same(rules[k], defaultWildcard[k]));
  return enabled ? ['enabled', ...authored] : [];
}

export type PostCategoryId = 'audio' | 'latent' | 'regenerate' | 'face-analysis' | 'sam' | 'refine' | 'model' | 'derope' | 'tve';

export const postCategoryOrder: readonly PostCategoryId[] = [
  'audio',
  'latent',
  'regenerate',
  'face-analysis',
  'sam',
  'refine',
  'model',
  'derope',
  'tve',
];

export interface PostBadgeInput {
  video: boolean;
  audio: boolean;
  latent: boolean;
  tve: TvePref;
  refine: boolean;
  sam: boolean;
  audioMode: string;
  music?: boolean;
  h3Video?: boolean;
  h3Image?: boolean;
  moss?: boolean;
  latentSpikeGuard?: boolean;
  regenerate?: boolean;
  regenerateTilingOff?: boolean;
  samVideoCuts?: boolean;
  faceRefine?: boolean;
  faceRefinePrimaryOnly?: boolean;
  refineTiled?: boolean;
  derope?: boolean;
  deropeKeepBackground?: boolean;
  deropeDistilled?: boolean;
}

/** Active post-processing functions per category for the current pipeline. */
export function postCategoryFunctions(p: PostBadgeInput): Record<PostCategoryId, string[]> {
  const h3Video = p.video && (p.h3Video ?? true);
  const imageEligible = !p.video && !p.music;
  const refineEligible = imageEligible && !p.h3Image && !p.moss;
  return {
    audio: p.audio && p.audioMode !== 'off' ? ['audio'] : [],
    latent: p.video && p.latent ? ['latent', ...(p.latentSpikeGuard ? ['latent.spikeGuard'] : [])] : [],
    regenerate: h3Video && p.regenerate ? ['regenerate', ...(p.regenerateTilingOff ? ['regenerate.tilingOff'] : [])] : [],
    'face-analysis': h3Video && p.faceRefine ? ['faceRefine', ...(p.samVideoCuts ? ['faceAnalysis.cuts'] : []), ...(p.faceRefinePrimaryOnly ? ['faceRefine.primaryOnly'] : [])] : [],
    sam: imageEligible && p.sam ? ['sam'] : [],
    refine: refineEligible && p.refine ? ['refine', ...(p.refineTiled ? ['refine.tiled'] : [])] : [],
    model: p.video && p.tve.upscaleModel ? ['upscale'] : [],
    derope: h3Video && p.derope ? [
      'derope',
      ...(p.deropeKeepBackground ? ['derope.keepBackground'] : []),
      ...(p.deropeDistilled ? ['derope.distilled'] : []),
    ] : [],
    tve: p.video ? [
      ...(p.tve.loop ? ['loop'] : []),
      ...(['denoise', 'deblur', 'rtxUpscale', 'frameGen'] as const).filter(k => p.tve[k]),
    ] : [],
  };
}

