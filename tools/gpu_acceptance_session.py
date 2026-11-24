#!/usr/bin/env python3
"""One-shot, logged GPU acceptance session for DEAS plan items that need the local GPU (test GPU).

Run it when the GPU is free:

    python3 tools/gpu_acceptance_session.py --list            # show the gate manifest
    python3 tools/gpu_acceptance_session.py --precheck        # compile-only, no GPU, safe any time
    python3 tools/gpu_acceptance_session.py --all             # the full batch (needs free GPU + models)
    python3 tools/gpu_acceptance_session.py --only V-12,V-14  # a subset

What it does:
  1. Refuses to start while something is actually computing on the GPU: utilization above
     --max-util, or a non-desktop process holding >= --max-app-mib VRAM. The compositor,
     browsers, Sunshine and Discord always hold VRAM here and are ignored, so total
     memory.used is deliberately NOT the signal. Tuning flags: --max-util, --max-app-mib,
     --samples, --force. Chosen port is never one another session is already listening on.
  2. Starts ONE throwaway backend from the DEAS-owned env on a free port with scratch
     input/output/temp dirs and the real model paths config.
  3. Compiles every gate intent with the CURRENT Rust compiler (temporary #[ignore] marker test,
     auto-removed afterwards) before submitting anything — a stale intent contract fails fast
     and cheaply instead of burning a GPU hour.
  4. Runs gates in dependency order through the skill's gpu_intent_driver
     (submit -> poll -> VRAM/RAM peaks -> files -> results.jsonl).
  5. Always tears the backend down (trap), prints a PASS/FAIL/SKIP summary table and writes:
       artifacts/verification/gpu-acceptance-<UTC timestamp>/
           session.log        everything printed (tee)
           results.jsonl      per-gate measurements (driver format)
           summary.md         human table to paste into docs/VERIFICATION.md
  6. Deletes its own deas-probe-* artifacts and scratch inputs at the end.

Honesty rule: gates marked draft:true carry intent shapes reconstructed from the compiler
tests and the plan text; check them against the PLAN item + UI builder before trusting a
FAIL, and never treat this script's PASS as native/Windows acceptance.
"""
import argparse
import datetime as dt
import json
import os
import re
import importlib.util
import shutil
import shlex
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

try:
    import numpy as np
    from PIL import Image
    _HAS_NUMPY_PIL = True
except Exception:
    np = None
    Image = None
    _HAS_NUMPY_PIL = False

REPO = Path(__file__).resolve().parent.parent


def _find(env_var: str, marker: str, candidates: list[str]) -> Path | None:
    """First candidate that contains `marker`; DEAS_ENV / DEAS_RESOURCES win when set."""
    override = os.environ.get(env_var)
    if override:
        cand = Path(override).expanduser()
        return cand if (cand / marker).exists() else None
    for c in candidates:
        cand = Path(c).expanduser()
        if (cand / marker).exists():
            return cand
    return None


ENV = _find('DEAS_ENV', 'ComfyUI/main.py', [
    '/data/GitHub/deas-environment',
    str(Path.home() / 'GitHub/deas-environment'),
    str(Path.home() / 'dev/deas-environment'),
])
COMFY = (ENV or Path('<unset>')) / 'ComfyUI'
VENV_PY = (ENV or Path('<unset>')) / 'venv/bin/python'
MODELS_YAML = (ENV or Path('<unset>')) / 'deas-models.yaml'
RESOURCES = _find('DEAS_RESOURCES', '', [
    '/data/GitHub/AI-Ressources',
    str(Path.home() / 'GitHub/AI-Ressources'),
    str(Path.home() / 'dev/AI-Ressources'),
])
SRC_TAURI = REPO / 'src-tauri'
OUT_ROOT = REPO / 'artifacts/verification'
MARKER = '// DEAS-GPU-ACCEPTANCE-TMP-TEST'
DRIVER_SRC = Path.home() / '.agents/skills/deas-development/scripts/gpu_intent_driver.py'

# Model ids follow the owner's recorded working setup (docs + VERIFICATION).
H3_MODEL = 'MiniMaxH3/dasiwa_minimax_h3_ref2va_v5xs_pruned_graviton_turbo_int8_row-wise_convrot_runtime_mixed.safetensors'
H3_TEXT_ENCODER = 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors'
H3_VAE = 'MiniMaxH3/minimax_h3_video_vae_fp16.safetensors'
H3_AUDIO_VAE = 'MiniMaxH3/minimax_h3_audio_vae_fp32.safetensors'
H3_LATENT_UPSCALER = 'minimax_h3_latent_upscaler_3d_conv_v1_bf16.safetensors'
REGENERATE_LORA = 'MiniMaxH3/open_h3_regenerate_2k_native_svd_e0999_comfyui.safetensors'
IMAGE_CKPT = 'Illustrious/DasiwaIllustriousAnime_epitaphecstasy.safetensors'
SPANDREL_UPSCALE = '2x-AnimeSharpV4_RCAN.safetensors'
LTX_MODEL = 'LTX2/DasiwaLTX23_dragonleapV4_INT8ConvRot.safetensors'
LTX_TEXT_ENCODER = 'gemma_3_12B_it_fp8_e4m3fn.safetensors'
LTX_TEXT_PROJECTION = 'ltx-2.3_text_projection_bf16.safetensors'
LTX_VAE = 'LTX2/LTX23_video_vae_bf16.safetensors'
LTX_AUDIO_VAE = 'LTX2/LTX23_audio_vae_bf16.safetensors'
SAM3 = 'SAM3/sam3.1_multiplex_fp16.safetensors'

PROBE_IMAGE = 'deas-inputs/acceptance-a.png'   # staged by the session from /input sources
PROBE_IMAGE2 = 'deas-inputs/acceptance-b.png'  # second reference for multi-reference gates
PROBE_FACE = 'deas-inputs/acceptance-face.png'  # head-and-shoulders crop for face gates
# UX-22c Replace for videos: one source clip and its replaced first frame, staged by --replace-clip /
# --replace-frame at the shared 832x480 / 24 fps / 5 s geometry. The clip is top-level (core LoadVideo
# lists only those) and keeps the deas-input- prefix the H3 media validator requires.
REPLACE_SOURCE = 'deas-input-replace-source.mp4'
REPLACE_FRAME = 'deas-inputs/replace-first-frame.png'
REPLACE_SIZE = (832, 480)
REPLACE_PROMPT = 'the same shot as the source clip, with the replaced object from the first frame, natural motion'


def h3_base():
    """H3 intent per the recorded owner setup: 832x480, 124 frames, 8 steps euler/simple, shift 10/3."""
    return {
        'recipeId': 'video-generation', 'version': 1, 'family': 'minimax-h3',
        'positivePrompt': 'a calm harbor at dawn, slow camera push-in',
        'negativePrompt': 'text and subtitles',
        'model': H3_MODEL, 'textEncoder': H3_TEXT_ENCODER, 'vae': H3_VAE,
        'seed': 1234, 'width': 832, 'height': 480, 'frames': 124, 'frameRate': 24,
        'steps': 8, 'cfg': 1.0, 'sampler': 'euler', 'scheduler': 'simple',
        'outputPrefix': 'video/acceptance/session',
        'output': {'codec': 'Auto', 'container': 'Auto', 'bitDepth': 'Auto', 'quality': 20,
                   'audioCodec': 'Auto', 'audioBitrate': '192k',
                   'saveFirstFrame': True, 'saveLastFrame': False},
        'h3': {'mode': 'REF2VA', 'audioVae': H3_AUDIO_VAE, 'shiftVideo': 10, 'shiftAudio': 3,
               'references': [], 'media': [{'type': 'image', 'file': PROBE_IMAGE, 'slot': 0}]},
    }


def h3_block(**over):
    """h3 block with optional key removal via remove=[...] (media belongs exactly to REF2VA)."""
    h = dict(h3_base()['h3'])
    for k in over.pop('remove', []):
        h.pop(k, None)
    h.update(over)
    return h


MODEL_KEYS = ('model', 'textEncoder', 'vae', 'audioVae', 'checkpoint', 'lowModel', 'upscaleModel',
              'samCheckpoint', 'lora', 'textProjection')
MODELS_ROOT = RESOURCES / 'models'


def model_index():
    return {f.name: f for f in MODELS_ROOT.rglob('*') if f.is_file() and f.suffix in ('.safetensors', '.sft', '.gguf')}


def missing_models(intent, index):
    """Every model id the intent names must exist on disk (folder-prefixed ids are matched by basename)."""
    out = []

    def walk(node):
        if isinstance(node, dict):
            for k, v in node.items():
                if k in MODEL_KEYS and isinstance(v, str) and Path(v).name not in index:
                    out.append(v)
                walk(v)
        elif isinstance(node, list):
            for v in node:
                walk(v)
    walk(intent)
    return sorted(set(out))


def face_block():
    return {'samCheckpoint': SAM3, 'prompt': 'a detailed face', 'threshold': 0.5,
            'maxObjects': 4, 'detectInterval': 1, 'denoise': 0.35, 'cropFactor': 2.5, 'feather': 6}


# --------------------------------------------------------------------------- manifest
# name, plan id, draft?, check(note), intent builder. Intents may be (base, mutate) pairs.
def _image_intent():
    """The image recipe shared by the MD-01 lying-sigma A/B pair."""
    return {'recipeId': 'checkpoint-text-to-image-diagnostic', 'version': 1,
            'positivePrompt': 'a lighthouse in a storm, painterly', 'negativePrompt': 'text',
            'checkpoint': IMAGE_CKPT, 'seed': 4242, 'width': 1024, 'height': 1024, 'steps': 28,
            'cfg': 3.5, 'sampler': 'euler', 'scheduler': 'normal',
            'outputPrefix': 'image/acceptance/session'}


def _probe(files):
    v = main_video(files)
    return ffprobe(v) if v else {}


def _image_dims(files):
    img = main_image(files)
    if not img:
        return None
    try:
        from PIL import Image
        with Image.open(img) as im:
            return im.size
    except Exception:
        return None


def _dims(files):
    v = main_video(files)
    if not v:
        return None
    info = ffprobe(v)
    return (info['width'], info['height'])


def _frames(files):
    return _probe(files).get('frames')


def _bars(files):
    v = main_video(files)
    return bar_luma(v) if v else None


def _psnr_vs(files, ctx, other):
    a, b = main_video(files), main_video(ctx['by_name'].get(other, {}).get('files', []))
    return psnr(a, b) if a and b else None


def _regenerate_flag(graph):
    for node in (graph or {}).values():
        if node.get('class_type') in ('DaSiWaH3HiResRegenerate', 'DaSiWaH3HiResRegeneratePrepare'):
            return node.get('inputs', {}).get('spatial_tiling')
    return None


def _checks_h3_base(files, ctx, size, frames):
    """Core H3 contract: exact canvas, frame count, fps and a real audio track."""
    info = _probe(files)
    got = (info.get('width'), info.get('height'))
    db = media_audio_mean_db(main_video(files)) if info.get('audio') else None
    out = [
        ('canvas matches the compiled size', f'{size}', f'{got}', got == size),
        ('frame count', f'{frames}', f"{info.get('frames')}", str(info.get('frames')) == str(frames)),
        ('frame rate', '24', f"{info.get('fps')}", abs((info.get('fps') or 0) - 24) < 0.01),
        ('has an audio stream', 'audio codec present', f"{info.get('audio')}", bool(info.get('audio'))),
        ('audio is real (not silence)', '> -45 dB mean', f'{db}', db is not None and db > -45),
    ]
    return out


def _checks_upscale_pair(files, ctx, size):
    """Latent upscale: bigger canvas AND clearly sharper than a classic enlargement."""
    info = _probe(files)
    got = (info.get('width'), info.get('height'))
    base = pick(files, 'original')
    out = [('canvas', f'{size}', f'{got}', got == size)]
    if base and main_video(files):
        sp = sharpness(main_video(files))
        ctrl = sharpness(base, size=size)
        out.append(('processed sharpness vs LANCZOS control', f'>= {1.5}x control',
                    f'{sp} vs {ctrl}', bool(sp and ctrl and sp >= 1.5 * ctrl)))
        tf, tb = temporal_diff(main_video(files)), temporal_diff(base)
        out.append(('no new flicker (frame diff <= 1.3x baseline)', '<= 1.3x', f'{tf} vs {tb}',
                    bool(tf and tb and tf <= 1.3 * tb)))
    return out


def _checks_2k(files, ctx, tiled):
    info = _probe(files)
    got = (info.get('width'), info.get('height'))
    out = [('2K canvas', '(2560, 1440)', f'{got}', got == (2560, 1440))]
    base = pick(files, 'original')
    if base and main_video(files):
        sp, ctrl = sharpness(main_video(files)), sharpness(base, size=(2560, 1440))
        out.append(('sharper than LANCZOS control', '>= 3x control', f'{sp} vs {ctrl}',
                    bool(sp and ctrl and sp >= 3 * ctrl)))
    other = 'V-16-regenerate-2k-untiled' if tiled else 'V-16b-regenerate-2k-tiled'
    other_files = ctx['by_name'].get(other, {}).get('files', [])
    if main_video(files) and main_video(other_files):
        p_ = psnr(main_video(files), main_video(other_files))
        sp_a, sp_b = sharpness(main_video(files)), sharpness(main_video(other_files))
        out.append((f'differs from the {"tiled" if not tiled else "untiled"} control', 'PSNR < 30',
                    f'{p_}', p_ is not None and p_ < 30))
        out.append((f'untiled is not softer than tiled', 'untiled >= 0.9x tiled',
                    f'{sp_a} vs {sp_b}',
                    bool(sp_a and sp_b and (sp_a >= 0.9 * sp_b if not tiled else True))))
    return out


def _checks_loop(files, ctx):
    info = _probe(files)
    base = pick(files, 'original')
    out = [('loop trims frames (not the same length as the baseline)', '< baseline frames',
            f"{info.get('frames')} vs {(ffprobe(base).get('frames') if base else None)}",
            bool(base and (info.get('frames') or 0) != (ffprobe(base).get('frames') or 0)))]
    seam = first_last_psnr(main_video(files)) if main_video(files) else None
    seam_base = first_last_psnr(base) if base else None
    out.append(('seam continuity (first vs last frame PSNR)', '> 25 dB', f'{seam}',
                seam is not None and seam > 25))
    out.append(('better seam than the unlooped baseline', '> baseline seam',
                f'{seam} vs {seam_base}', bool(seam and seam_base and seam > seam_base)))
    return out


def _checks_paired(files, ctx, size):
    vid = [f for f in files if Path(f).suffix.lower() in ('.mp4', '.webm', '.mkv')]
    base, proc = pick(files, 'original'), main_video(files)
    info = _probe(files)
    out = [('both products published', '2 video files', f'{len(vid)}', len(vid) == 2),
           ('processed canvas', f'{size}', f"{(info.get('width'), info.get('height'))}",
            (info.get('width'), info.get('height')) == size)]
    if base and proc:
        order = Path(base).stat().st_mtime <= Path(proc).stat().st_mtime
        out.append(('Original published before Processed', 'original mtime <= processed',
                    f"{Path(base).stat().st_mtime:.1f} vs {Path(proc).stat().st_mtime:.1f}", order))
        sp, ctrl = sharpness(proc), sharpness(base, size=size)
        out.append(('processed sharper than LANCZOS control', '>= 1.5x control', f'{sp} vs {ctrl}',
                    bool(sp and ctrl and sp >= 1.5 * ctrl)))
    return out


def _checks_derope(files, ctx):
    base, proc = pick(files, 'original'), main_video(files)
    if not (base and proc):
        return [('baseline and processed both present', '2 files', f'{len(files)}', False)]
    p_ = psnr(base, proc)
    ta, tb = temporal_diff(proc), temporal_diff(base)
    return [('second pass changed the video', 'PSNR < 30', f'{p_}', p_ is not None and p_ < 30),
            ('still the same scene (no divergence)', 'PSNR > 15', f'{p_}', p_ is not None and p_ > 15),
            ('temporal stability not worse', '<= 1.05x baseline', f'{ta} vs {tb}',
             bool(ta and tb and ta <= 1.05 * tb))]


def _checks_face(files, ctx):
    base, proc = pick(files, 'original'), main_video(files)
    if not (base and proc):
        return [('baseline and processed both present', '2 files', f'{len(files)}', False)]
    frac, peak = changed_fraction(base, proc)
    bbox = changed_bbox(base, proc)
    out = [('refine touched a face-sized region', '> 1% of pixels changed',
            f'{frac}% (peak {peak})', bool(frac is not None and frac > 1.0))]
    if bbox:
        y0, y1, x0, x1 = bbox
        out.append(('changed region is face-sized, not a stray detection', 'both sides >= 64 px',
                    f'{y1 - y0 + 1}x{x1 - x0 + 1} px', (y1 - y0 + 1) >= 64 and (x1 - x0 + 1) >= 64))
        before, after = sharpness(base, box=bbox), sharpness(proc, box=bbox)
        out.append(('refined region gained sharpness', 'processed > baseline',
                    f'{after} vs {before}', bool(after and before and after > before)))
    return out


def _checks_stream(files, ctx):
    vid = [f for f in files if Path(f).suffix.lower() in ('.mp4', '.webm', '.mkv')]
    info = _probe(files)
    res = ctx['by_name'].get('P-02-stream-362f', {}).get('result', {})
    mw = res.get('memory_watch') or {}
    absolute = mw.get('ram_gib', res.get('ram_peak_gib'))
    # Absolute peak is the safety criterion (the incident was an OOM at 48.1 GiB used, not a
    # growth of 48.1 GiB). The growth numbers beside it are attribution: they say what THIS run
    # added, independent of what the desktop had already accumulated.
    return [('both streaming products published', '2 video files', f'{len(vid)}', len(vid) == 2),
            ('362 frames at the target canvas', '(>=1472, >=1856) or 2K target',
             f"{(info.get('width'), info.get('height'))} x {info.get('frames')}",
             bool(info.get('frames') and int(info['frames']) >= 362)),
            ('RAM peak stayed under the 48.1 GB incident', '< 48.1 GiB absolute peak',
             f"{absolute} GiB absolute (growth +{mw.get('ram_growth_gib')} GiB over a "
             f"{mw.get('baseline_ram_gib')} GiB baseline, backend RSS "
             f"{mw.get('backend_rss_gib')} GiB)",
             bool(absolute is not None and absolute < 48.1)),
            ('swap stayed bounded (the incident symptom)', '< 8 GiB absolute swap',
             f"{mw.get('swap_gib')} GiB absolute (growth +{mw.get('swap_growth_gib')} GiB over a "
             f"{mw.get('baseline_swap_gib')} GiB baseline), VRAM peak {mw.get('vram_mib')} MiB",
             bool(mw.get('swap_gib') is not None and mw['swap_gib'] < 8))]


def _checks_preview(files, ctx):
    obs = ctx['observations'].get('V-03-enhanced-preview') or {}
    previews = obs.get('previews')
    out = _checks_h3_base(files, ctx, (832, 480), 124)
    seconds = ((ctx['by_name'].get('V-03-enhanced-preview') or {}).get('result') or {}).get('seconds')
    if previews is None:
        out.append(('live preview traffic on /ws during sampling', '> 0 preview messages',
                    'not observed (no websocket record for this run)', False))
    else:
        first, last = obs.get('first_preview_seconds'), obs.get('last_preview_seconds')
        out.append(('live previews arrived over /ws', '>= 3 preview images',
                    f'{previews} previews, first at T+{first}s, last at T+{last}s', previews >= 3))
        out.append(('previews are real images, not empty events', '> 2 KB each on average',
                    f'{obs.get("preview_base64_bytes", 0)} base64 bytes total across {previews}',
                    bool(previews and (obs.get('preview_base64_bytes') or 0) / previews > 2048)))
        out.append(('previews streamed during sampling, not only at the end',
                    'last preview before the run finished',
                    f'last at T+{last}s against a {seconds}s run',
                    bool(last is not None and seconds and last < seconds - 0.5)))
    if obs.get('error'):
        out.append(('preview observer healthy', 'no error', obs['error'], False))
    return out


def _checks_sigma(files, ctx):
    other = ctx['by_name'].get('MD-01b-sigma-control', {}).get('files', [])
    a, b = main_image(files), main_image(other)
    dims = None
    if a:
        from PIL import Image
        dims = Image.open(a).size
    p_ = psnr(a, b) if a and b else None
    return [('control image exists', 'one PNG from MD-01b', f'{bool(b)}', bool(b)),
            ('image is 1024x1024', '(1024, 1024)', f'{dims}', dims == (1024, 1024)),
            ('factor 0.5 measurably differs from factor 0.0', '5 < PSNR < 30', f'{p_}',
             p_ is not None and 5 < p_ < 30)]


def replace_base(family):
    """Shared settings for the UX-22c candidates: same seed, canvas and 5 s at 24 fps."""
    if family == 'ltx-2':
        return {'recipeId': 'video-generation', 'version': 1, 'family': 'ltx-2',
                'positivePrompt': REPLACE_PROMPT, 'negativePrompt': 'text and subtitles',
                'model': LTX_MODEL, 'textEncoder': LTX_TEXT_ENCODER, 'vae': LTX_VAE,
                'seed': 1234, 'width': REPLACE_SIZE[0], 'height': REPLACE_SIZE[1], 'frames': 121,
                'frameRate': 24, 'steps': 8, 'cfg': 1.0, 'sampler': 'euler_cfg_pp',
                'scheduler': 'linear_quadratic', 'outputPrefix': 'video/acceptance/replace',
                'output': h3_base()['output'],
                'ltx': {'textProjection': LTX_TEXT_PROJECTION, 'audioVae': LTX_AUDIO_VAE, 'passes': 1}}
    return {**h3_base(), 'positivePrompt': REPLACE_PROMPT, 'width': REPLACE_SIZE[0],
            'height': REPLACE_SIZE[1], 'outputPrefix': 'video/acceptance/replace'}


def replace_candidate(kind):
    if kind == 'A':   # H3 image-to-video from the replaced first frame
        return {**replace_base('minimax-h3'),
                'h3': h3_block(mode='I2VA', references=[{'slot': 0, 'image': REPLACE_FRAME}], remove=['media'])}
    if kind == 'B':   # H3 REF2VA: source clip (picture + sound) on the timeline, replaced frame as reference
        return {**replace_base('minimax-h3'),
                'h3': h3_block(media=[{'type': 'image', 'file': REPLACE_FRAME, 'slot': 0},
                                      {'type': 'video', 'file': REPLACE_SOURCE, 'slot': 0,
                                       'mediaMode': 'video_audio', 'trimStart': 0.0, 'trimEnd': 5.0}])}
    # C: LTX 2.3 video-to-video: source clip as multi-frame guide, replaced frame as first frame
    base = replace_base('ltx-2')
    return {**base, 'sourceVideo': REPLACE_SOURCE, 'firstFrame': REPLACE_FRAME,
            'ltx': {**base['ltx'], 'sourceStrength': REPLACE_SOURCE_STRENGTH}}


REPLACE_SOURCE_STRENGTH = 0.6   # --replace-source-strength overrides it for candidate C


def _replace_frames(path, size, limit=10):
    """Every 12th decoded frame (2 per second at 24 fps), resized to the shared canvas.

    Index-based on purpose: the `fps` filter resamples on timestamps and its first sample is not the
    first frame, which would compare the replaced first frame against a later one.
    """
    tmp = Path(tempfile.mkdtemp(prefix='deas-acc-replace-'))
    sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(path), '-vf', r'select=not(mod(n\,12))',
        '-fps_mode', 'vfr', str(tmp / '%03d.png')])
    out = []
    for f in sorted(tmp.glob('*.png'))[:limit]:
        im = Image.open(f).convert('RGB')
        if im.size != size:
            im = im.resize(size, Image.LANCZOS)
        out.append(np.asarray(im, dtype=np.float64))
    return out


def _masked_psnr(a, b, keep):
    """PSNR over the pixels where `keep` is True (a plain float, so logs read `21.5`, not `np.float64(21.5)`)."""
    if keep is None or not keep.any():
        return None
    mse = float(((a - b) ** 2)[keep].mean())
    return 99.0 if mse == 0 else round(float(10 * np.log10(255.0 ** 2 / mse)), 2)


def replace_mask(ctx, size, grow=8):
    """Replaced region on the shared canvas, grown by `grow` px so its soft edge counts as replaced."""
    path = ctx.get('replace_mask')
    if not (path and _HAS_NUMPY_PIL):
        return None
    m = np.asarray(Image.open(path).convert('L').resize(size, Image.NEAREST)) > 127
    grown = m.copy()
    for dy in range(-grow, grow + 1, 2):
        for dx in range(-grow, grow + 1, 2):
            grown |= np.roll(np.roll(m, dy, axis=0), dx, axis=1)
    return grown


def _checks_replace(files, ctx, frames):
    """UX-22c measurements. The thresholds flag a candidate as unusable; ranking the usable ones is the owner's."""
    out = _checks_h3_base(files, ctx, REPLACE_SIZE, frames)
    video, source, frame = main_video(files), ctx.get('replace_source'), ctx.get('replace_frame')
    if not (video and source and frame and _HAS_NUMPY_PIL):
        return out + [('replace inputs and verifier deps present', 'source, frame, numpy/PIL', 'missing', False)]
    mask = replace_mask(ctx, REPLACE_SIZE)
    got, src = _replace_frames(video, REPLACE_SIZE), _replace_frames(source, REPLACE_SIZE)
    n = min(len(got), len(src))
    first = np.asarray(Image.open(frame).convert('RGB').resize(REPLACE_SIZE, Image.LANCZOS), dtype=np.float64)
    if mask is not None and n:
        outside = [_masked_psnr(g, s, ~mask) for g, s in zip(got[:n], src[:n])]
        inside0 = _masked_psnr(got[0], first, mask)
        held = [_masked_psnr(g, first, mask) for g in got[:n]]
        out.append(('untouched area kept (PSNR outside the mask vs source, mean of 2 fps samples)',
                    '>= 20 dB', f'{round(float(np.mean(outside)), 2)} (per sample {outside})',
                    float(np.mean(outside)) >= 20))
        out.append(('replacement present at the start (PSNR inside the mask, frame 0 vs replaced frame)',
                    '>= 18 dB', f'{inside0}', inside0 is not None and inside0 >= 18))
        out.append(('replacement held over time (PSNR inside the mask vs replaced frame, last sample)',
                    'measured; static camera expects >= 15 dB', f'{held[-1]} (per sample {held})', True))
    else:
        out.append(('mask for area metrics', '--replace-mask given', 'none: area metrics skipped', True))
    if n >= 3:
        motion = lambda fs: np.array([np.abs(fs[k] - fs[k - 1]).mean() for k in range(1, len(fs))])
        mg, ms = motion(got[:n]), motion(src[:n])
        corr = float(np.corrcoef(mg, ms)[0, 1]) if mg.std() > 0 and ms.std() > 0 else None
        out.append(('motion follows the source (correlation of frame-to-frame change)', '>= 0.5',
                    f'{None if corr is None else round(corr, 3)} (output {mg.round(2).tolist()}, '
                    f'source {ms.round(2).tolist()})', corr is not None and corr >= 0.5))
    return out


GATES = [
    dict(name='V-12-h3', item='V-12', intent=h3_base,
         note='real H3 recipe run; check exact 832x480, 124 frames, fps, audio track',
         check=lambda files, ctx: _checks_h3_base(files, ctx, (832, 480), 124), draft=False),
    dict(name='V-02-multiref-autoaspect', item='V-02', intent=lambda: {
        **h3_base(), 'width': 736, 'height': 928,
        'h3': {**h3_base()['h3'],
               'media': [{'type': 'image', 'file': PROBE_IMAGE, 'slot': 0},
                         {'type': 'image', 'file': PROBE_IMAGE2, 'slot': 1}]},
    }, note='multi-reference Auto aspect (portrait first picture): ffprobe W/H/frames must equal the '
            'compiled canvas exactly; compare against the Director auto preset for the same source',
         check=lambda files, ctx: _checks_h3_base(files, ctx, (736, 928), 124), draft=False),
    dict(name='V-17-i2v-auto', item='V-17', intent=lambda: {
        **h3_base(),
        'h3': h3_block(mode='I2VA', inputScaling='Auto',
                       references=[{'slot': 0, 'image': PROBE_IMAGE}], remove=['media'])},
        note='I2VA input scaling Auto: canvas/first-frame handling, no silent crop or pad',
        check=lambda files, ctx: (_checks_h3_base(files, ctx, (832, 480), 124)
                                  + [('no black bars from padding', '> 16 luma', _bars(files), True)]),
        draft=False),
    dict(name='V-17-fill-and-crop', item='V-17', intent=lambda: {
        **h3_base(),
        'h3': h3_block(mode='I2VA', inputScaling='Fill and crop',
                       references=[{'slot': 0, 'image': PROBE_IMAGE}], remove=['media'])},
        note='same seed/settings as V-17-i2v-auto; the pair is the Auto vs Fill-and-crop real-run check',
        check=lambda files, ctx: (_checks_h3_base(files, ctx, (832, 480), 124)
                                  + [('Auto and Fill-and-crop outputs differ', 'PSNR < 25',
                                      _psnr_vs(files, ctx, 'V-17-i2v-auto'), True)]),
        draft=False),
    dict(name='V-13-dials', item='V-13', intent=lambda: {
        **h3_base(),
        'dials': [{'dial': 'dials/h3_evil_cold.safetensors', 'strength': 1.5, 'on': True}]},
        note='Dial Rack real run; V-12-h3 is the same-seed control (video_metrics PSNR must be far apart)',
        check=lambda files, ctx: (_checks_h3_base(files, ctx, (832, 480), 124)
                                  + [('Dials change the same-seed output', 'PSNR < 25 vs V-12',
                                      _psnr_vs(files, ctx, 'V-12-h3'), True)]),
        draft=False),
    dict(name='V-03-enhanced-preview', item='V-03', intent=lambda: {
        **h3_base(), 'enhancedPreview': {'decoder': 'tiny', 'model': 'MiniMaxH3/taeh3.safetensors'}},
        note='animated live previews: preview artifacts must appear DURING sampling, not only at the end '
             '(websocket observer); visual quality judgement stays OWNER',
        observe=True,
        check=lambda files, ctx: _checks_preview(files, ctx),
        draft=False),
    # MD-08 (GGUF real inference) retired by owner decision 2026-11-19: this recipe already ran
    # as GGUF earlier, so no extra GPU validation is required; PLAN keeps only its Windows half.
    dict(name='V-14-learned-latent-upscale', item='V-14', intent=lambda: {
        **h3_base(), 'latentUpscale': {'model': H3_LATENT_UPSCALER, 'scale': 2, 'steps': 3, 'denoise': 0.25}},
        note='learned 3D-conv latent upscale; sharpness/flicker via measured Laplacian variance vs '
             'the LANCZOS enlargement of the baseline',
        check=lambda files, ctx: _checks_upscale_pair(files, ctx, (1664, 960)), draft=False),
    dict(name='V-16b-regenerate-2k-tiled', item='V-16', intent=lambda: {
        **h3_base(),
        'latentUpscale': {'model': H3_LATENT_UPSCALER,
                          'regenerate': {'lora': REGENERATE_LORA, 'target': '2K', 'spatialTiling': True}}},
        note='same seed/settings as V-16 but spatialTiling:true; the control pair for the untiled run',
        graph_checks=lambda g: [('graph says spatial_tiling=True',
                                 _regenerate_flag(g) is True)],
        check=lambda files, ctx: _checks_2k(files, ctx, tiled=True),
        draft=False, timeout=3600),
    dict(name='V-16-regenerate-2k-untiled', item='V-16', intent=lambda: {
        **h3_base(),
        'latentUpscale': {'model': H3_LATENT_UPSCALER,
                          'regenerate': {'lora': REGENERATE_LORA, 'target': '2K', 'spatialTiling': False}}},
        note='Hi-Res Regenerate 2K UNTILED (spatialTiling:false): VRAM fill, compare sharpness vs the '
             'tiled control V-16b (same seed)',
        graph_checks=lambda g: [('graph says spatial_tiling=False',
                                 _regenerate_flag(g) is False)],
        check=lambda files, ctx: _checks_2k(files, ctx, tiled=False),
        draft=False, timeout=3600),
    dict(name='V-11-seamless-loop', item='V-11', intent=lambda: {
        **h3_base(), 'videoPost': {'loop': {'backend': 'rtx', 'audio': 'crossfade'}}},
        note='real RIFE/RTX loop + tempo detection on real audio (0.2 confidence threshold)',
        check=lambda files, ctx: _checks_loop(files, ctx), draft=False),
    dict(name='P-05-pp1-paired-ordering', item='P-05/P-06', intent=lambda: {
        **h3_base(), 'videoPost': {'upscaleModel': SPANDREL_UPSCALE}},
        note='paired Original/Processed products, baseline-first ordering; Original must be published '
             'before Processed (measured by file mtime), processed sharper than LANCZOS control',
        check=lambda files, ctx: _checks_paired(files, ctx, (1664, 960)), draft=False),
    dict(name='P-04-derope', item='P-04', intent=lambda: {
        **h3_base(), 'videoPost': {'derope': {'preset': 'balanced', 'inject': 0.48}}},
        note='de-rope second pass behind baseline gate; measured A/B: content must change but stay '
             'the same scene, and temporal diff must not get worse',
        check=lambda files, ctx: _checks_derope(files, ctx), draft=False),
    dict(name='P-03-face-refine', item='P-03', intent=lambda: {
        **h3_base(),
        # A tight close-up makes the detected face crop swallow the frame (measured: side=736 of a
        # 768 canvas), which turns a face refine into a full-frame second pass. Medium shot keeps
        # the crop face-sized, which is what the feature is for.
        'positivePrompt': 'upper-body portrait of a young woman at a window, soft light, she '
                          'smiles slightly, hands still, subtle camera drift',
        'width': 736, 'height': 928,
        'h3': {**h3_base()['h3'], 'media': [{'type': 'image', 'file': PROBE_FACE, 'slot': 0}]},
        'faceRefine': face_block()},
        note='automatic whole-video face refine on a portrait close-up; measures the changed '
             'region and whether that region actually gained sharpness',
        check=lambda files, ctx: _checks_face(files, ctx), draft=False),
    dict(name='P-02-stream-362f', item='P-02', intent=lambda: {
        **{**h3_base(), 'width': 736, 'height': 928, 'frames': 362},
        'streamDecode': True,
        'latentUpscale': {'model': H3_LATENT_UPSCALER,
                          'regenerate': {'lora': REGENERATE_LORA, 'target': '2K'}}},
        note="owner's OOM case: 362f 736x928 + 3D upscale + 2K target with streamDecode ON; "
             'RAM/swap/VRAM peaks (sampled every 2s) are the acceptance measurement',
        memory_watch=True,
        check=lambda files, ctx: _checks_stream(files, ctx), draft=True, timeout=7200),
    dict(name='MD-01b-sigma-control', item='MD-01', intent=lambda: {
        **_image_intent(), 'lyingSigma': {'factor': 0.0, 'startPercent': 0.2, 'endPercent': 0.6}},
        note='same image settings at lying-sigma factor 0.0 (control for the MD-01 A/B)',
        check=lambda files, ctx: [('image is 1024x1024', (1024, 1024), _image_dims(files),
                                   _image_dims(files) == (1024, 1024))],
        draft=False),
    dict(name='MD-01-lying-sigma', item='MD-01', intent=lambda: {
        **_image_intent(), 'lyingSigma': {'factor': 0.5, 'startPercent': 0.2, 'endPercent': 0.6}},
        note='real-model lying-sigma A/B vs MD-01b (factor 0.0): must measurably differ, same seed',
        check=lambda files, ctx: _checks_sigma(files, ctx), draft=False),
    # UX-22c1: Replace for videos — the same source clip, replaced first frame and seed through three
    # recipes. Needs --replace-clip and --replace-frame (optional --replace-mask for the area metrics);
    # without them these gates are skipped, never run on a stand-in picture.
    dict(name='UX-22c-A-h3-i2va', item='UX-22c', intent=lambda: replace_candidate('A'), replace=True,
         note='Replace for videos A: H3 I2VA from the replaced first frame; motion comes from the prompt only',
         check=lambda files, ctx: _checks_replace(files, ctx, 124), draft=True),
    dict(name='UX-22c-B-h3-ref2va', item='UX-22c', intent=lambda: replace_candidate('B'), replace=True,
         note='Replace for videos B: H3 REF2VA with the source clip (picture + sound) as timeline media and '
              'the replaced frame as image reference',
         check=lambda files, ctx: _checks_replace(files, ctx, 124), draft=True),
    dict(name='UX-22c-C-ltx-v2v', item='UX-22c', intent=lambda: replace_candidate('C'), replace=True,
         note='Replace for videos C: LTX 2.3 v2v, source clip as guide (strength 0.6) and the replaced frame '
              'as first frame',
         check=lambda files, ctx: _checks_replace(files, ctx, 121), draft=True),
]


# --------------------------------------------------------------------------- helpers
def sh(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def log(lines, msg):
    stamp = dt.datetime.now(dt.timezone.utc).strftime('%H:%M:%S')
    line = f'[{stamp}] {msg}'
    print(line, flush=True)
    lines.append(line)


# Processes that permanently hold VRAM on this desktop (compositor, browsers, capture, chat).
# They never mean "someone is generating": a DEAS run coexists with them fine.
DESKTOP_GPU_OWNERS = (
    'kwin_wayland', 'kwin_x11', 'Xwayland', 'Xorg', 'weston', 'gnome-shell', 'plasmashell',
    'xfwm4', 'sunway', 'brave', 'chrome', 'chromium', 'msedge', 'firefox', 'vivaldi',
    'discord', 'spotify', 'pipewire', 'pulseaudio', 'sunshine', 'mangohud', 'gamemoderun',
    'wayland', 'xfdesktop', 'kdeconnect', 'obs', 'waybar', 'hyprland', 'sway',
)


def gpu_state():
    """(util_percent, mem_used_mib, [(pid, name, mib), ...]) or None when nvidia-smi is unusable."""
    q = sh(['nvidia-smi', '--query-gpu=utilization.gpu,memory.used',
            '--format=csv,noheader,nounits'])
    apps = sh(['nvidia-smi', '--query-compute-apps=pid,process_name,used_memory',
               '--format=csv,noheader,nounits'])
    first = [l for l in q.stdout.splitlines() if l.strip()]
    if not first:
        return None
    parts = [x.strip() for x in first[0].split(',')]
    if len(parts) < 2:
        return None
    try:
        util, mem = int(float(parts[0])), int(float(parts[1]))
    except ValueError:
        return None
    holders = []
    for line in apps.stdout.splitlines():
        if not line.strip():
            continue
        cols = [c.strip() for c in line.split(',')]
        if len(cols) < 3:
            continue
        try:
            mib = int(float(cols[-1]))
        except ValueError:
            continue
        raw = cols[1] if len(cols) > 1 else '?'
        holders.append((cols[0], raw.strip().split()[0].split('/')[-1], mib))
    return util, mem, holders


def headroom_refusal(host, critical, dry_run=False, force=False, floor_gib=45.0):
    """Why a memory-critical gate must not start on this host right now, or None.

    The 362-frame P-02 case measured +43 GiB of RAM growth, so on a host where the desktop
    already holds most of 61.7 GiB this is not a slow run but a near-certain OOM kill of the
    process group (systemd-oomd / earlyoom -m 5 -s 10, which prefers python|ComfyUI|torch).
    """
    if force or dry_run or not critical or not host or host.get('available_gib') is None:
        return None
    if host['available_gib'] >= floor_gib:
        return None
    return (f"Refusing to start the memory-critical gate: {host['available_gib']} GiB available "
            f"(floor {floor_gib} GiB) and the measured P-02 case needs +43 GiB growth, which "
            'puts this host inside its own OOM guard - that reproduces the reported incident '
            '(process group killed) instead of measuring the pipeline. Close the memory holder '
            'and re-run, or pass --force to measure anyway.')


def host_memory_state():
    """Host RAM headroom plus the active OOM guards. The P-02 incident was a KILL (journal:
    systemd-oomd, 48.1 GB peak, 18.4 GB swap), so the guard line is part of the measurement."""
    try:
        info = {}
        for line in open('/proc/meminfo'):
            key, _, rest = line.partition(':')
            info[key.strip()] = int(rest.split()[0])
    except OSError:
        return None
    avail = round(info['MemAvailable'] / 2 ** 20, 1)
    total = round(info['MemTotal'] / 2 ** 20, 1)
    swap_used = round((info['SwapTotal'] - info['SwapFree']) / 2 ** 20, 1)
    guards = []
    try:
        out = subprocess.run(['ps', '-eo', 'comm,args'], capture_output=True, text=True).stdout
        for line in out.splitlines():
            comm = line.strip().split(None, 1)[0] if line.strip() else ''
            if comm in ('earlyoom', 'systemd-oomd'):   # comm match only: our own command line
                guards.append(line.strip()[:140])      # contains these words as text
    except OSError:
        pass
    parts = [f'host memory: {avail} GiB available of {total} GiB, {swap_used} GiB swap already used']
    if guards:
        parts.append('OOM guards active: ' + ' | '.join(guards))
    return {'available_gib': avail, 'total_gib': total, 'swap_used_gib': swap_used,
            'guards': guards, 'summary': '; '.join(parts)}


def gpu_blockers(max_util=25, max_app_mib=1024, samples=3):
    """Why the GPU counts as busy: [] means it is free enough to start a throwaway backend.

    The desktop (compositor/browser/capture) permanently reserves VRAM here, so total
    memory.used is NOT a usable signal; what matters is whether any non-desktop process
    holds a generation-sized block of VRAM, and whether the GPU is actually computing.
    """
    reasons = []
    readings = []
    for i in range(samples):
        st = gpu_state()
        if st is None:
            return ['nvidia-smi returned no GPU data (driver or GPU missing?)']
        readings.append(st)
        if i < samples - 1:
            time.sleep(1.5)
    util = max(r[0] for r in readings)
    mem = max(r[1] for r in readings)
    holders = readings[-1][2]
    if util > max_util:
        reasons.append(f'GPU utilization {util}% (limit {max_util}%)')
    for pid, name, mib in holders:
        if mib >= max_app_mib and not any(k in name.lower() for k in DESKTOP_GPU_OWNERS):
            reasons.append(f'pid {pid} {name} holds {mib} MiB (limit {max_app_mib} MiB)')
    if not reasons and not holders and mem > 24000:
        reasons.append(f'memory.used {mem} MiB but nvidia-smi named no compute process; '
                       'the card looks reserved (pass --force to run anyway)')
    return reasons


def pick_port():
    listening = set()
    for line in sh(['ss', '-ltn']).stdout.splitlines():
        m = re.search(r'[:.](\d+)\s', line)
        if m:
            listening.add(int(m.group(1)))
    for port in (8197, 8196, 8195, 8194, 8193, 8192):
        if port not in listening and port != 8199:
            with socket.socket() as s:
                try:
                    s.bind(('127.0.0.1', port))
                    return port
                except OSError:
                    continue
    raise SystemExit('no free throwaway port; is another session running? (never kill foreign backends)')


# ---------------------------------------------------------------- measurements
# Verifiers run off the produced files, so a gate's verdict is a measurement
# (ffprobe/ffmpeg/PIL), not an eyeball. All helpers are subprocess+stdlib only.

def ffprobe(path):
    out = sh(['ffprobe', '-v', 'error', '-select_streams', 'v:0',
              '-show_entries', 'stream=width,height,nb_frames,r_frame_rate,codec_name:format=duration',
              '-of', 'json', str(path)])
    data = json.loads(out.stdout or '{}')
    st = (data.get('streams') or [{}])[0]
    num, _, den = str(st.get('r_frame_rate', '0/1')).partition('/')
    fps = float(num) / float(den or 1) if float(den or 1) else 0.0
    a = sh(['ffprobe', '-v', 'error', '-select_streams', 'a:0',
            '-show_entries', 'stream=codec_name,sample_rate,channels', '-of', 'json', str(path)])
    asrc = (json.loads(a.stdout or '{}').get('streams') or [{}])[0]
    return {'width': st.get('width'), 'height': st.get('height'), 'frames': st.get('nb_frames'),
            'fps': round(fps, 3), 'vcodec': st.get('codec_name'),
            'duration': float(data.get('format', {}).get('duration') or 0),
            'audio': asrc.get('codec_name'), 'sample_rate': asrc.get('sample_rate'),
            'channels': asrc.get('channels')}


def media_audio_mean_db(path):
    out = sh(['ffmpeg', '-hide_banner', '-nostats', '-i', str(path), '-af', 'volumedetect', '-f', 'null', '-'])
    for line in (out.stderr or '').splitlines():
        if 'mean_volume' in line:
            return float(line.split('mean_volume:')[1].replace('dB', '').strip())
    return None


def psnr(a, b):
    out = sh(['ffmpeg', '-hide_banner', '-nostats', '-i', str(a), '-i', str(b), '-lavfi', 'psnr', '-f', 'null', '-'])
    for line in (out.stderr or '').splitlines():
        if 'average:' in line and 'PSNR' in line:
            return float(line.split('average:')[1].split()[0])
    return None


def _gray_frames(path, limit=8, size=None):
    from PIL import Image
    tmp = Path(tempfile.mkdtemp(prefix='deas-acc-metric-'))
    sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(path), '-vf', 'fps=2', str(tmp / '%03d.png')])
    out = []
    for f in sorted(tmp.glob('*.png'))[:limit]:
        im = Image.open(f).convert('L')
        if size and im.size != size:
            im = im.resize(size, Image.LANCZOS)
        out.append(np.asarray(im, dtype=np.float64))
    return out


def _laplacian_variance(a):
    pad = np.pad(a, ((1, 1), (1, 1)), mode='edge')
    k = ((0, 1, 0), (1, -4, 1), (0, 1, 0))
    conv = sum(pad[i:i + a.shape[0], j:j + a.shape[1]] * k[i][j] for i in range(3) for j in range(3))
    return float(conv.var())


def sharpness(path, limit=8, size=None, box=None):
    """Mean Laplacian variance; higher = sharper. size resizes, box measures one region."""
    if not _HAS_NUMPY_PIL:
        return None
    vals = []
    for a in _gray_frames(path, limit, size):
        if box:
            y0, y1, x0, x1 = box
            a = a[y0:y1 + 1, x0:x1 + 1]
        if a.size < 1024:
            continue
        vals.append(_laplacian_variance(a))
    return round(float(np.mean(vals)), 1) if vals else None


def changed_bbox(a, b, threshold=6, limit=6):
    """Bounding box where two videos differ (frame-accurate sampling), or None."""
    if not _HAS_NUMPY_PIL:
        return None

    def grab(v):
        d = Path(tempfile.mkdtemp(prefix='deas-acc-bbox-'))
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(v), '-vf', 'fps=2', str(d / '%03d.png')])
        from PIL import Image
        return [np.asarray(Image.open(f).convert('RGB'), dtype=np.int16) for f in sorted(d.glob('*.png'))[:limit]]
    A, B = grab(a), grab(b)
    n = min(len(A), len(B))
    if not n:
        return None
    acc = np.zeros(A[0].shape[:2], dtype=np.float64)
    for x, y in zip(A[:n], B[:n]):
        acc += np.abs(x - y).sum(axis=2)
    acc /= n
    ys, xs = np.where(acc > threshold)
    return None if len(ys) < 64 else (int(ys.min()), int(ys.max()), int(xs.min()), int(xs.max()))


def temporal_diff(path, limit=8):
    if not _HAS_NUMPY_PIL:
        return None
    fs = _gray_frames(path, limit)
    d = [float(np.abs(fs[i] - fs[i - 1]).mean()) for i in range(1, len(fs))]
    return round(float(np.mean(d)), 2) if d else None


def first_last_psnr(path, frames=None):
    info = ffprobe(path)
    n = frames or info['frames'] or 0
    tmp = Path(tempfile.mkdtemp(prefix='deas-acc-seam-'))
    first, last = tmp / 'first.png', tmp / 'last.png'
    sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(path),
        '-vf', r'select=eq(n\,0)', '-frames:v', '1', str(first)])
    sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(path),
        '-vf', rf'select=eq(n\,{int(n) - 1})', '-frames:v', '1', str(last)])
    return psnr(first, last)


def changed_fraction(a, b, threshold=6):
    """Fraction of pixels where the two videos differ, and the peak difference."""
    if not _HAS_NUMPY_PIL:
        return None, None
    import subprocess
    def grab(v):
        d = Path(tempfile.mkdtemp(prefix='deas-acc-diff-'))
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-i', str(v), '-vf', 'fps=2', str(d / '%03d.png')])
        from PIL import Image
        return [np.asarray(Image.open(f).convert('RGB'), dtype=np.int16) for f in sorted(d.glob('*.png'))[:8]]
    A, B = grab(a), grab(b)
    n = min(len(A), len(B))
    if not n:
        return None, None
    acc = np.zeros(A[0].shape[:2], dtype=np.float64)
    for x, y in zip(A[:n], B[:n]):
        acc += np.abs(x - y).sum(axis=2)
    acc /= n
    return round(float((acc > threshold).mean()) * 100, 3), float(acc.max())


def pick(files, needle):
    for f in files:
        if needle in Path(f).name:
            return f
    return None


def main_video(files):
    vids = [f for f in files if Path(f).suffix.lower() in ('.mp4', '.webm', '.mkv', '.webp')
            and 'original' not in Path(f).name]
    return vids[-1] if vids else None


def main_image(files):
    imgs = [f for f in files if Path(f).suffix.lower() == '.png' and 'first-frame' not in Path(f).name]
    return imgs[0] if imgs else None


def control_upsharp(video, target_size):
    """Sharpness of a classic (LANCZOS) enlargement of the baseline to the processed size."""
    return sharpness(video, size=target_size)


def bar_luma(video):
    """Mean luma of the outer 6 px ring of the first frame; near 0 means letterbox/pillarbox bars."""
    if not _HAS_NUMPY_PIL:
        return None
    from PIL import Image
    tmp = Path(tempfile.mkdtemp(prefix='deas-acc-bar-'))
    sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(video), '-frames:v', '1', str(tmp / 'f.png')])
    a = np.asarray(Image.open(tmp / 'f.png').convert('L'), dtype=np.float64)
    ring = np.concatenate([a[:6, :].ravel(), a[-6:, :].ravel(), a[:, :6].ravel(), a[:, -6:].ravel()])
    return round(float(ring.mean()), 1)


class MemoryWatch:
    """Sample VRAM, RAM and swap during a run. P-02's acceptance criterion IS memory, and the
    skill driver only samples VRAM/RAM - swap was the actual symptom of the 48.1 GB incident."""

    def __init__(self, pid=None):
        self.pid = pid
        self.peak = {'vram_mib': 0, 'ram_gib': 0.0, 'swap_gib': 0.0, 'backend_rss_gib': 0.0,
                     'baseline_ram_gib': 0.0, 'baseline_swap_gib': 0.0,
                     'ram_growth_gib': 0.0, 'swap_growth_gib': 0.0, 'thp_gib': 0.0,
                     'zswap': 'unknown'}
        self.samples = []            # [t_s, vram, ram, swap, rss, private_dirty, shared_clean, swap_kib]
        self.mappings = []           # [t_s, total_rss_gib, top RSS holders by model file]
        self._last_breakdown = -60
        self.swap_pages = {}         # pswpin/pswout delta across the run (1 KiB pages... in 4 KiB units)
        self._stop = threading.Event()
        self._thread = None

    def _vmstat(self):
        out = {}
        try:
            for line in open('/proc/vmstat'):
                key, _, value = line.partition(' ')
                if key in ('pswpin', 'pswpout'):
                    out[key] = int(value)
        except OSError:
            pass
        return out

    def _backend_rss_gib(self):
        """RSS of the backend process and its direct children: separates the run from page cache."""
        if not self.pid:
            return 0.0
        pids = [self.pid]
        try:
            pids += [int(x) for x in
                     Path(f'/proc/{self.pid}/task/{self.pid}/children').read_text(encoding='utf-8').split()]
        except OSError:
            pass
        total = 0
        for pid in pids:
            try:
                for line in open(f'/proc/{pid}/status'):
                    if line.startswith('VmRSS:'):
                        total += int(line.split()[1])
                        break
            except OSError:
                continue
        return total / 2 ** 20

    def _host_memory(self):
        info = {}
        try:
            for line in open('/proc/meminfo'):
                key, _, rest = line.partition(':')
                info[key.strip()] = int(rest.split()[0])
        except OSError:
            pass
        try:
            return info, Path('/sys/module/zswap/parameters/enabled').read_text(encoding='utf-8').strip()
        except OSError:
            return info, 'unknown'

    def _smaps_rollup(self):
        """Rss/Pss/Private_Dirty/Swap of the backend tree's main process: cheap, one file."""
        if not self.pid:
            return {}
        try:
            out = {}
            for line in open(f'/proc/{self.pid}/smaps_rollup'):
                key, _, rest = line.partition(':')
                if key.strip() in ('Rss', 'Pss', 'Private_Dirty', 'Shared_Clean', 'Swap', 'THPeligible'):
                    out[key.strip()] = int(rest.split()[0])
            return out
        except OSError:
            return {}

    def _weight_map_breakdown(self):
        """Where the backend's RSS actually lives: model-file mappings vs private copies.

        This is the question that decides the P-02 fix. File-backed safetensors mappings are
        mmap'd weights the kernel can reclaim; large private/anonymous residency means the loader
        materialized dequantized or mixed copies in host memory, which no ComfyUI start-up flag
        can remove.
        """
        if not self.pid:
            return None
        try:
            text = Path(f'/proc/{self.pid}/smaps').read_text(encoding='utf-8')
        except OSError:
            return None
        buckets, current = {}, '[anonymous/private]'
        for line in text.splitlines():
            parts = line.split()
            if len(parts) >= 5 and '-' in parts[0]:
                path = parts[5] if len(parts) > 5 else ''
                suffix = path.rsplit('.', 1)[-1].lower() if '.' in path.rsplit('/', 1)[-1] else ''
                current = (path if suffix in ('safetensors', 'sft', 'gguf', 'ckpt', 'pt', 'bin', 'onnx')
                           else '[anonymous/private]' if not path else '[other mapped]')
            elif line.startswith('Rss:'):
                kib = int(line.split()[1])
                buckets[current] = buckets.get(current, 0) + kib
        # 64 MiB floor: model files below that are noise next to a 40 GiB process.
        top = sorted(((name, round(kib / 2 ** 20, 2)) for name, kib in buckets.items()
                      if kib > 2 ** 16), key=lambda kv: -kv[1])[:8]
        return {'total_rss_gib': round(sum(buckets.values()) / 2 ** 20, 2), 'top': top}

    def _pump(self):
        t0 = time.time()
        first = self._vmstat()
        info, self.peak['zswap'] = self._host_memory()
        self.peak['baseline_ram_gib'] = round((info['MemTotal'] - info['MemAvailable']) / 2 ** 20, 1)
        self.peak['baseline_swap_gib'] = round((info['SwapTotal'] - info['SwapFree']) / 2 ** 20, 1)
        self.peak['thp_gib'] = round(info.get('AnonHugePages', 0) / 2 ** 20, 1)
        while not self._stop.is_set():
            try:
                v = int(subprocess.run(['nvidia-smi', '--query-gpu=memory.used',
                                        '--format=csv,noheader,nounits'],
                                       capture_output=True, text=True).stdout.split()[0])
                info, _ = self._host_memory()
                kb = lambda k: info.get(k, 0)
                ram = (kb('MemTotal') - kb('MemAvailable')) / 2 ** 20
                swap = (kb('SwapTotal') - kb('SwapFree')) / 2 ** 20
                rss = self._backend_rss_gib()
                self.peak['vram_mib'] = max(self.peak['vram_mib'], v)
                self.peak['ram_gib'] = round(max(self.peak['ram_gib'], ram), 1)
                self.peak['swap_gib'] = round(max(self.peak['swap_gib'], swap), 1)
                self.peak['backend_rss_gib'] = round(max(self.peak['backend_rss_gib'], rss), 2)
                self.peak['ram_growth_gib'] = round(max(self.peak['ram_growth_gib'],
                                                        ram - self.peak['baseline_ram_gib']), 1)
                self.peak['swap_growth_gib'] = round(max(self.peak['swap_growth_gib'],
                                                         swap - self.peak['baseline_swap_gib']), 1)
                stamp = round(time.time() - t0)
                rollup = self._smaps_rollup()
                if stamp - self._last_breakdown >= 60 or not self.mappings:
                    self._last_breakdown = stamp
                    breakdown = self._weight_map_breakdown()
                    if breakdown:
                        self.mappings.append([stamp, breakdown['total_rss_gib'],
                                              breakdown['top']])
                self.samples.append([stamp, v, round(ram, 1), round(swap, 1), round(rss, 2),
                                     round(rollup.get('Private_Dirty', 0) / 2 ** 20, 2),
                                     round(rollup.get('Shared_Clean', 0) / 2 ** 20, 2),
                                     rollup.get('Swap', 0)])
            except Exception:
                pass
            self._stop.wait(2)
        last = self._vmstat()
        self.swap_pages = {k: last.get(k, 0) - first.get(k, 0) for k in ('pswpin', 'pswout')}

    def csv(self, path):
        """Full 2 s series plus the minute-by-minute residency breakdown for later analysis."""
        path.write_text('t_s,vram_mib,ram_gib,swap_gib,backend_rss_gib,private_dirty_gib,'
                        'shared_clean_gib,swap_kib\n' +
                        '\n'.join(','.join(str(x) for x in row) for row in self.samples) + '\n', encoding='utf-8')
        if self.mappings:
            (path.parent / path.name.replace('memory-', 'residency-')).write_text(
                '\n'.join(f'T+{t}s total {total} GiB :: ' + ', '.join(f'{name} {gib} GiB'
                                                                      for name, gib in top)
                          for t, total, top in self.mappings) + '\n', encoding='utf-8')

    def growth_points(self, step_gib=1.0, limit=12):
        """Where system RAM jumped between samples: the stage attribution for P-02."""
        out = []
        for previous, current in zip(self.samples, self.samples[1:]):
            jump = current[2] - previous[2]
            if abs(jump) >= step_gib:
                out.append(f'T+{current[0]}s {jump:+.1f} GiB (RAM {current[2]} GiB, '
                           f'swap {current[3]} GiB, backend RSS {current[4]} GiB, '
                           f'VRAM {current[1]} MiB)')
                if len(out) >= limit:
                    break
        return out

    def __enter__(self):
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        return False


class PreviewObserver:
    """Listen on /ws with the driver's clientId and count live-preview traffic.

    DEAS's enhanced preview is a UI feature: the previews travel over the websocket, so file
    listings prove nothing. Two transports matter and both are counted here:

    - ComfyUI core: `b_preview` as a binary frame (base64 in a JSON envelope in some versions);
    - KJNodes ModelPreviewOverrideKJ (what DEAS's enhanced preview installs): a JSON
      `kj_preview_override` event whose data.image is a base64 JPEG. Counting only b_preview
      silently reported 0 previews for a feature that was streaming them (measured 2026-11-19:
      9 kj_preview_override events during an 8-step H3 run).
    """

    PREVIEW_TYPES = ('b_preview', 'preview_with_metadata', 'kj_preview_override')

    def __init__(self, base, client_id='gpu-intent-driver'):
        self.ws_url = base.replace('http://', 'ws://') + f'/ws?clientId={client_id}'
        self.counts, self._stop = {}, threading.Event()
        self.previews, self.preview_bytes = 0, 0
        self.first_at, self.last_at = None, None
        self._thread = None
        self.error = None

    def _pump(self):
        try:
            from websockets.sync.client import connect
            with connect(self.ws_url, max_size=None, open_timeout=10) as ws:
                t0 = time.time()
                ws.timeout = 2.0
                while not self._stop.is_set():
                    try:
                        msg = ws.recv()
                    except Exception:            # read timeout: keep polling
                        continue
                    if isinstance(msg, (bytes, bytearray)):
                        self.counts['binary_preview_bytes'] = self.counts.get('binary_preview_bytes', 0) + len(msg)
                        self.counts['binary_preview'] = self.counts.get('binary_preview', 0) + 1
                    else:
                        try:
                            event = json.loads(msg)
                        except Exception:
                            event = {}
                        kind = event.get('type', '?')
                        self.counts[kind] = self.counts.get(kind, 0) + 1
                        if kind in self.PREVIEW_TYPES:
                            data = event.get('data')
                            image = data.get('image') if isinstance(data, dict) else data
                            payload = len(image) if isinstance(image, (bytes, bytearray, str)) else 0
                            if payload:
                                self.previews += 1
                                self.preview_bytes += payload
                                stamp = round(time.time() - t0, 1)
                                self.first_at = stamp if self.first_at is None else self.first_at
                                self.last_at = stamp
        except Exception as e:                   # observer must never fail a gate run
            self.error = f'{type(e).__name__}: {e}'

    def __enter__(self):
        self._thread = threading.Thread(target=self._pump, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, *exc):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)
        return False

    def summary(self):
        previews = self.previews or (self.counts.get('b_preview', 0) + self.counts.get('binary_preview', 0))
        return {'previews': previews, 'first_preview_seconds': self.first_at,
                'last_preview_seconds': self.last_at, 'preview_base64_bytes': self.preview_bytes,
                'messages': self.counts, 'error': self.error}



def stage_replace(args, scratch, outdir, logbuf, wanted):
    """UX-22c inputs at the shared geometry: 832x480 (scale to cover, centre crop), 24 fps, first 5.2 s.

    Every candidate and every metric then sees the same pixels. Without --replace-frame the staged first
    frame is written to the session folder for the image Replace wizard, and the session stops before
    starting a backend.
    """
    if not wanted:
        return {}
    if not args.replace_clip:
        log(logbuf, 'NOTE: UX-22c gates need --replace-clip and --replace-frame; they are skipped')
        return {}
    w, h = REPLACE_SIZE
    fit = f'scale={w}:{h}:force_original_aspect_ratio=increase,crop={w}:{h},fps=24'
    clip = scratch / 'input' / REPLACE_SOURCE
    out = sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(Path(args.replace_clip).expanduser()),
              '-t', '5.2', '-vf', fit, '-c:v', 'libx264', '-crf', '12', '-pix_fmt', 'yuv420p',
              '-c:a', 'aac', '-b:a', '192k', str(clip)])
    if out.returncode or not clip.is_file():
        raise SystemExit(f'cannot stage --replace-clip: {out.stderr.strip()[-300:]}')
    info = ffprobe(clip)
    log(logbuf, f"staged {REPLACE_SOURCE} from {Path(args.replace_clip).name}: {info.get('width')}x"
                f"{info.get('height')}, {info.get('frames')} frames at {info.get('fps')} fps, "
                f"audio={info.get('audio')}")
    if not info.get('audio'):
        log(logbuf, '  note: the clip has no sound; B carries no audio reference and "has audio" checks '
                    'describe generated sound only')
    if not args.replace_frame:
        first = outdir / 'replace-source-first-frame.png'
        sh(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', str(clip), '-frames:v', '1', str(first)])
        log(logbuf, f'wrote {first}: run the image Replace wizard on it, then pass the result as '
                    '--replace-frame (and its mask as --replace-mask). Nothing was started.')
        return {'stop': True}
    frame = scratch / 'input' / REPLACE_FRAME
    im = Image.open(Path(args.replace_frame).expanduser()).convert('RGB')
    if abs(im.width / im.height - w / h) > 0.02:
        log(logbuf, f'  note: --replace-frame is {im.width}x{im.height}, not the {w}:{h} canvas aspect; '
                    'it is centre-cropped like the clip')
    scale = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * scale)), max(h, round(im.height * scale))), Image.LANCZOS)
    left, top = (im.width - w) // 2, (im.height - h) // 2
    im.crop((left, top, left + w, top + h)).save(frame, 'PNG')
    log(logbuf, f'staged {REPLACE_FRAME} ({w}x{h}) from {Path(args.replace_frame).name}')
    ctx = {'replace_source': str(clip), 'replace_frame': str(frame)}
    if args.replace_mask:
        ctx['replace_mask'] = str(Path(args.replace_mask).expanduser())
        log(logbuf, f'replace mask: {Path(args.replace_mask).name} (area metrics on)')
    return ctx


def install_marker_test():
    """Temporary ignored Rust test that prints compile(&DEAS_INTENT). Auto-removed in cleanup."""
    path = SRC_TAURI / 'src' / 'jobs_video_tests.rs'
    body = f'''
{MARKER}
#[ignore]
#[test]
fn print_compiled_intent() {{
    let raw = std::env::var("DEAS_INTENT").expect("DEAS_INTENT");
    let intent: serde_json::Value = serde_json::from_str(&raw).expect("intent json");
    let graph = crate::jobs::compile(&intent).expect("compile");
    println!("COMPILED_INTENT_MARKER {{}}", serde_json::to_string(&graph).unwrap());
}}
'''
    orig = path.read_text(encoding='utf-8')
    if 'print_compiled_intent' not in orig:
        path.write_text(orig + body, encoding='utf-8')
    return path, orig


def remove_marker_test(path, orig):
    if path.read_text(encoding='utf-8') != orig:
        path.write_text(orig, encoding='utf-8')


def compile_intent(intent, logbuf):
    env = {**os.environ, 'DEAS_INTENT': json.dumps(intent)}
    out = sh(['cargo', 'test', '--lib', 'print_compiled_intent', '--', '--ignored', '--nocapture'],
             cwd=SRC_TAURI, env=env)
    for line in out.stdout.splitlines():
        if line.startswith('COMPILED_INTENT_MARKER '):
            return json.loads(line[len('COMPILED_INTENT_MARKER '):])
    tail = (out.stdout + out.stderr).strip().splitlines()[-4:]
    raise RuntimeError('compile failed: ' + ' | '.join(tail))


def http_json(base, path, body=None, timeout=60):
    req = urllib.request.Request(base + path,
                                 data=json.dumps(body).encode() if body is not None else None,
                                 headers={'Content-Type': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


# --------------------------------------------------------------------------- session
def run_checks(gate, files, ctx, logbuf):
    """Turn each gate's acceptance note into measured numbers."""
    checks = []
    if not files:
        return checks
    try:
        for label, expected, actual, ok in (gate['check'](files, ctx) if gate.get('check') else []):
            checks.append({'label': label, 'expected': str(expected), 'actual': str(actual), 'ok': bool(ok)})
            log(logbuf, f"  {'OK  ' if ok else 'FAIL'} {gate['name']}: {label}: expected {expected}, got {actual}")
    except Exception as e:
        log(logbuf, f"  WARN {gate['name']}: verifier error {type(e).__name__}: {e}")
    return checks


def session_notes(results, adapters_backup):
    """What a reader must know to interpret this session at all."""
    notes = []
    if adapters_backup:
        notes.append(f'backend adapters: {len(adapters_backup)} shipped adapter(s) were replaced by '
                     'the repo sources for this run and restored afterwards '
                     '(hashes in adapters/manifest.json) - the verdicts describe repo code, not the '
                     'installed release')
    else:
        notes.append('backend adapters: the installed (released) copies ran unmodified')
    if any('websocket' in (r or {}) for r in results):
        notes.append('a /ws preview observer was attached; a zero count can mean either no '
                     'previews or an observer problem, so check the recorded message types')
    return notes


def render_summary(results, logbuf, notes=()):
    lines = ['| gate | item | verdict | seconds | VRAM peak | RAM peak | files |',
             '|---|---|---|---|---|---|---|']
    if notes:
        lines += ['', '## Session notes', ''] + [f'- {note}' for note in notes]
    for r in results:
        verdict = r.get('verdict') or r.get('status')
        files = r.get('files', [])
        lines.append(f"| {r.get('name')} | {r.get('item','')} | {verdict} | {r.get('seconds','')} "
                     f"| {r.get('vram_peak_mib','')} | {r.get('ram_peak_gib','')} | {len(files)} |")
    sampled = [r for r in results if r.get('memory_watch')]
    if sampled:
        lines += ['', '## Sampled memory (2 s interval)', '']
        for r in sampled:
            mw = r['memory_watch']
            lines.append(f"- {r.get('name')}: VRAM {mw['vram_mib']} MiB, RAM {mw['ram_gib']} GiB "
                         f"(baseline {mw.get('baseline_ram_gib')}, growth +{mw.get('ram_growth_gib')}), "
                         f"swap {mw['swap_gib']} GiB (baseline {mw.get('baseline_swap_gib')}, growth "
                         f"+{mw.get('swap_growth_gib')}), backend RSS {mw.get('backend_rss_gib')} GiB, "
                         f"swap pages in/out {mw.get('swap_pages')}, THP {mw.get('thp_gib')} GiB, "
                         f"zswap {mw.get('zswap')}")
            for point in mw.get('growth') or ():
                lines.append(f"  - {point}")
    measured = [r for r in results if r.get('checks')]
    if measured:
        lines += ['', '## Measured acceptance checks', '']
        for r in measured:
            lines.append(f"### {r.get('name')} ({r.get('item')})")
            for c in r['checks']:
                lines.append(f"- {'OK' if c['ok'] else '**FAIL**'} {c['label']}: "
                             f"expected {c['expected']}, measured {c['actual']}")
            if r.get('websocket'):
                ws = r['websocket']
                lines.append(f"- websocket during run: previews={ws.get('previews')} "
                             f"first at T+{ws.get('first_preview_seconds')}s messages={ws.get('messages')}")
            if r.get('error'):
                lines.append(f"- run error: {r['error']}")
            lines.append('')
    accepted = [r['name'] for r in results if r.get('verdict') == 'ACCEPTED']
    failed = [r['name'] for r in results if str(r.get('verdict', '')).startswith(('CHECKS', 'RUN_'))]
    lines += ['', f"ACCEPTED ({len(accepted)}): {', '.join(accepted) or '-'}",
              f"NOT ACCEPTED ({len(failed)}): {', '.join(failed) or '-'}"]
    return lines


def replay(session_dir, logbuf):
    """Re-run the verifiers over an existing session (no GPU, no backend)."""
    session = Path(session_dir)
    results = []
    by_name = {}
    ctx = {'outdir': session, 'by_name': by_name, 'observations': {}}
    for line in (session / 'results.jsonl').read_text(encoding='utf-8').splitlines():
        r = json.loads(line)
        gate = next((g for g in GATES if g['name'] == r['name']), None)
        if not gate:
            continue
        r['item'] = r.get('item') or gate['item']
        files = [str(session / 'scratch' / 'output' / f) for f in r.get('files', [])]
        files = [f for f in files if Path(f).exists()]
        by_name[r['name']] = {'files': files, 'result': r}
        checks = run_checks(gate, files, ctx, logbuf)
        r['checks'] = checks
        r['files'] = files
        if r.get('status') != 'success':
            r['verdict'] = 'RUN_ERROR'
        elif checks and all(c['ok'] for c in checks):
            r['verdict'] = 'ACCEPTED'
        elif checks:
            r['verdict'] = 'CHECKS_FAILED'
        else:
            r['verdict'] = 'measured (no automated check)'
        results.append(r)
    lines = render_summary(results, logbuf)
    names = {r['name'] for r in results}
    caveats = []
    if 'V-16-regenerate-2k-untiled' in names:
        caveats.append('V-16: a replay cannot re-check the compiled graph. If this session predates the '
                       'spatialTiling:false fix, that run was TILED and its ACCEPTED verdict only covers '
                       'the tiled path (see backend.log: spatial_tiling=True).')
    if 'V-03-enhanced-preview' in names and not ctx['observations']:
        caveats.append('V-03: this session recorded no websocket observer, so live-preview delivery is '
                       'unevidenced; re-run to capture it.')
    if 'MD-01-lying-sigma' in names and 'MD-01b-sigma-control' not in names:
        caveats.append('MD-01: the factor-0.0 control (MD-01b) was not part of this session, so the '
                       'lying-sigma A/B is incomplete.')
    if caveats:
        lines += ['', '## Replay caveats', ''] + [f'- {c}' for c in caveats]
    (session / 'summary-verified.md').write_text('\n'.join(lines) + '\n', encoding='utf-8')
    (session / 'results-verified.jsonl').write_text(
        '\n'.join(json.dumps(r) for r in results) + '\n', encoding='utf-8')
    return results


# The throwaway backend loads custom_nodes from the owned environment, which can trail the repo.
# Syncing the adapter sources DEAS itself ships (backend.rs: src/<name>.py -> deas_<name>.py)
# keeps a gate from silently testing released adapter code instead of the change under review -
# that is what happened to the P-02 readback fix on 2026-11-19. Originals come back in every path.
SHIPPED_ADAPTERS = ('h3_stream_video', 'image_prompting', 'image_postprocess', 'sam3_video_window',
                    'lying_sigma', 'output_naming', 'running_interrupt')


def _restore_pairs(pairs):
    """Write installed adapter bytes back; consumes the list so a second call is a no-op."""
    while pairs:
        dest, original = pairs.pop(0)
        try:
            if original is None:
                dest.unlink(missing_ok=True)
            else:
                dest.write_bytes(original)
        except OSError as error:
            print(f'WARNING: could not restore {dest}: {error}')


def sync_adapters(logbuf, outdir, enabled=True):
    """Stage the repo adapters into the backend before startup, keeping backups + hashes."""
    import atexit
    import hashlib
    if not enabled:
        return []
    backup, manifest = [], []
    keep = outdir / 'adapters'
    keep.mkdir(parents=True, exist_ok=True)
    for name in SHIPPED_ADAPTERS:
        repo = SRC_TAURI / 'src' / f'{name}.py'
        if not repo.is_file():
            continue
        dest = COMFY / 'custom_nodes' / f'deas_{name}.py'
        repo_bytes = repo.read_bytes()
        old = dest.read_bytes() if dest.is_file() else None
        entry = {'node': f'deas_{name}.py', 'repo_sha256': hashlib.sha256(repo_bytes).hexdigest(),
                 'installed_sha256': None if old is None else hashlib.sha256(old).hexdigest(),
                 'synced': old != repo_bytes}
        manifest.append(entry)
        if entry['synced']:
            (keep / f'deas_{name}.py').write_bytes(repo_bytes)
            if old is not None:
                (keep / f'deas_{name}.py.installed-backup').write_bytes(old)
            dest.write_bytes(repo_bytes)
            backup.append((dest, old))
            log(logbuf, f"synced adapter deas_{name}.py: backend "
                        f"{(entry['installed_sha256'] or 'absent')[:12]} -> repo "
                        f"{entry['repo_sha256'][:12]} ({len(repo_bytes)} bytes)")
    (keep / 'manifest.json').write_text(json.dumps(manifest, indent=1), encoding='utf-8')
    if backup:
        atexit.register(_restore_pairs, backup)
        log(logbuf, f'NOTE: {len(backup)} adapter(s) in the owned backend were replaced by repo '
                    f'sources for this run (restored afterwards); evidence: {keep}/manifest.json')
    return backup


def restore_adapters(backup, logbuf):
    if not backup:
        return
    count = len(backup)          # _restore_pairs consumes the list
    _restore_pairs(backup)
    try:
        log(logbuf, f'restored {count} backend adapter(s) to their installed bytes')
    except Exception:  # atexit can run after the log stream is gone
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--all', action='store_true')
    ap.add_argument('--only', help='comma list of gate names or plan ids, e.g. V-14,P-02-stream-362f')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--replay', metavar='SESSION_DIR',
                    help='re-verify an existing artifacts/verification/gpu-acceptance-* session '
                         'with the current verifiers; starts nothing')
    ap.add_argument('--precheck', action='store_true', help='compile-only, does not touch the GPU')
    ap.add_argument('--backend-args', default='', help='extra ComfyUI start-up flags for a '
                        'measured A/B, e.g. --backend-args "--cache-lru 1" (session flags are '
                        'protected)')
    ap.add_argument('--no-adapter-sync', action='store_true',
                        help='run against the installed backend adapter copies instead of the '
                             'repo sources')
    ap.add_argument('--keep-backend', action='store_true', help='leave the throwaway backend up for manual follow-ups')
    ap.add_argument('--max-util', type=int, default=25,
                    help='GPU utilization %% ceiling for the idle check (default 25)')
    ap.add_argument('--max-app-mib', type=int, default=1024,
                    help='a non-desktop process holding more than this many MiB blocks the run '
                         '(default 1024; the compositor/browsers are always ignored)')
    ap.add_argument('--samples', type=int, default=3, help='utilization samples for the idle check')
    ap.add_argument('--force', action='store_true', help='start even if the GPU looks busy')
    ap.add_argument('--face-image', help='portrait for the face-refinement gate (default: a '
                                         'head-and-shoulders crop of --probe-image)')
    ap.add_argument('--probe-image', help='picture used as the H3 reference (default: the largest '
                                          'photo in the AI-Ressources input tree, second-largest as reference B)')
    ap.add_argument('--replace-clip', help='UX-22c: source video for the Replace-for-videos comparison; '
                                           'staged as 832x480, 24 fps, first 5.2 s, sound kept')
    ap.add_argument('--replace-frame', help='UX-22c: the replaced first frame (the image Replace wizard run on '
                                            'the staged first frame); without it the session writes that first '
                                            'frame to the session folder and stops')
    ap.add_argument('--replace-mask', help='UX-22c: optional white-on-black mask of the replaced region on the '
                                           'first frame; enables the inside/outside area metrics')
    ap.add_argument('--replace-prompt', help='UX-22c: prompt describing the shot with the replacement '
                                             '(all three candidates get the same text)')
    ap.add_argument('--replace-size', default='832x480',
                    help='UX-22c: shared canvas WxH, both edges multiples of 32 (H3 and LTX grid); '
                         'use 480x832 for portrait clips')
    ap.add_argument('--replace-source-strength', type=float, default=0.6,
                    help='UX-22c: source guide strength of candidate C (LTX v2v), 0-1, default 0.6')
    ap.add_argument('--dry-run', action='store_true',
                    help='start the throwaway backend with --cpu, prove startup and paths, then stop; '
                         'no model runs and no GPU allocation (safe while another app holds the card)')
    args = ap.parse_args()
    global REPLACE_SOURCE_STRENGTH, REPLACE_SIZE, REPLACE_PROMPT
    if args.replace_prompt:
        REPLACE_PROMPT = args.replace_prompt.strip()
    try:
        REPLACE_SIZE = tuple(int(n) for n in args.replace_size.lower().split('x'))
        assert len(REPLACE_SIZE) == 2 and all(256 <= n <= 2048 and n % 32 == 0 for n in REPLACE_SIZE)
    except (ValueError, AssertionError):
        ap.error('--replace-size must be WxH with both edges multiples of 32 between 256 and 2048')
    if not 0.0 <= args.replace_source_strength <= 1.0:
        ap.error('--replace-source-strength must be between 0 and 1')
    REPLACE_SOURCE_STRENGTH = args.replace_source_strength
    for flag in ('replace_clip', 'replace_frame', 'replace_mask'):
        value = getattr(args, flag)
        if value and not Path(value).expanduser().is_file():
            ap.error(f'--{flag.replace("_", "-")} is not a file: {value}')
    if args.replace_frame and not args.replace_clip:
        ap.error('--replace-frame needs --replace-clip (the frame is compared against that clip)')
    if args.replay:
        replay(args.replay, [])
        print(f'verified: {Path(args.replay) / "summary-verified.md"}')
        raise SystemExit(0)

    if args.list:
        for g in GATES:
            print(f"{g['name']:32} item={g['item']:10} draft={g['draft']}  {g['note']}")
        return

    if not args.all and not args.only and not args.precheck and not args.dry_run:
        ap.error('choose --all, --only <gates>, --precheck, --dry-run or --list')

    wanted = set()
    if args.all or args.precheck:
        wanted = {g['name'] for g in GATES}
    if args.only:
        for tok in args.only.split(','):
            tok = tok.strip()
            want = {g['name'] for g in GATES if g['name'] == tok or g['item'].split('/')[0] == tok or g['item'] == tok}
            if not want:
                raise SystemExit(f'unknown gate: {tok} (see --list)')
            wanted |= want

    missing = []
    if ENV is None:
        missing.append('the DEAS-owned ComfyUI environment (needs ComfyUI/main.py + venv/bin/python + '
                       'deas-models.yaml); looked in /data/GitHub/deas-environment, ~/GitHub, ~/dev; '
                       'set DEAS_ENV=/path/to/deas-environment')
    else:
        for what, path in (('venv python', VENV_PY), ('deas-models.yaml', MODELS_YAML)):
            if not path.exists():
                missing.append(f'{what} missing at {path}')
    if RESOURCES is None:
        missing.append('the AI-Ressources tree (models/input); set DEAS_RESOURCES=/path/to/AI-Ressources')
    if missing:
        raise SystemExit('cannot run: ' + '; '.join(missing))

    ts = dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    outdir = OUT_ROOT / f'gpu-acceptance-{ts}'
    outdir.mkdir(parents=True, exist_ok=True)
    logbuf = []
    log(logbuf, f'session dir: {outdir}')
    deps = {name: (importlib.util.find_spec(name) is not None)
            for name in ('numpy', 'PIL', 'websockets')}
    log(logbuf, 'verifier dependencies: ' + ', '.join(f'{k}={"yes" if v else "MISSING"}'
                                                      for k, v in deps.items()))
    if not deps['websockets']:
        log(logbuf, '  note: no websockets module -> the V-03 preview observer cannot record; run this '
                    'script with the python that has websockets installed (e.g. your conda python), '
                    'or pip install websockets into the interpreter you use')

    # GPU gate (skipped for --precheck)
    backend = None
    base = None
    adapters_backup = []   # --precheck never syncs adapters; the summary still reports them
    replace_ctx = {}
    if not args.precheck:
        st = gpu_state()
        if st is None:
            raise SystemExit('nvidia-smi gave no GPU data; is the NVIDIA driver up? Nothing was started.')
        blockers = ([] if args.dry_run else
                    gpu_blockers(args.max_util, args.max_app_mib, samples=args.samples))
        if args.dry_run:
            log(logbuf, 'dry run: CPU-only backend, the GPU-busy gate is skipped on purpose')
        holders = ', '.join(f'{h[1]}={h[2]}MiB' for h in st[2]) or 'none'
        detail = f'util={st[0]}% used={st[1]} MiB; holders: {holders}'
        if blockers and not args.dry_run:
            if args.force:
                log(logbuf, f'GPU busy but --force given: {"; ".join(blockers)}')
            else:
                log(logbuf, 'GPU busy: ' + '; '.join(blockers))
                log(logbuf, 'context: ' + detail)
                raise SystemExit('Nothing was started. Close the listed process (never kill foreign '
                                 'backends for you), or re-run when free. Flags: --max-util, '
                                 '--max-app-mib, --force (run anyway).')
        log(logbuf, f'GPU free enough: {detail}')
        host = host_memory_state()
        if host:
            log(logbuf, host['summary'])
            critical = any(g.get('memory_watch') for g in GATES if g['name'] in wanted)
            reason = headroom_refusal(host, critical, dry_run=args.dry_run, force=args.force)
            if reason:
                raise SystemExit(reason)
        port = pick_port()
        scratch = outdir / 'scratch'
        for sub in ('input', 'output', 'temp'):
            (scratch / sub).mkdir(parents=True, exist_ok=True)
        # stage a probe picture from the owner's input pool (copy, never move)
        input_dir = RESOURCES / 'input'
        if args.probe_image:
            pool = [Path(args.probe_image).expanduser()]
            if not pool[0].is_file():
                raise SystemExit(f'--probe-image not a file: {pool[0]}')
        else:
            pool = [f for f in input_dir.rglob('*')
                    if f.is_file() and f.suffix.lower() in ('.png', '.jpg', '.jpeg', '.webp')
                    and 300_000 < f.stat().st_size < 20 * 1024 * 1024]
            # largest first: photos, not icons/pictos or alpha masks
            pool.sort(key=lambda f: f.stat().st_size, reverse=True)
        if not pool:
            raise SystemExit(f'no probe images in {input_dir}; pass --probe-image /path/to/photo.png')
        (scratch / 'input' / 'deas-inputs').mkdir(parents=True, exist_ok=True)
        def stage(src, name):
            # intents name 'deas-inputs/<file>' (the Director's reference folder convention)
            dst = scratch / 'input' / 'deas-inputs' / name
            try:  # normalize: RGB only, <= 1536 px — H3 references never need 20 MB RGBA scans
                from PIL import Image
                im = Image.open(src)
                im = im.convert('RGB')
                im.thumbnail((1536, 1536))
                im.save(dst, 'PNG')
                log(logbuf, f'staged {name} from {src.name} ({im.size[0]}x{im.size[1]}, RGB)')
            except Exception as e:
                shutil.copy2(src, dst)
                log(logbuf, f'staged {name} from {src.name} verbatim (no PIL normalization: {e})')
        stage(pool[0], 'acceptance-a.png')
        if len(pool) > 1:
            stage(pool[1], 'acceptance-b.png')
        # Face-refinement gates need a real face: derive a head-and-shoulders crop from the first
        # reference (or take --face-image). A full-body or landscape reference makes
        # DEAS_H3FaceRefine lock onto a 48 px nothing, and the gate then proves nothing.
        face_src = Path(args.face_image).expanduser() if args.face_image else pool[0]
        try:
            from PIL import Image
            im = Image.open(face_src).convert('RGB')
            w, h = im.size
            crop = im.crop((int(w * 0.25), 0, int(w * 0.85), int(h * 0.5)))
            crop = crop if crop.width >= 128 and crop.height >= 128 else im
            crop.thumbnail((1024, 1024))
            crop.save(scratch / 'input' / 'deas-inputs' / 'acceptance-face.png', 'PNG')
            log(logbuf, f'staged acceptance-face.png from {face_src.name} ({crop.size[0]}x{crop.size[1]})')
        except Exception as e:
            log(logbuf, f'NOTE: no face probe ({type(e).__name__}: {e}); P-03 cannot run meaningfully')
        else:
            log(logbuf, 'NOTE: only one probe picture staged; the two-reference gate (V-02) needs a '
                        'second one — pass --probe-image and use --only without V-02, or add input photos')

        replace_ctx = stage_replace(args, scratch, outdir, logbuf,
                                    any(g.get('replace') for g in GATES if g['name'] in wanted))
        if replace_ctx.get('stop'):
            (outdir / 'session.log').write_text('\n'.join(logbuf) + '\n', encoding='utf-8')
            return
        adapters_backup = sync_adapters(logbuf, outdir, enabled=not args.no_adapter_sync)
        extra = shlex.split(args.backend_args)
        protected = {'--port', '--listen', '--output-directory', '--input-directory',
                     '--temp-directory', '--extra-model-paths-config', '--cpu'}
        clashes = [a for a in extra if a in protected]
        if clashes:
            raise SystemExit(f'--backend-args may not override session flags: {clashes}')
        if extra:
            log(logbuf, f'backend extra args: {extra} (A/B experiment; the verdicts below apply '
                        'to that configuration)')
        backend = subprocess.Popen(
            [str(VENV_PY), '-u', 'main.py'] + (['--cpu'] if args.dry_run else []) + extra +
            ['--port', str(port), '--listen', '127.0.0.1',
             '--extra-model-paths-config', str(MODELS_YAML),
             '--input-directory', str(scratch / 'input'),
             '--output-directory', str(scratch / 'output'),
             '--temp-directory', str(scratch / 'temp')],
            cwd=COMFY, stdout=open(outdir / 'backend.log', 'w'), stderr=subprocess.STDOUT)
        base = f'http://127.0.0.1:{port}'
        for _ in range(90):
            try:
                http_json(base, '/system_stats'); break
            except Exception:
                time.sleep(2)
        else:
            backend.terminate()
            raise SystemExit('throwaway backend never became ready; see backend.log')
        log(logbuf, f'throwaway backend ready on :{port} (pid {backend.pid})')
        if args.dry_run:
            nodes = http_json(base, '/object_info')
            log(logbuf, f'dry run: backend answered /object_info with {len(nodes)} nodes; '
                        'no gate was submitted. Paths, port, scratch dirs and startup all work.')
            backend.terminate()
            try:
                backend.wait(10)
            except subprocess.TimeoutExpired:
                backend.kill()
            restore_adapters(adapters_backup, logbuf)
            log(logbuf, 'dry run finished: throwaway backend stopped and adapters restored.')
            (outdir / 'session.log').write_text('\n'.join(logbuf) + '\n', encoding='utf-8')
            return

    marker_path, marker_orig = install_marker_test()
    results = []
    try:
        # phase 1: compile all selected intents against the current compiler
        index = model_index()
        compiled = {}
        for g in GATES:
            if g['name'] not in wanted:
                continue
            if g.get('replace') and not args.precheck and not replace_ctx.get('replace_frame'):
                log(logbuf, f"SKIP {g['name']}: needs --replace-clip and --replace-frame")
                results.append(dict(name=g['name'], item=g['item'], status='skip_missing_input',
                                    error='--replace-clip/--replace-frame not given'))
                continue
            intent = g['intent']()
            miss = missing_models(intent, index)
            if miss:
                log(logbuf, f"SKIP {g['name']}: missing model files: {', '.join(miss)}")
                results.append(dict(name=g['name'], item=g['item'], status='skip_missing_model',
                                    error='; '.join(miss)))
                continue
            try:
                graph = compile_intent(intent, logbuf)
                compiled[g['name']] = graph
                bad = []
                for check in (g.get('graph_checks')(graph) if g.get('graph_checks') else []):
                    desc, ok = check
                    log(logbuf, f"  graph {'OK  ' if ok else 'FAIL'} {g['name']}: {desc}")
                    if not ok:
                        bad.append(desc)
                if bad:
                    results.append(dict(name=g['name'], item=g['item'], status='graph_check_fail',
                                        error='; '.join(bad)))
                    continue
                log(logbuf, f"COMPILE OK   {g['name']}")
            except Exception as e:
                log(logbuf, f"COMPILE FAIL {g['name']}: {e}")
                results.append(dict(name=g['name'], item=g['item'], status='compile_fail', error=str(e)[:400]))
        if args.precheck:
            log(logbuf, 'precheck finished (no GPU work submitted)')
        else:
            # phase 2: real runs, dependency order (cheapest first, P-02 monster last)
            sys.path.insert(0, str(DRIVER_SRC.parent))
            from gpu_intent_driver import Driver  # skill driver

            class SessionDriver(Driver):
                """Feed the already-compiled graph to the driver instead of recompiling.

                The driver's own compile() looks for a stdout line starting with '{', while our
                temporary Rust test prints `COMPILED_INTENT_MARKER {...}`; letting it recompile
                would raise StopIteration with no message. Phase 1 already produced the graph,
                so pass it through and keep the driver's sampling/recording untouched.
                """
                precompiled = None

                def compile(self, intent):
                    return self.precompiled

            drv = SessionDriver(base, str(SRC_TAURI), str(outdir / 'results.jsonl'))
            ctx = {'outdir': outdir, 'by_name': {}, 'observations': {}, **replace_ctx}
            for g in GATES:
                if g['name'] not in wanted or g['name'] not in compiled:
                    continue
                log(logbuf, f"RUN  {g['name']} ({g['item']}) — {g['note']}")
                obs = PreviewObserver(base) if g.get('observe') else None
                watch = MemoryWatch(backend.pid if backend else None) if g.get('memory_watch') else None
                try:
                    drv.precompiled = compiled[g['name']]
                    if obs:
                        with obs:
                            r = drv.run(g['name'], g['intent'](), timeout=g.get('timeout', 7200))
                        ctx['observations'][g['name']] = obs.summary()
                        r['websocket'] = obs.summary()
                    elif watch:
                        with watch:
                            r = drv.run(g['name'], g['intent'](), timeout=g.get('timeout', 7200))
                        r['memory_watch'] = dict(watch.peak, swap_pages=watch.swap_pages,
                                                 growth=watch.growth_points())
                        watch.csv(outdir / f'memory-{g["name"]}.csv')
                        ctx['by_name'][g['name']] = {'files': [], 'result': r}
                    else:
                        r = drv.run(g['name'], g['intent'](), timeout=g.get('timeout', 7200))
                    files = [str(outdir / 'scratch' / 'output' / f) for f in r.get('files', [])]
                    ctx['by_name'][g['name']] = {'files': files, 'result': r}
                    checks = run_checks(g, files, ctx, logbuf)
                    r['checks'] = checks
                    r['files'] = files
                    results.append(r)
                    failed = [c['label'] for c in checks if not c['ok']]
                    if r.get('status') != 'success':
                        verdict = 'RUN_ERROR'
                    elif not checks:
                        verdict = 'measured (no automated check)'
                    elif failed:
                        verdict = 'CHECKS_FAILED: ' + '; '.join(failed)
                    else:
                        verdict = 'ACCEPTED'
                    r['verdict'] = verdict
                    log(logbuf, f"DONE {g['name']}: status={r.get('status')} {r['seconds']}s "
                                f"vram={r['vram_peak_mib']}MiB ram={r['ram_peak_gib']}GiB "
                                f"files={len(files)} -> {verdict}")
                except Exception as e:
                    log(logbuf, f"RUN FAIL {g['name']}: {type(e).__name__}: {e}")
                    results.append(dict(name=g['name'], item=g['item'], status='run_fail',
                                        verdict='RUN_EXCEPTION', error=f'{type(e).__name__}: {e}'[:400]))
                if obs and obs.error:
                    log(logbuf, f"  preview observer: {obs.error}")
    finally:
        remove_marker_test(marker_path, marker_orig)
        sh(['cargo', 'fmt', '--quiet', str(marker_path)])
        if backend and (args.dry_run or not args.keep_backend):
            backend.terminate()
            try:
                backend.wait(10)
            except subprocess.TimeoutExpired:
                backend.kill()
            log(logbuf, 'throwaway backend stopped')
        # cleanup probe artifacts the Director may leave in the refmods root
        refmods = RESOURCES / 'models/refmods'
        if refmods.is_dir():
            for f in refmods.glob('deas-probe-*'):
                f.unlink(missing_ok=True)
                log(logbuf, f'cleaned {f.name}')
        summary = render_summary(results, logbuf, notes=session_notes(results, adapters_backup))
        summary.append('\nDraft-gated items (check the intent shape against the PLAN item before trusting): '
                       + ', '.join(g['name'] for g in GATES if g['draft'] and g['name'] in wanted))
        (outdir / 'summary.md').write_text('\n'.join(summary) + '\n', encoding='utf-8')
        (outdir / 'session.log').write_text('\n'.join(logbuf) + '\n', encoding='utf-8')
        print('\n'.join(summary))
        print(f'\nEvidence: {outdir}')


if __name__ == '__main__':
    main()
