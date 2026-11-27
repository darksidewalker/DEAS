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
  video?: { refs: VideoRef[]; sourceVideo: MediaItem | null; sourceStrength?: number; /** Movie Maker scene: its last frame (with no first frame it is a last-frame-only take). */ lastFrame?: MediaItem | null };
  seconds?: number;
  edit?: 'resample' | 'inpaint';
  denoise?: { inpaint: boolean; value: number };
  maskBlur?: number;
  /** Movie Maker music bed: style, lyrics and length for Generate's Music draft. */
  music?: { style: string; lyrics: string; seconds: number; bpm?: number; language?: string };
  /** Movie Maker shot: the LoRAs to switch on (undefined = leave Generate's list as the hand-over reset it, i.e. none). */
  loras?: { name: string; strength: number }[];
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
  if (wizard.source === 'movie' && wizard.pipeline === 't2m') {
    // A Movie Maker music bed: a text-to-music draft; no pictures, clips or references.
    const mu = wizard.music;
    if (!mu) return null;
    // Its LoRAs always replace Generate's list, also when it has none (the user's picture LoRAs never ride a track).
    return { imageRefs: [], media: null, wizardPicture: null, video: { refs: [], sourceVideo: null }, music: { style: mu.style, lyrics: mu.lyrics, seconds: mu.seconds, ...(mu.bpm !== undefined ? { bpm: mu.bpm } : {}), ...(mu.language ? { language: mu.language } : {}) }, loras: (wizard.loras ?? []).map(l => ({ name: l.name, strength: l.strength })) };
  }
  if (wizard.source === 'movie') {
    // A Movie Maker scene: its frames (I2VA/FL2VA), its references with every Director option (REF2VA) or text only (t2v), exactly as
    // the scene editor assigned them; plus, in the music-reference mode, the scene's slice of the track as an audio reference.
    const refs: VideoRef[] = (wizard.pipeline === 'ref2v' ? wizard.videoRefs ?? [] : []).map(({ name, src, path, media, ...r }) => ({ ...r, item: { name, path, src, media }, uiKey: uiKey() }));
    const ar = wizard.audioRef;
    if (ar && wizard.pipeline === 'ref2v') refs.push({ item: { name: ar.name, path: ar.path, src: ar.src, media: 'audio' }, second: 0, strength: 1, mediaMode: 'audio', trimStart: ar.trimStart, trimEnd: ar.trimEnd, uiKey: uiKey() });
    const f = wizard.pipeline === 'ref2v' ? undefined : wizard.frames;
    const sv = wizard.pipeline === 'v2v' ? wizard.sourceVideo : undefined;
    return { imageRefs: [], media: f?.first ? asImage(f.first) : f?.last ? asImage(f.last) : null, wizardPicture: null,
      video: { refs, sourceVideo: sv ? { name: sv.name, path: sv.path, src: sv.src, media: 'video' } : null, lastFrame: f?.last ? asImage(f.last) : null }, ...seconds,
      ...(wizard.loras?.length ? { loras: wizard.loras.map(l => ({ name: l.name, strength: l.strength })) } : {}) };
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
