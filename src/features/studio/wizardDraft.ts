import type { MediaItem } from '../../lib/media';
import type { WizardHandoff, WizardPicture } from '../../lib/wizards';
import type { VideoRef } from './ReferencesPanel';
import { isMaskBlur, isUnit } from './studioGuards';

/**
 * What a Dark Wizards hand-over changes in Generate's draft, as data. Workbench applies it with its own setters; every branch of the
 * hand-over (reference edit, masked/plain edit, Replace video step, Movie Maker shot) lives here so it can be tested without React.
 * `undefined` means "leave as it is". Image drafts and video drafts clear the other kind's inputs.
 */
export interface WizardDraft {
  /** Picture(s) used as prompt references (image pipelines). */
  imageRefs: { item: MediaItem; strength: number }[];
  /** The picture to edit / first frame, or null for none. */
  media: MediaItem | null;
  /** The wizard's own file when it is not in a ComfyUI folder (uploaded when Run starts), else null. */
  wizardPicture: { path: string; name: string } | null;
  /** Video drafts: multi-reference slots (REF2VA) and the clip kept as a guide; both are reset for every video hand-over. */
  video?: { refs: VideoRef[]; sourceVideo: MediaItem | null; sourceStrength?: number };
  seconds?: number;
  edit?: 'resample' | 'inpaint';
  denoise?: { inpaint: boolean; value: number };
  maskBlur?: number;
}
const asImage = (p: WizardPicture): MediaItem => ({ name: p.name, path: p.path, src: p.src, media: 'image' });
/**
 * Pure translation of a hand-over. `comfyName` tells whether a picture already sits in a ComfyUI folder. Returns `null` when a hand-over
 * that needs a picture has none (the caller reports the usual hand-over failure).
 */
export function wizardDraft(wizard: WizardHandoff, comfyName: (item: MediaItem) => unknown, uiKey: () => string = () => crypto.randomUUID()): WizardDraft | null {
  const wp = wizard.picture;
  if (wizard.source !== 'movie' && !wp) return null;
  const picture: MediaItem = wp ? asImage(wp) : { name: '', src: '', media: 'image' };
  const references = (wizard.references ?? []).map(r => ({ item: asImage(r), strength: 0.6 }));
  const seconds = wizard.seconds !== undefined && wizard.seconds > 0 ? { seconds: wizard.seconds } : {};
  if (wizard.source === 'movie') {
    // A Movie Maker shot: text only (t2v) or the cast pictures as REF2VA references (ref2v) — no first frame, no source video.
    const refs: VideoRef[] = (wizard.pipeline === 'ref2v' ? wizard.references ?? [] : []).map((r, i) => ({
      item: asImage(r), second: 0, strength: 1, mediaMode: 'video' as const, uiKey: uiKey(),
      ...(wizard.labels?.[i] ? { label: wizard.labels[i] } : {}), ...(wizard.notes?.[i] ? { description: wizard.notes[i] } : {}),
    }));
    return { imageRefs: [], media: null, wizardPicture: null, video: { refs, sourceVideo: null }, ...seconds };
  }
  if (wizard.source === 'reference') return { imageRefs: [{ item: picture, strength: 0.6 }, ...references], media: null, wizardPicture: null };
  if (wizard.source === 'video') {
    // Video step of a Replace: the edited first frame is the first frame; LTX video-to-video also keeps the clip as its guide.
    const sv = wizard.sourceVideo;
    return { imageRefs: [], media: picture, wizardPicture: null, ...seconds,
      video: { refs: [], sourceVideo: sv ? { name: sv.name, path: sv.path, src: sv.src, media: 'video' } : null, ...(wizard.sourceStrength !== undefined && isUnit(wizard.sourceStrength) ? { sourceStrength: wizard.sourceStrength } : {}) } };
  }
  return { imageRefs: references, media: picture, wizardPicture: comfyName(picture) ? null : { path: picture.path ?? '', name: picture.name },
    ...(wizard.edit ? { edit: wizard.edit } : {}),
    ...(wizard.denoise !== undefined ? { denoise: { inpaint: wizard.edit === 'inpaint', value: wizard.denoise } } : {}),
    ...(wizard.maskBlur !== undefined && isMaskBlur(wizard.maskBlur) ? { maskBlur: wizard.maskBlur } : {}) };
}
