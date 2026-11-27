#!/usr/bin/env python3
"""Movie Maker GPU session (UX-22d acceptance): one throwaway backend, five gates, measured numbers.

    python3 tools/movie_gpu_session.py --precheck   # compile every intent offline, no GPU
    python3 tools/movie_gpu_session.py --run        # the session (needs a free GPU and the owner's go-ahead)

Gates, in dependency order, each a real run of the intents Movie Maker's hand-overs compile to:
  M-1 first take        H3 T2VA, 124 frames, continuity capture in `segment` output mode
  M-2 continued shot    H3 T2VA continuation of M-1's clip (segment mode): does the file hold only the new footage?
  M-3 music bed         ACE-Step 1.5 Turbo, instrumental, 12 s
  M-4 join              the two shot files through the `h3-join` files recipe (what the Film step runs)
  M-5 music mix         the real `movie_mix::mix` (a temporary ignored Rust test) on M-4's film and M-3's track:
                        ducked and un-ducked, with the music's contribution measured in loud and quiet film windows
It reuses the helpers of gpu_acceptance_session.py (idle-GPU refusal, free port, throwaway backend, marker compile test),
touches only scratch folders and never stops anything that is not its own backend. Output:
artifacts/verification/movie-gpu-<UTC>/{session.log,results.json,summary.md}. A PASS is a measurement on this host, not native/Windows acceptance
and not a listening verdict: the mixes it writes are for the owner's ears.
"""
import argparse
import datetime as dt
import importlib.util
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('gas', HERE / 'gpu_acceptance_session.py')
gas = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(gas)
import numpy as np  # noqa: E402

SESSION = 'mm-gpu-' + dt.datetime.now(dt.timezone.utc).strftime('%H%M%S')
ACE_CKPT = 'Ace/ace_step_1.5_turbo_aio.safetensors'
MIX_MARK = '// DEAS-MOVIE-GPU-TMP-TEST'
PROMPT1 = 'a woman in a red coat walks down a rainy street at dusk and says: "We have to go now."'
PROMPT2 = 'she stops at a corner, looks back over her shoulder and answers quietly: "Wait for me."'


def h3_take(frames, continuity, prompt, seed):
    base = gas.h3_base()
    base.update({'positivePrompt': prompt, 'seed': seed, 'frames': frames, 'outputPrefix': 'video/movie/' + continuity['session'],
                 'h3': {'mode': 'T2VA', 'audioVae': gas.H3_AUDIO_VAE, 'shiftVideo': 10, 'shiftAudio': 3, 'references': [], 'continuity': continuity}})
    base['output'] = {**base['output'], 'saveFirstFrame': False}
    return base


def intent_first():
    return h3_take(124, {'session': SESSION, 'sourceId': '', 'capture': True, 'action': '', 'outputMode': 'segment'}, PROMPT1, 4711)


def intent_next(clip_id):
    return h3_take(107, {'session': SESSION, 'sourceId': clip_id, 'capture': True, 'action': PROMPT2, 'outputMode': 'segment', 'overlapFrames': 22}, PROMPT2, 4712)


def intent_music():
    return {'recipeId': 'music-generation', 'version': 1, 'family': 'ace-step-1-5-turbo', 'checkpoint': ACE_CKPT, 'mode': 't2m', 'planning': 'off',
            'style': 'calm cinematic piano and strings, slow, warm, instrumental, no vocals', 'lyrics': '', 'seed': 99, 'maxDuration': 12,
            'steps': 8, 'cfg': 1, 'sampler': 'euler', 'scheduler': 'simple', 'outputPrefix': 'audio/movie/bed',
            'ace': {'shift': 3, 'lyricsStrength': 1, 'bpm': 120, 'timeSignature': '4', 'language': 'en', 'keyScale': 'C major', 'generateAudioCodes': True,
                    'lmCfg': 2, 'temperature': 0.85, 'topP': 0.9, 'topK': 0, 'minP': 0}}


def intent_audio_ref(trim_start=2.0, trim_end=7.0):
    """A REF2VA shot with a picture reference and a slice of the music track as audio reference (the H3-reference mode of UX-22d5d1)."""
    base = gas.h3_base()
    base.update({'positivePrompt': PROMPT1, 'seed': 4713, 'frames': 124, 'outputPrefix': 'video/movie/audioref'})
    base['h3'] = {'mode': 'REF2VA', 'audioVae': gas.H3_AUDIO_VAE, 'shiftVideo': 10, 'shiftAudio': 3, 'references': [],
                  'media': [{'type': 'image', 'file': gas.PROBE_IMAGE, 'slot': 0}, {'type': 'audio', 'file': 'deas-inputs/movie-bed.flac', 'slot': 0, 'trimStart': trim_start, 'trimEnd': trim_end}]}
    return base


def intent_join(names):
    return {'recipeId': 'h3-join', 'version': 1, 'h3': {'join': {'kind': 'files', 'files': [{'filename': n} for n in names], 'smoothAudioSeams': True}}}


def install_mix_test():
    path = gas.SRC_TAURI / 'src' / 'movie_mix_tests.rs'
    orig = path.read_text(encoding='utf-8')
    body = f'''
{MIX_MARK}
#[ignore]
#[test]
fn print_real_mix() {{
    let env = |k: &str| std::env::var(k).unwrap();
    let num = |k: &str| env(k).parse::<f64>().unwrap();
    let req = MixRequest {{ film: env("DEAS_MIX_FILM"), music: env("DEAS_MIX_MUSIC"), level_db: num("DEAS_MIX_LEVEL"), duck_db: num("DEAS_MIX_DUCK"), fade_seconds: num("DEAS_MIX_FADE") }};
    let r = mix(&req, &AtomicBool::new(false)).expect("mix");
    println!("MIX_RESULT {{}}", serde_json::to_string(&r).unwrap());
}}
'''
    if 'print_real_mix' not in orig:
        path.write_text(orig + body, encoding='utf-8')
    return path, orig


def real_mix(film, music, level, duck, fade):
    env = {**os.environ, 'DEAS_MIX_FILM': str(film), 'DEAS_MIX_MUSIC': str(music), 'DEAS_MIX_LEVEL': str(level), 'DEAS_MIX_DUCK': str(duck), 'DEAS_MIX_FADE': str(fade)}
    out = gas.sh(['cargo', 'test', '--lib', 'print_real_mix', '--', '--ignored', '--nocapture'], cwd=gas.SRC_TAURI, env=env)
    for line in out.stdout.splitlines():
        if line.startswith('MIX_RESULT '):
            return json.loads(line[len('MIX_RESULT '):])
    raise RuntimeError('mix failed: ' + ' | '.join((out.stdout + out.stderr).strip().splitlines()[-4:]))


def pcm(path, rate=16000):
    out = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(path), '-vn', '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-'], capture_output=True)
    return np.frombuffer(out.stdout, dtype=np.float32)


def window_rms(x, rate=16000, win=0.25):
    n = int(rate * win)
    return np.array([float(np.sqrt(np.mean(x[i:i + n] ** 2))) for i in range(0, max(len(x) - n, 1), n)])


def music_contribution(film, mixed):
    """Per 0.25 s window: the part of the mix that is not the film's own sound (uncorrelated-power estimate)."""
    f, m = window_rms(pcm(film)), window_rms(pcm(mixed))
    n = min(len(f), len(m))
    f, m = f[:n], m[:n]
    return f, np.sqrt(np.maximum(m ** 2 - f ** 2, 0.0))


def frame_psnr(a_path, b_path, tmp):
    from PIL import Image
    first, last = tmp / 'first.png', tmp / 'last.png'
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-i', str(b_path), '-frames:v', '1', str(first)], check=True)
    subprocess.run(['ffmpeg', '-v', 'error', '-y', '-sseof', '-0.2', '-i', str(a_path), '-update', '1', '-frames:v', '1', str(last)], check=True)
    x, y = np.asarray(Image.open(last).convert('L'), dtype=np.float64), np.asarray(Image.open(first).convert('L').resize(Image.open(last).size), dtype=np.float64)
    mse = float(np.mean((x - y) ** 2))
    return None if mse == 0 else round(10 * np.log10(255 ** 2 / mse), 2)


class Peak(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.max = 0
        self.stop = False

    def run(self):
        while not self.stop:
            s = gas.gpu_state()
            if s:
                self.max = max(self.max, s[1])
            time.sleep(2)


def submit(base, graph, scratch, label, logbuf, timeout=1800):
    t0 = time.time()
    peak = Peak()
    peak.start()
    try:
        reply = gas.http_json(base, '/prompt', {'prompt': graph, 'client_id': 'movie-gpu-session'})
        pid = reply['prompt_id']
        while time.time() - t0 < timeout:
            hist = gas.http_json(base, f'/history/{pid}').get(pid)
            if hist and hist.get('status', {}).get('completed') is not None:
                if hist['status'].get('status_str') == 'error' or not hist['status'].get('completed'):
                    msgs = json.dumps(hist['status'].get('messages', []))[-900:]
                    raise RuntimeError(f'{label} failed: {msgs}')
                files = []
                for node in hist.get('outputs', {}).values():
                    for key in ('videos', 'images', 'audio', 'gifs'):
                        for item in node.get(key, []):
                            p = scratch / 'output' / item.get('subfolder', '') / item['filename']
                            if p.is_file():
                                files.append(p)
                gas.log(logbuf, f'{label}: done in {time.time() - t0:.0f}s, GPU peak {peak.max} MiB, files: {[f.name for f in files]}')
                return files, {'seconds': round(time.time() - t0, 1), 'vram_peak_mib': peak.max}
            time.sleep(5)
        raise RuntimeError(f'{label} timed out after {timeout}s')
    finally:
        peak.stop = True


def newest(files, suffixes):
    c = [f for f in files if f.suffix.lower() in suffixes]
    return c[-1] if c else None


def measure_mix(film, a3, outdir, level=-14.0, duck_db=12.0, fade=2.0):
    """The real movie_mix::mix, ducked and un-ducked, and the music's contribution in loud and quiet film windows."""
    scored = {}
    for label, duck in (('ducked', duck_db), ('plain', 0.0)):
        r = real_mix(film, a3, level, duck, fade)
        keep = outdir / f'scored-{label}.mp4'
        shutil.copy2(r['path'], keep)
        scored[label] = (keep, r)
    f_rms, duck_music = music_contribution(film, scored['ducked'][0])
    _, plain_music = music_contribution(film, scored['plain'][0])
    n = min(len(f_rms), len(duck_music), len(plain_music))
    order = np.argsort(f_rms[:n])
    q = max(n // 4, 1)
    quiet, loud = order[:q], order[-q:]
    def ratio(idx):
        den = float(np.mean(plain_music[idx]))
        return None if den <= 1e-9 else round(float(np.mean(duck_music[idx])) / den, 3)
    film_probe = gas.ffprobe(scored['ducked'][0])
    result = {'ducked_file': str(scored['ducked'][0].name), 'plain_file': str(scored['plain'][0].name), 'probe': film_probe,
                      'mean_db': {'film': gas.media_audio_mean_db(film), 'music': gas.media_audio_mean_db(a3), 'ducked': gas.media_audio_mean_db(scored['ducked'][0]), 'plain': gas.media_audio_mean_db(scored['plain'][0])},
                      'music_level_ratio_ducked_vs_plain': {'loud_film_windows': ratio(loud), 'quiet_film_windows': ratio(quiet)},
                      'video_copied': film_probe.get('vcodec') == gas.ffprobe(film).get('vcodec'), 'duration_matches_film': abs(film_probe['duration'] - gas.ffprobe(film)['duration']) < 0.3}
    lr, qr = result['music_level_ratio_ducked_vs_plain']['loud_film_windows'], result['music_level_ratio_ducked_vs_plain']['quiet_film_windows']
    result['pass'] = bool(result['video_copied'] and result['duration_matches_film'] and lr is not None and qr is not None and lr < 0.85 and qr > lr)

    return result


def chroma(path, start=0.0, length=None, rate=16000):
    """Mean 12-bin chroma vector of an audio file (or a slice of it), L2-normalised — a rough 'same harmony?' fingerprint."""
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start)] + (['-t', str(length)] if length else []) + ['-i', str(path), '-vn', '-ac', '1', '-ar', str(rate), '-f', 'f32le', '-']
    x = np.frombuffer(subprocess.run(cmd, capture_output=True).stdout, dtype=np.float32)
    n = 4096
    win = np.hanning(n)
    freqs = np.fft.rfftfreq(n, 1 / rate)
    ok = (freqs > 55) & (freqs < 2000)
    pc = (np.round(12 * np.log2(freqs[ok] / 440.0)) % 12).astype(int)
    acc = np.zeros(12)
    for i in range(0, max(len(x) - n, 1), n // 2):
        seg = x[i:i + n]
        if len(seg) < n:
            break
        mag = np.abs(np.fft.rfft(seg * win))[ok]
        np.add.at(acc, pc, mag)
    norm = float(np.linalg.norm(acc))
    return acc / norm if norm > 0 else acc


def audio_reference_gate(session_dir, logbuf, outdir):
    """M-6: a REF2VA shot with a picture and a 5 s slice of the session's music track as audio reference, versus the session's un-referenced first take."""
    d = Path(session_dir).resolve()
    bed = next((d / 'scratch/output').rglob('bed*.flac'))
    first = next((d / 'scratch/output/video/movie').glob('mm-gpu-*_00001_audio.mp4'))
    blockers = gas.gpu_blockers(25, 1024, samples=3)
    if blockers:
        raise SystemExit('GPU busy, nothing started: ' + '; '.join(blockers))
    host = gas.host_memory_state()
    reason = gas.headroom_refusal(host, True) if host else None
    if reason:
        raise SystemExit(reason)
    pool = sorted([f for f in (gas.RESOURCES / 'input').rglob('*') if f.is_file() and f.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp') and 300_000 < f.stat().st_size < 20 * 1024 * 1024], key=lambda f: f.stat().st_size, reverse=True)
    if not pool:
        raise SystemExit('no probe picture in the AI-Ressources input folder')
    port = gas.pick_port()
    scratch = outdir / 'scratch'
    for sub in ('input/deas-inputs', 'output', 'temp'):
        (scratch / sub).mkdir(parents=True, exist_ok=True)
    from PIL import Image
    im = Image.open(pool[0]).convert('RGB')
    im.thumbnail((1536, 1536))
    im.save(scratch / 'input/deas-inputs/acceptance-a.png', 'PNG')
    shutil.copy2(bed, scratch / 'input/deas-inputs/movie-bed.flac')
    graph = gas.compile_intent(intent_audio_ref(), logbuf)
    backend = subprocess.Popen([str(gas.VENV_PY), '-u', 'main.py', '--port', str(port), '--listen', '127.0.0.1', '--extra-model-paths-config', str(gas.MODELS_YAML),
                                '--input-directory', str(scratch / 'input'), '--output-directory', str(scratch / 'output'), '--temp-directory', str(scratch / 'temp')],
                               cwd=gas.COMFY, stdout=open(outdir / 'backend.log', 'w'), stderr=subprocess.STDOUT)
    try:
        base = f'http://127.0.0.1:{port}'
        for _ in range(90):
            try:
                gas.http_json(base, '/system_stats')
                break
            except Exception:
                time.sleep(2)
        else:
            raise SystemExit('throwaway backend never became ready')
        gas.log(logbuf, f'throwaway backend ready on :{port}')
        files, meta = submit(base, graph, scratch, 'M-6 audio-reference shot', logbuf)
    finally:
        backend.terminate()
        try:
            backend.wait(20)
        except Exception:  # noqa: BLE001
            backend.kill()
        gas.log(logbuf, 'throwaway backend stopped')
    v = newest(files, {'.mp4', '.webm', '.mkv'})
    ref = chroma(bed, 2.0, 5.0)
    with_ref, without_ref = chroma(v), chroma(first)
    cos = lambda a, b: round(float(np.dot(a, b)), 3)
    res = {**meta, 'file': v.name if v else None, 'probe': gas.ffprobe(v) if v else {}, 'slice': [2.0, 7.0],
           'chroma_similarity_to_slice': {'with_audio_reference': cos(with_ref, ref), 'first_take_without_reference': cos(without_ref, ref)}}
    res['pass'] = bool(v and res['probe'].get('audio'))
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--precheck', action='store_true')
    ap.add_argument('--run', action='store_true')
    ap.add_argument('--audio-ref', metavar='SESSION_DIR', help='run only M-6 (a REF2VA shot with a slice of that session\'s music as audio reference)')
    ap.add_argument('--remix', metavar='SESSION_DIR', help='re-run only M-5 on a finished session\'s film and track (no GPU)')
    ap.add_argument('--max-util', type=int, default=25)
    ap.add_argument('--max-app-mib', type=int, default=1024)
    args = ap.parse_args()
    if args.remix:
        d = Path(args.remix).resolve()
        film = next((d / 'scratch/output').rglob('H3_Joined*.mp4'))
        bed = next((d / 'scratch/output').rglob('bed*.flac'))
        mix_path, mix_orig = install_mix_test()
        try:
            out = d / 'remix'
            out.mkdir(exist_ok=True)
            print(json.dumps(measure_mix(film, bed, out), indent=1, default=str))
        finally:
            mix_path.write_text(mix_orig, encoding='utf-8')
        return
    if args.audio_ref:
        stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
        out = gas.OUT_ROOT / f'movie-gpu-audioref-{stamp}'
        out.mkdir(parents=True, exist_ok=True)
        logbuf = []
        marker_path, marker_orig = gas.install_marker_test()
        try:
            result = audio_reference_gate(args.audio_ref, logbuf, out)
        finally:
            gas.remove_marker_test(marker_path, marker_orig)
            (out / 'session.log').write_text('\n'.join(logbuf), encoding='utf-8')
        (out / 'results.json').write_text(json.dumps({'M-6': result}, indent=1, default=str), encoding='utf-8')
        print(json.dumps(result, indent=1, default=str))
        print(f'artifacts: {out}')
        return
    if not (args.precheck or args.run):
        ap.error('--precheck, --run, --remix or --audio-ref')
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    outdir = gas.OUT_ROOT / f'movie-gpu-{stamp}'
    outdir.mkdir(parents=True, exist_ok=True)
    logbuf, results = [], {}
    marker_path, marker_orig = gas.install_marker_test()
    mix_path, mix_orig = install_mix_test()
    backend = None
    try:
        gas.log(logbuf, f'session {SESSION}; compiling the intents with the current Rust compiler')
        graphs = {'M-1': gas.compile_intent(intent_first(), logbuf), 'M-2': gas.compile_intent(intent_next('PLACEHOLDERCLIP'), logbuf),
                  'M-3': gas.compile_intent(intent_music(), logbuf), 'M-4': gas.compile_intent(intent_join(['a.mp4', 'b.mp4']), logbuf),
                  'M-6': gas.compile_intent(intent_audio_ref(), logbuf)}
        gas.log(logbuf, f'all {len(graphs)} intents compile offline')
        if args.precheck:
            return
        blockers = gas.gpu_blockers(args.max_util, args.max_app_mib, samples=3)
        if blockers:
            raise SystemExit('GPU busy, nothing started: ' + '; '.join(blockers))
        host = gas.host_memory_state()
        reason = gas.headroom_refusal(host, True) if host else None
        if reason:
            raise SystemExit(reason)
        port = gas.pick_port()
        scratch = outdir / 'scratch'
        for sub in ('input', 'output', 'temp'):
            (scratch / sub).mkdir(parents=True, exist_ok=True)
        backend = subprocess.Popen([str(gas.VENV_PY), '-u', 'main.py', '--port', str(port), '--listen', '127.0.0.1', '--extra-model-paths-config', str(gas.MODELS_YAML),
                                    '--input-directory', str(scratch / 'input'), '--output-directory', str(scratch / 'output'), '--temp-directory', str(scratch / 'temp')],
                                   cwd=gas.COMFY, stdout=open(outdir / 'backend.log', 'w'), stderr=subprocess.STDOUT)
        base = f'http://127.0.0.1:{port}'
        for _ in range(90):
            try:
                gas.http_json(base, '/system_stats')
                break
            except Exception:
                time.sleep(2)
        else:
            raise SystemExit('throwaway backend never became ready; see backend.log')
        gas.log(logbuf, f'throwaway backend ready on :{port} (pid {backend.pid})')
        # M-1
        files, meta = submit(base, graphs['M-1'], scratch, 'M-1 first take', logbuf)
        v1 = newest(files, {'.mp4', '.webm', '.mkv'})
        p1 = gas.ffprobe(v1) if v1 else {}
        results['M-1'] = {**meta, 'file': v1.name if v1 else None, 'probe': p1, 'pass': bool(v1 and p1.get('audio') and abs(p1['duration'] - 124 / 24) < 0.4)}
        # M-2: the session's newest clip is the first take
        sess = gas.http_json(base, f'/df_h3_continuity/session/{SESSION}')
        clips = sess.get('clips') or []
        clip_id = (clips[0].get('clip_id') or clips[0].get('clipId')) if clips else None
        gas.log(logbuf, f'session clips: {[(c.get("clip_id") or c.get("clipId"), c.get("frames")) for c in clips]}')
        if not clip_id:
            raise RuntimeError('M-1 left no checkpoint clip in the continuity session')
        g2 = gas.compile_intent(intent_next(clip_id), logbuf)
        files2, meta2 = submit(base, g2, scratch, 'M-2 continued shot', logbuf)
        v2 = newest(files2, {'.mp4', '.webm', '.mkv'})
        p2 = gas.ffprobe(v2) if v2 else {}
        ext = 102 / 24
        results['M-2'] = {**meta2, 'file': v2.name if v2 else None, 'probe': p2, 'expected_new_seconds': round(ext, 3),
                          'holds_only_new_footage': bool(v2 and abs(p2['duration'] - ext) < 0.6), 'pass': bool(v2 and p2.get('audio') and abs(p2['duration'] - ext) < 0.6)}
        # M-3
        files3, meta3 = submit(base, graphs['M-3'], scratch, 'M-3 music bed', logbuf)
        a3 = newest(files3, {'.flac', '.wav', '.mp3', '.ogg', '.opus'})
        dur3 = float(json.loads(gas.sh(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'json', str(a3)]).stdout)['format']['duration']) if a3 else 0
        results['M-3'] = {**meta3, 'file': a3.name if a3 else None, 'duration': dur3, 'mean_db': gas.media_audio_mean_db(a3) if a3 else None, 'pass': bool(a3 and abs(dur3 - 12) < 1.5)}
        # M-4: both shots as files in the backend input folder, in order
        names = []
        for n, v in enumerate((v1, v2), 1):
            dst = scratch / 'input' / f'deas-inputs-movie-shot{n}{v.suffix}'
            shutil.copy2(v, dst)
            names.append(dst.name)
        files4, meta4 = submit(base, gas.compile_intent(intent_join(names), logbuf), scratch, 'M-4 join', logbuf, timeout=900)
        film = newest(files4, {'.mp4', '.webm', '.mkv'})
        pf = gas.ffprobe(film) if film else {}
        want = p1.get('duration', 0) + p2.get('duration', 0)
        seam = frame_psnr(v1, v2, outdir) if v1 and v2 else None
        results['M-4'] = {**meta4, 'file': film.name if film else None, 'probe': pf, 'sum_of_shots': round(want, 3), 'seam_last_vs_first_frame_psnr_db': seam,
                          'pass': bool(film and pf.get('audio') and abs(pf['duration'] - want) < 0.5)}
        results['M-5'] = measure_mix(film, a3, outdir)
    except BaseException as e:  # noqa: BLE001
        gas.log(logbuf, f'SESSION STOPPED: {type(e).__name__}: {e}')
        results['error'] = f'{type(e).__name__}: {e}'
    finally:
        gas.remove_marker_test(marker_path, marker_orig)
        if mix_path.read_text(encoding='utf-8') != mix_orig:
            mix_path.write_text(mix_orig, encoding='utf-8')
        if backend is not None:
            backend.terminate()
            try:
                backend.wait(20)
            except Exception:  # noqa: BLE001
                backend.kill()
            gas.log(logbuf, 'throwaway backend stopped')
        (outdir / 'session.log').write_text('\n'.join(logbuf), encoding='utf-8')
        (outdir / 'results.json').write_text(json.dumps(results, indent=1, default=str), encoding='utf-8')
        rows = [f'| {k} | {"PASS" if v.get("pass") else "FAIL"} | `{json.dumps({x: y for x, y in v.items() if x not in ("pass",)}, default=str)[:600]}` |' for k, v in results.items() if isinstance(v, dict)]
        (outdir / 'summary.md').write_text('# Movie Maker GPU session\n\n| gate | verdict | measurements |\n|---|---|---|\n' + '\n'.join(rows) + (f'\n\nstopped: {results["error"]}\n' if 'error' in results else '\n'), encoding='utf-8')
        print(f'\nartifacts: {outdir}')


if __name__ == '__main__':
    main()
