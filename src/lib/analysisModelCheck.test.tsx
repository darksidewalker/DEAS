import { expect, test } from 'vitest';
import * as analysis from './analysis';

const tagger: analysis.Tagger = { id: 'wd/model.onnx', name: 'WD', model: 'wd/model.onnx', labels: 'wd/tags.csv', place: 'wd', tags: 10, categories: true, generalThreshold: 0.35, characterThreshold: 0.85 };
const overview: analysis.AnalysisOverview = { runtimeReady: true, taggers: [tagger], unusable: [], install: { running: false, stage: '', downloaded: 0, total: 0, error: null }, defaultSize: 0, runtimeSize: 0, toolsSize: 0 };

test('tagger advice distinguishes discovered ONNX/labels from runtime readiness and model loading', () => {
  const check = analysis.checkTagger?.(overview, tagger.id);
  expect(check).toMatchObject({ identity: 'unverified', compatibility: 'unknown', availability: 'available' });
  expect(check?.evidence).toContain('tagger-discovery');
  expect(analysis.checkTagger({ ...overview, runtimeReady: false }, tagger.id).compatibility).toBe('blocked');
  expect(analysis.checkTagger({ ...overview, taggers: [] }, tagger.id).availability).toBe('missing');
});
