// Export what DEAS's native Prompt Forge needs for the image models, composed
// by PromptForge's own loaders so the text is byte-for-byte what PromptForge
// sends. Read-only: nothing in the PromptForge checkout is written.
//
//   node tools/export-forge-pack.mjs /path/to/PromptForge > forge-data/forge-pack.json
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(process.argv[2] ?? '.');
const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { loadConfig } = await load('server/config.mjs');
const { loadRegistry } = await load('server/registry.mjs');
const { createPromptStore } = await load('server/prompts.mjs');
const { createGuidance } = await load('server/guidance.mjs');
const { createToolbox } = await load('server/tools.mjs');

const quiet = () => {};
const { config } = loadConfig(ROOT, 'server');
const registry = loadRegistry(ROOT, {});
const prompts = createPromptStore(ROOT, config, registry, { warn: quiet });
const guidance = createGuidance(ROOT, { warn: quiet });
// Definitions only; the search itself runs in DEAS against the same database.
const toolbox = createToolbox({ loaded: true }, {
  limit: config.tools?.result_limit ?? 15,
  maxQueries: config.tools?.max_queries_per_call ?? 24,
});

const KEYS = ['illustrious', 'anima', 'krea2', 'moss'];
const models = {};
for (const key of KEYS) {
  const m = registry.get(key);
  const entry = JSON.parse(JSON.stringify(m));
  delete entry.render;
  const modes = Array.isArray(m.modes) ? m.modes : [];
  models[key] = {
    entry,
    system: prompts.get(key),
    system_by_mode: Object.fromEntries(modes.map((mode) => [mode, prompts.get(key, mode)])),
    segment_blocks: Object.fromEntries(
      Object.keys(m.segment_blocks ?? {}).map((label) => [label, prompts.segmentTail({ ...m, meta_segments: [] }, [label]).split('\n\n---\n\n').slice(1).join('\n\n---\n\n')])
    ),
    guidance_tool: guidance.definitions(m),
    guidance_docs: Object.fromEntries(
      guidance.keysFor(m).map((k) => [k, guidance.run(m, JSON.stringify({ name: k })).content])
    ),
    search_tool: toolbox.definitions({ variant: m.tag_style ?? 'underscore' }),
    // The Layout Studio's Rewrite instruction (MOSS), as /api/moss/assist reads it.
    layout_rewrite: m.layout_rewrite_prompt ? readFileSync(path.join(ROOT, m.layout_rewrite_prompt), 'utf8') : null,
  };
}

// The shared text segmentTail puts in front of the first explaining segment.
const metaProbe = prompts.segmentTail({ key: '__probe__', meta_segments: ['X'] }, ['X']);
const metaSegment = metaProbe.split('\n\n---\n\n').slice(1).join('\n\n---\n\n');

const commit = execFileSync('git', ['-C', ROOT, 'log', '-1', '--format=%h'], { encoding: 'utf8' }).trim();
const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

process.stdout.write(JSON.stringify({
  source: { project: 'PromptForge', commit, exported_at: new Date().toISOString() },
  config: {
    tools: config.tools ?? {},
    negative: config.negative ?? {},
    characters: config.characters ?? {},
    lexicon: config.lexicon ?? {},
  },
  // The creativity slider's notches, in order (JSON object order does not survive every reader).
  creativity_order: Object.keys(registry.defaults?.creativity_presets ?? {}),
  defaults: pick(registry.defaults ?? {}, [
    'creativity_presets', 'default_creativity', 'detail_levels', 'default_detail', 'lighting_rule', 'lighting_levels',
    'default_lighting', 'image_aspect_ratios', 'optional_segments_default', 'camera_angles', 'camera_shots', 'camera_lights',
    'image_reference_roles', 'reference_fidelity', 'default_image_reference_role', 'default_reference_fidelity', 'max_image_references',
  ]),
  shared: {
    meta_segment: metaSegment,
    tag_search: prompts.tagSearch(),
    guidance: prompts.guidance(),
    second_pass: prompts.secondPass(),
    // Reference pictures: the reading pass before a write, and Analyze's read-back.
    reference_blueprint: prompts.referenceBlueprint(),
    reference_analysis: prompts.referenceAnalysis(),
  },
  models,
}, null, 1));
