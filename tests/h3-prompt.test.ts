import test from 'node:test';
import assert from 'node:assert/strict';
import { applyRefPrefill, nextShot, promptStructure, refPrefill } from '../src/lib/h3Prompt.ts';

test('Director prompt structure per mode and the next [Shot N]', () => {
  assert.equal(promptStructure('T2VA'), 'integrated_multimodal_description: \n\noverall_soundscape: \n\nnon_diegetic_music: N/A');
  assert.match(promptStructure('I2VA'), /^For the target video, at 0\.00 seconds .*<Picture 1>.*\n\nintegrated_multimodal_description: /);
  assert.match(promptStructure('L2VA'), /aligns with the end mark/);
  assert.equal(promptStructure('REF2VA'), 'subject_definitions:\n\n\nsummary:\n\n\nretention_analysis:\n\n\ndetailed_description:\n\n\noverall_soundscape:\n\n\nnon_diegetic_music:\nN/A');
  assert.equal(nextShot(''), '[Shot 1] ');
  assert.equal(nextShot('[Shot 1] a\n[Shot 3] At 00:02 b'), '[Shot 4] ');
});

test('prefill numbers labels like the node (video sound before audio files, RefMods last) and fills only empty sections', () => {
  const fields = refPrefill([
    { type: 'image', slot: 0 },
    { type: 'video', slot: 0, mediaMode: 'video_audio' },
    { type: 'audio', slot: 1 },
  ], [{ slot: 1, kinds: ['image'], description: '  the  hero ' }])!;
  assert.equal(fields.subject_definitions, [
    '<Picture 1> is an image reference for the target video (image slot 1).',
    '<Video 1> is a video reference for the target video (video slot 1).',
    '<Audio 1> is the synchronized audio from the referenced video (audio slot 1).',
    '<Audio 2> is an audio reference for the target video (audio slot 2).',
    '<Picture 2> is a saved image reference (RefMod 1) User description: the hero.',
  ].join('\n'));
  assert.match(fields.summary, /^\[reference generation \+ audio reference\] The target video uses <Picture 1> for visual guidance, <Video 1> for visual motion and timing guidance, <Audio 1> for audio guidance/);
  assert.equal(refPrefill([], []), null);
  // A user description joins its own line; a picture-and-sound video's audio line carries none (as in the Director).
  assert.equal(refPrefill([{ type: 'video', slot: 0, mediaMode: 'video_audio', description: 'the walk' }], [])!.subject_definitions,
    '<Video 1> is a video reference for the target video (video slot 1) User description: the walk.\n<Audio 1> is the synchronized audio from the referenced video (audio slot 1).');
  // Free text becomes the detailed description; an authored section is kept, empty ones are filled.
  const fresh = applyRefPrefill('a duel at dawn', fields);
  assert.match(fresh, /^subject_definitions:\n<Picture 1>/);
  assert.match(fresh, /detailed_description:\na duel at dawn\n\noverall_soundscape:\n\n\nnon_diegetic_music:\nN\/A$/);
  const kept = applyRefPrefill('subject_definitions:\nmine\n\nsummary:\n', fields);
  assert.match(kept, /^subject_definitions:\nmine\n\nsummary:\n\[reference generation/);
  assert.match(kept, /non_diegetic_music:\nN\/A$/);
});
