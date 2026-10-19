// MiniMax H3 Director prompt helpers, ported from the DaSiWa node pack (`js/minimax_h3_director.js`:
// `builderPromptForWidget(DEFAULT_BUILDER_STATE(mode))`, `refPrefill`, `applyRefPrefill`). Prompt text stays English: it is model input.

const REF_KEYS = ['subject_definitions', 'summary', 'retention_analysis', 'detailed_description', 'overall_soundscape', 'non_diegetic_music'] as const;

/** The Director's empty prompt structure for a mode (its "Insert Prompt Structure"). */
export function promptStructure(mode: string): string {
  if (mode === 'REF2VA') return REF_KEYS.map(k => `${k}:\n${k === 'non_diegetic_music' ? 'N/A' : ''}`).join('\n\n');
  const head = mode === 'I2VA' ? 'For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.'
    : mode === 'FL2VA' ? 'How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 2) aligns with the end mark of the target video.'
    : mode === 'L2VA' ? 'How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the end mark of the target video.' : '';
  const body = 'integrated_multimodal_description: \n\noverall_soundscape: \n\nnon_diegetic_music: N/A';
  return head ? `${head}\n\n${body}` : body;
}

/** The next `[Shot N] ` marker: one past the highest shot number already in the text. */
export const nextShot = (text: string) => `[Shot ${Math.max(0, ...[...text.matchAll(/\[Shot\s+(\d+)\]/gi)].map(m => Number(m[1]))) + 1}] `;

/** One timeline reference as the Director's prefill reads it, in node order (images, video items, audio files; by slot). */
export interface PrefillItem { type: 'image' | 'video' | 'audio'; slot: number; mediaMode?: 'video' | 'audio' | 'video_audio'; audioSlot?: number; /** User description of the reference (the Director's tile `prompt`). */ description?: string }
/** One enabled RefMod row with its library media kinds (Director slot order). */
export interface PrefillRefMod { slot: number; kinds: string[]; description: string }

/** Reference labels, summary and retention lines the Director's "Prefill Labels & Summary" writes; null without references. */
export function refPrefill(items: PrefillItem[], refmods: PrefillRefMod[]): Record<string, string> | null {
  const counts = { image: 0, video: 0, audio: 0 };
  const definitions: string[] = [], retention: string[] = [], roles: string[] = [];
  let visual = false, audio = false;
  const add = (kind: 'image' | 'video' | 'audio', role: string, description: string, source: string) => {
    const label = `<${{ image: 'Picture', video: 'Video', audio: 'Audio' }[kind]} ${++counts[kind]}>`;
    const detail = description.trim().replace(/\s+/g, ' ');
    definitions.push(`${label} ${role} (${source})${detail ? ` User description: ${detail}` : ''}.`);
    if (kind === 'audio') {
      audio = true;
      retention.push(`${label}: reference - use the audio as a reference, without assuming that the signal is copied.`);
      roles.push(`${label} for audio guidance`);
    } else {
      visual = true;
      retention.push(`${label} (${kind === 'video' ? 'visual structure' : 'visual guidance'}): weak_reference - use the reference without assuming that its content is copied or preserved as an exact frame.`);
      roles.push(`${label} for ${kind === 'video' ? 'visual motion and timing guidance' : 'visual guidance'}`);
    }
  };
  for (const item of items) {
    const own = item.description ?? '';
    if (item.type === 'image') add('image', 'is an image reference for the target video', own, `image slot ${item.slot + 1}`);
    else if (item.type === 'video') {
      if (item.mediaMode !== 'audio') add('video', 'is a video reference for the target video', own, `video slot ${item.slot + 1}`);
      if (item.mediaMode === 'audio' || item.mediaMode === 'video_audio')
        add('audio', item.mediaMode === 'video_audio' ? 'is the synchronized audio from the referenced video' : 'is the audio track selected from a video', item.mediaMode === 'audio' ? own : '', `audio slot ${(item.audioSlot ?? item.slot) + 1}`);
    } else add('audio', 'is an audio reference for the target video', own, `audio slot ${item.slot + 1}`);
  }
  // Native H3 numbers RefMods after all timeline media, by kind.
  for (const row of [...refmods].sort((a, b) => a.slot - b.slot))
    for (const kind of row.kinds) if (kind === 'image' || kind === 'video' || kind === 'audio') add(kind, `is a saved ${kind} reference`, row.description, `RefMod ${row.slot}`);
  if (!definitions.length) return null;
  const types = [...(visual ? ['reference generation'] : []), ...(audio ? ['audio reference'] : [])];
  return { subject_definitions: definitions.join('\n'), summary: `[${types.join(' + ')}] The target video uses ${roles.join(', ')}.`, retention_analysis: retention.join('\n') };
}

/** Fills only empty REF2VA sections and adds missing ones; free text without sections becomes the detailed description. */
export function applyRefPrefill(text: string, fields: Record<string, string>): string {
  let result = text.trim();
  if (!/^\s*(subject_definitions|summary|retention_analysis|detailed_description|overall_soundscape|non_diegetic_music):/m.test(result))
    return REF_KEYS.map(k => `${k}:\n${fields[k] || (k === 'detailed_description' ? result : k === 'non_diegetic_music' ? 'N/A' : '')}`).join('\n\n');
  for (const key of REF_KEYS) {
    const pattern = new RegExp(`(^\\s*${key}:)[ \\t]*([^]*?)(?=^\\s*(?:${REF_KEYS.join('|')}):|$(?![^]))`, 'm');
    const match = result.match(pattern);
    if (match) { if (!match[2].trim() && fields[key]) result = result.replace(pattern, `${match[1]}\n${fields[key]}\n\n`); }
    else result += `\n\n${key}:\n${fields[key] || (key === 'non_diegetic_music' ? 'N/A' : '')}`;
  }
  return result;
}
