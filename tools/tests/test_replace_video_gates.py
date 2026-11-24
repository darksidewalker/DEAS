"""UX-22c0: Replace-for-videos candidate intents, input staging and metrics, without a backend or GPU."""
import importlib.util
import shutil
import subprocess
import tempfile
import types
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'deas_gpu_acceptance_session', Path(__file__).resolve().parents[1] / 'gpu_acceptance_session.py')
session = importlib.util.module_from_spec(spec)
spec.loader.exec_module(session)

MEDIA = shutil.which('ffmpeg') and shutil.which('ffprobe') and session._HAS_NUMPY_PIL


class CandidateIntents(unittest.TestCase):
    def test_three_candidates_share_seed_canvas_and_the_replaced_frame(self):
        a, b, c = (session.replace_candidate(k) for k in 'ABC')
        for i in (a, b, c):
            self.assertEqual((i['width'], i['height']), session.REPLACE_SIZE)
            self.assertEqual(i['seed'], 1234)
            self.assertEqual(i['frameRate'], 24)
        self.assertEqual(a['h3']['mode'], 'I2VA')
        self.assertEqual(a['h3']['references'], [{'slot': 0, 'image': session.REPLACE_FRAME}])
        self.assertNotIn('media', a['h3'])
        self.assertEqual(b['h3']['mode'], 'REF2VA')
        self.assertEqual([m['type'] for m in b['h3']['media']], ['image', 'video'])
        self.assertEqual(b['h3']['media'][1]['file'], session.REPLACE_SOURCE)
        self.assertEqual(b['h3']['media'][1]['mediaMode'], 'video_audio')
        self.assertEqual((c['family'], c['frames']), ('ltx-2', 121))
        self.assertEqual((c['sourceVideo'], c['firstFrame']), (session.REPLACE_SOURCE, session.REPLACE_FRAME))
        self.assertEqual(c['ltx']['sourceStrength'], session.REPLACE_SOURCE_STRENGTH)
        # Core LoadVideo lists top-level input files only; H3 media needs the deas-input- prefix.
        self.assertNotIn('/', session.REPLACE_SOURCE)
        self.assertTrue(session.REPLACE_SOURCE.startswith('deas-input-'))

    def test_gates_are_draft_and_marked_as_replace_gates(self):
        gates = [g for g in session.GATES if g['item'] == 'UX-22c']
        self.assertEqual([g['name'] for g in gates], ['UX-22c-A-h3-i2va', 'UX-22c-B-h3-ref2va', 'UX-22c-C-ltx-v2v'])
        self.assertTrue(all(g['draft'] and g['replace'] for g in gates))


@unittest.skipUnless(MEDIA, 'needs ffmpeg, ffprobe, numpy and PIL')
class StagingAndMetrics(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='deas-replace-test-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.clip = self.tmp / 'phone.mp4'
        # 16:9 animated source with sound, deliberately not the 832x480 canvas.
        subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6',
                        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6', '-shortest', '-pix_fmt', 'yuv420p',
                        str(self.clip)], check=True)
        (self.tmp / 'scratch' / 'input' / 'deas-inputs').mkdir(parents=True)

    def args(self, **over):
        base = dict(replace_clip=str(self.clip), replace_frame=None, replace_mask=None)
        return types.SimpleNamespace(**{**base, **over})

    def test_without_a_replaced_frame_it_writes_the_first_frame_and_stops(self):
        ctx = session.stage_replace(self.args(), self.tmp / 'scratch', self.tmp, [], True)
        self.assertEqual(ctx, {'stop': True})
        staged = session.ffprobe(self.tmp / 'scratch' / 'input' / session.REPLACE_SOURCE)
        self.assertEqual((staged['width'], staged['height']), session.REPLACE_SIZE)
        self.assertAlmostEqual(staged['fps'], 24, places=2)
        self.assertTrue(staged['audio'])
        from PIL import Image
        with Image.open(self.tmp / 'replace-source-first-frame.png') as im:
            self.assertEqual(im.size, session.REPLACE_SIZE)

    def test_not_wanted_or_no_clip_stages_nothing(self):
        self.assertEqual(session.stage_replace(self.args(), self.tmp / 'scratch', self.tmp, [], False), {})
        self.assertEqual(session.stage_replace(self.args(replace_clip=None), self.tmp / 'scratch', self.tmp, [], True), {})

    def test_metrics_on_an_unchanged_clip_keep_the_scene_and_the_motion(self):
        session.stage_replace(self.args(), self.tmp / 'scratch', self.tmp, [], True)
        from PIL import Image, ImageDraw
        frame = self.tmp / 'replace-source-first-frame.png'
        mask = self.tmp / 'mask.png'
        m = Image.new('L', session.REPLACE_SIZE, 0)
        ImageDraw.Draw(m).rectangle((300, 150, 500, 330), fill=255)
        m.save(mask)
        ctx = session.stage_replace(self.args(replace_frame=str(frame), replace_mask=str(mask)),
                                    self.tmp / 'scratch', self.tmp, [], True)
        self.assertEqual(set(ctx), {'replace_source', 'replace_frame', 'replace_mask'})
        # The "output" is the staged source itself: every replace metric must read as kept.
        checks = {label: (actual, ok) for label, _, actual, ok in
                  session._checks_replace([ctx['replace_source']], ctx, 124)}
        outside = next(v for k, v in checks.items() if k.startswith('untouched area kept'))
        start = next(v for k, v in checks.items() if k.startswith('replacement present at the start'))
        motion = next(v for k, v in checks.items() if k.startswith('motion follows the source'))
        self.assertTrue(outside[1], outside)
        self.assertTrue(start[1], start)
        self.assertTrue(motion[1], motion)

    def test_masked_psnr_ignores_pixels_outside_the_selection(self):
        np = session.np
        a, b = np.zeros((4, 4, 3)), np.zeros((4, 4, 3))
        b[0, 0] = 255
        keep = np.ones((4, 4), dtype=bool)
        keep[0, 0] = False
        self.assertEqual(session._masked_psnr(a, b, keep), 99.0)
        self.assertIsNone(session._masked_psnr(a, b, np.zeros((4, 4), dtype=bool)))


if __name__ == '__main__':
    unittest.main()
