import test from 'node:test';
import assert from 'node:assert/strict';
import { completeItem, manifestProblem, newMovie, setBrief, setRender, setShotModel, setShotSampling } from '../src/lib/movieManifest.ts';
import { applyPlan, type StoryPlan } from '../src/lib/movieStory.ts';
import { MOVIE_RESOLUTIONS, modelVariant, movieRender, movieSize, renderCanvas, renderSampling, shotSampling, startingSampling } from '../src/lib/movieRender.ts';
import { shotHandoff } from '../src/lib/movieSegments.ts';
import { chainHandoff, chainOf } from '../src/lib/movieChainRun.ts';

const turbo = { name: 'MiniMaxH3/dasiwa_h3_ref2va_turbo.safetensors', path: '/m/turbo' };
const base = { name: 'MiniMaxH3/minimax_h3_ref2va_pruned_bf16.safetensors', path: '/m/base' };
const src = (p: string) => 'asset://' + p;
const plan: StoryPlan = { lore: 'l', segments: [
  { title: 'A', prompt: 'a', seconds: 5, continuous: false, dialogue: [] },
  { title: 'B', prompt: 'b', seconds: 5, continuous: false, dialogue: [] },
  { title: 'C', prompt: 'c', seconds: 5, continuous: true, dialogue: [] },
] };
const film = () => applyPlan(setBrief(newMovie('m1', 'F', 15, '16:9'), { story: 's' }), plan);
const env = { resolveModel: (n: string) => [turbo, base].find(x => x.name === n), hasLora: () => true };

test('starting sampling comes from family data: the base model 30 steps CFG 3, a turbo file (named so) 8 steps CFG 1', () => {
  assert.deepEqual(startingSampling('minimax-h3', base.name), { steps: 30, cfg: 3, sampler: 'res_multistep', scheduler: 'simple' });
  assert.deepEqual(startingSampling('minimax-h3', turbo.name), { steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' });
  assert.deepEqual(modelVariant('minimax-h3', 'h3_lightning_int8.safetensors'), { id: 'turbo', evidence: 'filename' });
  // Whole words only: a name merely containing the letters is not a turbo merge.
  assert.equal(modelVariant('minimax-h3', 'turbocharged_h3.safetensors'), undefined);
  assert.equal(modelVariant('ltx-2', 'turbo.safetensors'), undefined);
  assert.equal(startingSampling('no-such-family', 'x'), undefined);
});

test('the movie\'s Steps/CFG belong to the default model; a scene with another model uses that model\'s values; a scene can set its own', () => {
  let m = setRender(film(), { steps: 10, cfg: 1.5 });
  const shot = (id: string) => m.items.find(i => i.id === id)!;
  assert.deepEqual(shotSampling(m, shot('seg-1'), 'minimax-h3', turbo.name, turbo.name), { steps: 10, cfg: 1.5, sampler: 'res_multistep', scheduler: 'simple' });
  m = setShotModel(m, 'seg-2', base.name);
  assert.deepEqual(shotSampling(m, shot('seg-2'), 'minimax-h3', base.name, turbo.name), { steps: 30, cfg: 3, sampler: 'res_multistep', scheduler: 'simple' });
  m = setShotSampling(m, 'seg-2', { steps: 40 });
  assert.deepEqual([shotSampling(m, shot('seg-2'), 'minimax-h3', base.name, turbo.name)?.steps, shotSampling(m, shot('seg-2'), 'minimax-h3', base.name, turbo.name)?.cfg], [40, 3]);
  // Clearing the movie values returns to the default model's own starting values.
  m = setRender(m, { steps: undefined, cfg: undefined });
  assert.deepEqual(shotSampling(m, shot('seg-1'), 'minimax-h3', turbo.name, turbo.name)?.steps, 8);
});

test('canvas: the movie\'s resolution choice on its aspect, exactly as Generate computes it; Generate\'s own settings hand over only the aspect', () => {
  const m = film();
  assert.deepEqual(movieRender(m), { source: 'movie', resolution: 'model' });
  assert.deepEqual(renderCanvas(m, 'minimax-h3'), { size: { width: 1152, height: 672 } });
  assert.deepEqual(renderCanvas(setRender(m, { resolution: '720p' }), 'minimax-h3'), { size: { width: 1248, height: 736 } });
  assert.deepEqual(movieSize('9:16', '1080p', 'minimax-h3'), { width: 1088, height: 1888 });
  assert.deepEqual(renderCanvas(setBrief(setRender(m, { resolution: '720p' }), { aspect: 'auto' }), 'minimax-h3'), { aspect: 'auto', resolution: '720p' });
  assert.deepEqual(renderCanvas(setRender(m, { source: 'generate', resolution: '720p' }), 'minimax-h3'), { aspect: '16:9' });
  assert.deepEqual(renderSampling(setRender(m, { source: 'generate' }), undefined, 'minimax-h3', turbo.name, turbo.name), {});
  // Every offered choice gives a canvas on H3's 32-px grid.
  for (const r of MOVIE_RESOLUTIONS) { const s = movieSize('16:9', r, 'minimax-h3'); assert.ok(!s || (s.width % 32 === 0 && s.height % 32 === 0), r); }
  assert.equal(movieSize('16:9', 'fixed', 'minimax-h3'), undefined);
});

test('shot and chain hand-overs carry the canvas and the sampling of the model they are made with', () => {
  let m = setShotModel(film(), 'seg-2', base.name);
  const one = shotHandoff(m, 'seg-1', turbo, true, src, env);
  assert.ok('handoff' in one);
  if ('handoff' in one) assert.deepEqual([one.handoff.size, one.handoff.sampling], [{ width: 1152, height: 672 }, { steps: 8, cfg: 1, sampler: 'res_multistep', scheduler: 'simple' }]);
  const found = chainOf(m, 'seg-2')!;
  const chain = chainHandoff(m, found.chain, found.index, turbo, true, src, env);
  assert.ok('handoff' in chain);
  if ('handoff' in chain) assert.deepEqual([chain.handoff.model.name, chain.handoff.sampling?.steps, chain.handoff.sampling?.cfg], [base.name, 30, 3]);
  m = setRender(m, { source: 'generate' });
  const plain = shotHandoff(m, 'seg-1', turbo, true, src, env);
  assert.ok('handoff' in plain && plain.handoff.sampling === undefined && plain.handoff.size === undefined && plain.handoff.aspect === '16:9');
});

test('render settings and shot sampling are validated, clamped, and a shot\'s own values make a made shot outdated', () => {
  let m = setRender(film(), { steps: 400, cfg: -2, model: turbo.name, resolution: '720p' });
  assert.deepEqual(m.render, { source: 'movie', steps: 150, cfg: 0, model: turbo.name, resolution: '720p' });
  assert.equal(manifestProblem(m), undefined);
  m = completeItem(m, 'seg-1', { outputId: '/o/a.mp4' });
  m = setShotSampling(m, 'seg-1', { steps: 12.6, cfg: 2 });
  const s = m.items.find(i => i.id === 'seg-1')!;
  assert.deepEqual([s.sampling, s.state], [{ steps: 13, cfg: 2 }, 'planned']);
  assert.equal(setShotSampling(m, 'seg-1', {}).items.find(i => i.id === 'seg-1')!.sampling, undefined);
  assert.throws(() => setShotSampling(m, 'brief', { steps: 1 }), /Unknown shot/);
  assert.equal(manifestProblem({ ...m, render: { source: 'studio' } as never }), 'bad render settings');
  assert.equal(manifestProblem({ ...m, render: { source: 'movie', steps: 1.5 } }), 'bad render settings');
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'brief' ? { ...i, sampling: { steps: 4 } } : i) })!, /bad shot sampling/);
  assert.match(manifestProblem({ ...m, items: m.items.map(i => i.id === 'seg-1' ? { ...i, sampling: { sampler: 'euler' } as never } : i) })!, /bad shot sampling/);
});
