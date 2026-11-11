"""Bounded, silent Core video acquisition for the manual DEAS SAM3 mask preview."""
import logging
import math
import os
import threading
from fractions import Fraction
from pathlib import Path
import sys


def cgroup_available(available, group, root):
    """Intersect every inherited v2 hard limit with the current OS available pool."""
    root = Path(root)
    if not group.startswith("/") or ".." in Path(group).parts:
        raise ValueError("SAM3_VIDEO_WINDOW: invalid cgroup memory hierarchy")
    current = root / group.lstrip("/")
    if not current.is_dir():
        raise ValueError("SAM3_VIDEO_WINDOW: cgroup memory hierarchy unavailable")
    while True:
        limit_file = current / "memory.max"
        if limit_file.exists():
            limit = limit_file.read_text().strip()
            if limit != "max":
                used = int((current / "memory.current").read_text().strip())
                limit = int(limit)
                if limit < 0 or used < 0:
                    raise ValueError("SAM3_VIDEO_WINDOW: invalid cgroup memory accounting")
                available = min(available, max(0, limit - used))
        if current == root:
            return available
        current = current.parent


def available_memory():
    import psutil
    available = psutil.virtual_memory().available
    if sys.platform.startswith("linux"):
        try:
            entries = Path("/proc/self/cgroup").read_text().splitlines()
            group = next(line.split("::", 1)[1] for line in entries if line.startswith("0::"))
            available = cgroup_available(available, group, "/sys/fs/cgroup")
        except (OSError, ValueError, StopIteration) as error:
            raise ValueError("SAM3_VIDEO_WINDOW: cannot verify Linux cgroup-v2 memory headroom; analysis refused") from error
    return available


# Serialize admission through acquisition: no second decoder spends an unmaterialized reservation.
_decode_lock = threading.Lock()
_log = logging.getLogger(__name__)


def window_plan(width, height, fps, frames, seconds, start, duration, max_objects, available):
    values = (width, height, fps, frames, seconds, start, duration, max_objects, available)
    if any(isinstance(v, bool) or not math.isfinite(v) for v in values):
        raise ValueError("SAM3_VIDEO_WINDOW: finite numeric metadata and window required")
    if (width <= 0 or height <= 0 or int(width) != width or int(height) != height
            or frames <= 0 or int(frames) != frames or seconds <= 0
            or start < 0 or duration <= 0 or not math.isfinite(start + duration)
            or start >= seconds or start + duration > seconds + 1e-9
            or not 1 <= max_objects <= 64 or int(max_objects) != max_objects):
        raise ValueError("SAM3_VIDEO_WINDOW: invalid source metadata or out-of-source window")
    if not 1 <= fps <= 120 or Fraction(fps) != Fraction(round(float(fps) * 1000), 1000):
        raise ValueError("SAM3_VIDEO_WINDOW: source fps cannot be preserved by Core CreateVideo (1..120, exact millisecond rate)")
    if abs(float(frames / fps) - seconds) > max(1e-6, 0.01 / float(fps)):
        raise ValueError("SAM3_VIDEO_WINDOW: unsupported variable-rate or inconsistent frame metadata")
    # Require exact frame boundaries; Core truncates second-based trim PTS otherwise.
    first, count = start * float(fps), duration * float(fps)
    if abs(first - round(first)) > 1e-6 or abs(count - round(count)) > 1e-6 or round(count) < 1:
        raise ValueError("SAM3_VIDEO_WINDOW: start and duration must align to source frames")
    count = int(round(count))
    # Incremental host estimate: acquisition/copies, union + RGB mask, encode staging;
    # packed 1008-square tracker masks including stack/copy, plus per-object working masks.
    pixels = int(width) * int(height)
    # TrackToMask unpacks the whole window before float conversion/interpolation.
    estimated = count * (pixels * 68 + 1008 * 1008 * 8 + 128) + count * max_objects * 1008 * 126 * 3 + max_objects * 1008 * 1008 * 16
    # Shot mode adds a CPU union destination and bounded float64 RGB scoring tiles.
    estimated += 128 * 128 * 3 * 8 * 3
    budget = int(available * 0.75)
    if available <= 0 or estimated > budget:
        raise ValueError(f"SAM3_VIDEO_WINDOW: estimated incremental host memory {estimated} bytes exceeds 75% of available memory ({budget} bytes); shorten the window or reduce maxObjects")
    return count, estimated, budget


def checked_packets(packets, time_base, fps, start, count, interrupt):
    """Fail closed on non-CFR/unknown packet timing without allocating decoded frames."""
    first = round(start * float(fps))
    seen = set()
    for packet in packets:
        interrupt()
        if packet.size == 0:
            continue
        if packet.pts is None or packet.dts is None:
            raise ValueError("SAM3_VIDEO_WINDOW: timestamped video packets required")
        frame_index = packet.pts * time_base * fps
        if frame_index.denominator != 1:
            raise ValueError("SAM3_VIDEO_WINDOW: variable-rate timestamps cannot preserve source fps")
        index = int(frame_index)
        if first <= index < first + count:
            if index in seen:
                raise ValueError("SAM3_VIDEO_WINDOW: duplicate frame timestamp")
            seen.add(index)
        # DTS, unlike PTS, is ordered for B-frame streams.
        if packet.dts * time_base * fps >= first + count:
            break
    if len(seen) != count:
        raise ValueError("SAM3_VIDEO_WINDOW: encoded window frame count differs from admitted metadata")


def checked_frames(frames, width, height, count, interrupt):
    seen = 0
    while True:
        interrupt()
        try:
            frame = next(frames)
        except StopIteration:
            break
        seen += 1
        if seen > count or tuple(frame.shape) != (height, width, 3):
            raise ValueError("SAM3_VIDEO_WINDOW: decoded frame count/dimensions differ from admitted metadata")
        yield frame
    if seen != count:
        raise ValueError("SAM3_VIDEO_WINDOW: decoded frame count differs from admitted metadata")


def source_identity(stat):
    return stat.st_dev, stat.st_ino, stat.st_size, stat.st_mtime_ns


class CheckedPacket:
    def __init__(self, packet, width, height, interrupt):
        self.packet, self.width, self.height, self.interrupt = packet, width, height, interrupt

    def __getattr__(self, name):
        return getattr(self.packet, name)

    def decode(self):
        video = self.packet.stream.type == "video"
        for frame in self.packet.decode():
            self.interrupt()
            if video and (frame.width, frame.height) != (self.width, self.height):
                raise ValueError("SAM3_VIDEO_WINDOW: decoded dimensions changed before RGB conversion")
            yield frame


class CheckedContainer:
    def __init__(self, container, width, height, interrupt):
        self.container, self.width, self.height, self.interrupt = container, width, height, interrupt

    def __getattr__(self, name):
        return getattr(self.container, name)

    def demux(self, *streams):
        for packet in self.container.demux(*streams):
            yield CheckedPacket(packet, self.width, self.height, self.interrupt)


class SAM3VideoWindow:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "video": ("VIDEO",),
            # Model loader precedes admission, so resident checkpoint pages are already accounted.
            "model": ("MODEL",),
            "start_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.7976931348623157e308}),
            "duration_seconds": ("FLOAT", {"default": 1.0, "min": 0.0, "max": 1.7976931348623157e308}),
            "max_objects": ("INT", {"default": 8, "min": 1, "max": 64}),
        }, "optional": {
            # Refinement keeps the source soundtrack; mask analysis never decodes audio.
            "include_audio": ("BOOLEAN", {"default": False}),
        }}
    RETURN_TYPES = ("VIDEO",)
    FUNCTION = "window"
    CATEGORY = "DEAS/internal"

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Memory availability and source identity must be rechecked on every explicit submission.
        return float("nan")

    def window(self, video, model, start_seconds, duration_seconds, max_objects, include_audio=False):
        import av
        import folder_paths
        import comfy.model_management as mm
        from comfy_api.latest import InputImpl
        from comfy.model_base import SAM3

        if not isinstance(video, InputImpl.VideoFromFile):
            raise ValueError("SAM3_VIDEO_WINDOW: a Core LoadVideo file is required")
        if not isinstance(getattr(model, "model", None), SAM3):
            raise ValueError("SAM3_VIDEO_WINDOW: selected checkpoint is not a Core SAM3 model")
        path = video.get_stream_source()
        if not isinstance(path, str):
            raise ValueError("SAM3_VIDEO_WINDOW: managed input file required")
        root = os.path.realpath(folder_paths.get_input_directory())
        real = os.path.realpath(path)
        if os.path.dirname(real) != root or not os.path.isfile(real):
            raise ValueError("SAM3_VIDEO_WINDOW: source must be a top-level managed input file")
        source_stat = os.stat(real)
        identity = source_identity(source_stat)
        with open(real, "rb") as source, av.open(source, mode="r") as container:
            if source_identity(os.fstat(source.fileno())) != identity:
                raise ValueError("SAM3_VIDEO_WINDOW: source changed during metadata admission")
            if len(container.streams.video) != 1:
                raise ValueError("SAM3_VIDEO_WINDOW: exactly one video stream required")
            stream = container.streams.video[0]
            if (not stream.average_rate or not stream.frames or stream.duration is None
                    or not stream.time_base or stream.start_time not in (0, None)):
                raise ValueError("SAM3_VIDEO_WINDOW: complete zero-origin frame metadata required before decode")
            width, height = stream.width, stream.height
            fps = Fraction(stream.average_rate)
            frames = stream.frames
            seconds = float(stream.duration * stream.time_base)
        # Window times are absolute in the full source file, not an inherited input trim.
        window_plan(width, height, fps, frames, seconds, start_seconds, duration_seconds,
                    max_objects, available_memory())
        # Bounds are already checked against admitted metadata. Core as_trimmed() reopens
        # the path for duration discovery and may decode before this guard is installed.

        class BoundedVideo(InputImpl.VideoFromFile):
            def _decode_frames(self, container, video_stream, audio_stream, audio_frames, alphas):
                # Core owns decode/color conversion/trim; masks never acquire source audio.
                # Limit codec surfaces as well as rejecting changed dimensions before RGB allocation.
                max_pixels = ((width + 63) // 64 * 64) * ((height + 63) // 64 * 64)
                video_stream.codec_context.options = {**video_stream.codec_context.options, "max_pixels": str(max_pixels)}
                checked = CheckedContainer(container, width, height, mm.throw_exception_if_processing_interrupted)
                frames_iter = super()._decode_frames(checked, video_stream, audio_stream if include_audio else None,
                                                     audio_frames if include_audio else [], alphas)
                yield from checked_frames(iter(frames_iter), width, height, self.admitted_frames,
                                          mm.throw_exception_if_processing_interrupted)

            def get_components(self):
                while not _decode_lock.acquire(timeout=0.1):
                    mm.throw_exception_if_processing_interrupted()
                try:
                    mm.throw_exception_if_processing_interrupted()
                    current = os.stat(real)
                    if (current.st_dev, current.st_ino, current.st_size, current.st_mtime_ns) != identity:
                        raise ValueError("SAM3_VIDEO_WINDOW: source changed after admission")
                    self.admitted_frames, estimated, budget = window_plan(
                        width, height, fps, frames, seconds, start_seconds, duration_seconds,
                        max_objects, available_memory())
                    # This is an incremental planning reservation, not allocated RAM or a VRAM guarantee.
                    # Available memory already excludes resident model/tensor pages; do not subtract them twice.
                    _log.info("SAM3_VIDEO_WINDOW admission frames=%d estimate_bytes=%d available_share_bytes=%d",
                              self.admitted_frames, estimated, budget)
                    # Probe and Core decode share one opened identity, not independently reopened paths.
                    with open(real, "rb") as source:
                        if source_identity(os.fstat(source.fileno())) != identity:
                            raise ValueError("SAM3_VIDEO_WINDOW: source changed before decode")
                        with av.open(source, mode="r") as probe:
                            stream = probe.streams.video[0]
                            if stream.time_base is None:
                                raise ValueError("SAM3_VIDEO_WINDOW: source time base changed")
                            probe.seek(int(start_seconds / stream.time_base), stream=stream)
                            checked_packets(probe.demux(stream), Fraction(stream.time_base), fps,
                                            start_seconds, self.admitted_frames,
                                            mm.throw_exception_if_processing_interrupted)
                            probe.seek(0)
                            components = self.get_components_internal(probe)
                        mm.throw_exception_if_processing_interrupted()
                        if source_identity(os.fstat(source.fileno())) != identity or source_identity(os.stat(real)) != identity:
                            raise ValueError("SAM3_VIDEO_WINDOW: source changed during decode")
                    if components.frame_rate != fps or components.images.shape[0] != self.admitted_frames:
                        raise ValueError("SAM3_VIDEO_WINDOW: Core changed admitted frame timing")
                    return components
                finally:
                    _decode_lock.release()

        return (BoundedVideo(real, start_time=start_seconds, duration=duration_seconds),)


def shot_boundaries(images, scene_threshold, tag):
    """Half-open shot boundaries of a float RGB window; None disables cut detection."""
    import torch
    import comfy.model_management as mm
    if (not isinstance(images, torch.Tensor) or images.ndim != 4
            or images.shape[3] != 3 or min(images.shape) <= 0
            or not images.is_floating_point()):
        raise ValueError(f"{tag}: nonempty floating RGB [N,H,W,3] required")
    n, h, w, _ = images.shape
    if scene_threshold is None:
        return [0, n]
    boundaries = [0]
    # Mean absolute RGB difference on original float [0,1] frames, cut at >= threshold.
    # shortcut: uncalibrated 0.3 heuristic (flashes also cut), not PySceneDetect; calibrate with footage.
    for frame in range(n):
        score = 0.0
        for y in range(0, h, 128):
            for x in range(0, w, 128):
                mm.throw_exception_if_processing_interrupted()
                tile = images[frame, y:y+128, x:x+128]
                if not torch.isfinite(tile).all().item() or tile.min().item() < 0 or tile.max().item() > 1:
                    raise ValueError(f"{tag}: RGB values must be finite in [0,1]")
                if frame:
                    # Convert tiles only; no full-window/frame RGB difference or contiguous copy.
                    delta = tile.to(dtype=torch.float64) - images[frame-1, y:y+128, x:x+128].to(dtype=torch.float64)
                    score += delta.abs_().sum().item()
                    del delta
        if frame and score / (h * w * 3) >= scene_threshold:
            boundaries.append(frame)
    boundaries.append(n)
    return boundaries


def track_shot(images, first, end, model, conditioning, detection_threshold, max_objects, detect_interval, tag):
    import torch
    import comfy.model_management as mm
    from comfy_extras.nodes_sam3 import SAM3_VideoTrack
    h, w = images.shape[1:3]
    # Each Core execute creates a fresh forward_video state, including detection cadence.
    track = SAM3_VideoTrack.execute(images=images[first:end], model=model,
        conditioning=conditioning, detection_threshold=detection_threshold,
        max_objects=max_objects, detect_interval=detect_interval).result[0]
    mm.throw_exception_if_processing_interrupted()
    if (not isinstance(track, dict) or track.get("orig_size") != (h, w)
            or track.get("n_frames") != end-first):
        raise ValueError(f"{tag}: tracker frame count/dimensions changed")
    packed = track.get("packed_masks")
    if packed is not None and (not isinstance(packed, torch.Tensor) or packed.ndim != 4
            or packed.dtype != torch.uint8 or packed.shape[0] != end-first
            or packed.shape[1] > max_objects or not 0 < packed.shape[2] <= 1008
            or not 0 < packed.shape[3] <= 126):
        raise ValueError(f"{tag}: invalid packed tracker shape")
    return track


class SAM3ShotMask:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "model": ("MODEL",),
            "conditioning": ("CONDITIONING",),
            "detection_threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0}),
            "max_objects": ("INT", {"default": 8, "min": 1, "max": 64}),
            "detect_interval": ("INT", {"default": 1, "min": 1, "max": 2147483647}),
            "scene_threshold": ("FLOAT", {"default": 0.3, "min": 5e-324, "max": 1.0}),
        }}
    RETURN_TYPES = ("MASK",)
    FUNCTION = "mask"
    CATEGORY = "DEAS/internal"

    def mask(self, images, model, conditioning, detection_threshold, max_objects,
             detect_interval, scene_threshold):
        import torch
        import comfy.model_management as mm
        from comfy_extras.nodes_sam3 import SAM3_TrackToMask

        if (isinstance(scene_threshold, bool) or not isinstance(scene_threshold, (int, float))
                or not math.isfinite(scene_threshold) or not 0 < scene_threshold <= 1):
            raise ValueError("SAM3_SHOT_MASK: scene_threshold must be finite in (0,1]")
        boundaries = shot_boundaries(images, scene_threshold, "SAM3_SHOT_MASK")
        n, h, w, _ = images.shape
        mm.throw_exception_if_processing_interrupted()
        masks = torch.empty((n, h, w), dtype=torch.float32, device="cpu")
        for shot, (first, end) in enumerate(zip(boundaries, boundaries[1:]), 1):
            mm.throw_exception_if_processing_interrupted()
            _log.info("DEAS_SAM3ShotMask shot=%d/%d window_relative_frames_zero_based_half_open=[%d,%d)", shot, len(boundaries)-1, first, end)
            track = track_shot(images, first, end, model, conditioning, detection_threshold,
                               max_objects, detect_interval, "SAM3_SHOT_MASK")
            packed = track.get("packed_masks")
            union = SAM3_TrackToMask.execute(track_data=track, object_indices="").result[0]
            if (not isinstance(union, torch.Tensor) or tuple(union.shape) != (end-first, h, w)
                    or not union.is_floating_point()):
                raise ValueError("SAM3_SHOT_MASK: union frame count/dimensions changed")
            for frame in range(end-first):
                for y in range(0, h, 128):
                    for x in range(0, w, 128):
                        mm.throw_exception_if_processing_interrupted()
                        tile = union[frame, y:y+128, x:x+128]
                        if not torch.isfinite(tile).all().item() or tile.min().item() < 0 or tile.max().item() > 1:
                            raise ValueError("SAM3_SHOT_MASK: union values must be finite in [0,1]")
                        masks[first+frame, y:y+128, x:x+128].copy_(tile)
            del union, track, packed
        mm.throw_exception_if_processing_interrupted()
        return (masks,)


H3_FPS = 24
# Square crop canvas on H3's 32-pixel grid at its 768 short edge (core nodes_minimax_h3 BASE_SHORT_EDGE).
H3_CANVAS = 768


def face_height(mask):
    """Tallest per-frame extent of a bool [m,H,W] track mask, in pixels (0 when never present)."""
    rows = mask.any(dim=2)
    return max((int(r.nonzero()[-1]) - int(r.nonzero()[0]) + 1 for r in rows if r.any()), default=0)


def crop_box(mask, crop_factor):
    """Fixed square crop of one tracked object over one shot; mask is bool [m,H,W].

    shortcut: one static box per shot and object (no moving crop), so a face crossing the
    frame gets a larger, lower-detail crop; upgrade to a stabilized moving crop when owners
    report wide-motion shots.
    """
    import torch
    m, height, width = mask.shape
    rows, cols = mask.any(dim=2), mask.any(dim=1)
    present = rows.any(dim=1)
    if not present.any():
        return None
    ys, xs = torch.nonzero(rows.any(dim=0)).flatten(), torch.nonzero(cols.any(dim=0)).flatten()
    y0, y1, x0, x1 = int(ys[0]), int(ys[-1]) + 1, int(xs[0]), int(xs[-1]) + 1
    # Context scales with the tallest per-frame face, as the reference's crop_factor does.
    face = face_height(mask)
    side = min(max(round(face * crop_factor), y1 - y0, x1 - x0), height, width)
    top = min(max((y0 + y1) // 2 - side // 2, 0), height - side)
    left = min(max((x0 + x1) // 2 - side // 2, 0), width - side)
    return top, left, side, present


def feather_mask(mask, radius):
    """Grow then soften a [m,h,w] mask by radius pixels so the stitch has no hard seam."""
    import torch.nn.functional as F
    out = mask[:, None].float()
    if radius > 0:
        k = 2 * radius + 1
        out = F.max_pool2d(out, k, stride=1, padding=radius)
        out = F.avg_pool2d(out, k, stride=1, padding=radius, count_include_pad=False)
    return out[:, 0].clamp(0, 1)


def shot_audio(audio, first, end, frames):
    """Soundtrack of frames [first,end), silent-padded to the H3 clip's frame count."""
    import torch.nn.functional as F
    wave, rate = audio["waveform"], audio["sample_rate"]
    a, b, total = (round(n * rate / H3_FPS) for n in (first, end, first + frames))
    clip = wave[..., a:min(b, wave.shape[-1])]
    return {"waveform": F.pad(clip, (0, max(0, total - a - clip.shape[-1])))[..., :total - a], "sample_rate": rate}


class H3FaceRefine:
    """Per shot and tracked face: square crop -> H3 partial denoise at 768 -> stitch back.

    Sampling uses the graph's own noise/guider/sampler/sigmas, so model loading, sigma shift
    and the denoise split stay house graph nodes; the source soundtrack is held (audio noise
    mask 0) so lip motion stays bound to it, and only the stitched video is returned.
    """
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "images": ("IMAGE",),
            "fps": ("FLOAT", {"default": 24.0, "min": 0.0, "max": 1000.0}),
            "sam_model": ("MODEL",),
            "sam_conditioning": ("CONDITIONING",),
            "detection_threshold": ("FLOAT", {"default": 0.5, "min": 0.0, "max": 1.0}),
            "max_objects": ("INT", {"default": 4, "min": 1, "max": 64}),
            "detect_interval": ("INT", {"default": 1, "min": 1, "max": 2147483647}),
            # 0 disables cut detection: the whole window is one shot.
            "scene_threshold": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0}),
            "noise": ("NOISE",),
            "guider": ("GUIDER",),
            "sampler": ("SAMPLER",),
            "sigmas": ("SIGMAS",),
            "vae": ("VAE",),
            "crop_factor": ("FLOAT", {"default": 2.5, "min": 1.2, "max": 8.0}),
            "feather": ("INT", {"default": 6, "min": 0, "max": 256}),
        }, "optional": {
            "audio": ("AUDIO",),
            "audio_vae": ("VAE",),
            # Faces never taller than this many pixels keep their original pixels (0 = refine all):
            # a tiny face upscaled to the 768 canvas costs a full H3 pass for little detail.
            "min_face": ("INT", {"default": 0, "min": 0, "max": 4096}),
        }}
    RETURN_TYPES = ("IMAGE",)
    FUNCTION = "refine"
    CATEGORY = "DEAS/internal"

    def refine(self, images, fps, sam_model, sam_conditioning, detection_threshold, max_objects,
               detect_interval, scene_threshold, noise, guider, sampler, sigmas, vae, crop_factor,
               feather, audio=None, audio_vae=None, min_face=0):
        import torch
        import comfy.utils
        import comfy.nested_tensor
        import comfy.model_management as mm
        from comfy_extras.nodes_sam3 import SAM3_TrackToMask
        from comfy_extras.nodes_custom_sampler import SamplerCustomAdvanced
        from comfy_extras.nodes_minimax_h3 import temporal_shape, _encode_ref_audio

        if float(fps) != H3_FPS:
            raise ValueError(f"DEAS_H3_FACE_REFINE: MiniMax H3 refines 24 fps video only; source is {fps} fps")
        if not math.isfinite(crop_factor) or crop_factor < 1.2 or isinstance(feather, bool) or not isinstance(feather, int) or not 0 <= feather <= 256:
            raise ValueError("DEAS_H3_FACE_REFINE: crop_factor >= 1.2 and feather 0..256 required")
        if audio is not None and audio_vae is None:
            raise ValueError("DEAS_H3_FACE_REFINE: audio needs the audio_vae input")
        boundaries = shot_boundaries(images, scene_threshold or None, "DEAS_H3_FACE_REFINE")
        out = images.clone()
        for first, end in zip(boundaries, boundaries[1:]):
            mm.throw_exception_if_processing_interrupted()
            if end - first < 5:
                _log.info("DEAS_H3FaceRefine shot=[%d,%d) skipped: shorter than H3's 5-frame minimum", first, end)
                continue
            track = track_shot(images, first, end, sam_model, sam_conditioning, detection_threshold,
                               max_objects, detect_interval, "DEAS_H3_FACE_REFINE")
            packed = track.get("packed_masks")
            for obj in range(0 if packed is None else packed.shape[1]):
                mm.throw_exception_if_processing_interrupted()
                mask = SAM3_TrackToMask.execute(track_data=track, object_indices=str(obj)).result[0].cpu() > 0.5
                box = crop_box(mask, crop_factor)
                if box is None:
                    continue
                if face_height(mask) < min_face:
                    _log.info("DEAS_H3FaceRefine shot=[%d,%d) object=%d skipped: face %d px < minimum %d px",
                              first, end, obj, face_height(mask), min_face)
                    continue
                top, left, side, present = box
                count = end - first
                length, latent_t, audio_t = temporal_shape(count)
                _log.info("DEAS_H3FaceRefine shot=[%d,%d) object=%d crop=(top=%d,left=%d,side=%d) canvas=%d h3_frames=%d present=%d",
                          first, end, obj, top, left, side, H3_CANVAS, length, int(present.sum()))
                crop = images[first:end, top:top + side, left:left + side]
                # Explicit tail padding to H3's 17k+5 grid; padded frames are discarded after decode.
                crop = torch.cat([crop, crop[-1:].expand(length - count, -1, -1, -1)]) if length > count else crop
                crop = comfy.utils.common_upscale(crop.movedim(-1, 1), H3_CANVAS, H3_CANVAS, "lanczos", "disabled").movedim(1, -1)
                video = vae.encode(crop)
                if video.ndim != 5 or video.shape[2] != latent_t:
                    raise ValueError(f"DEAS_H3_FACE_REFINE: video latent {tuple(video.shape)} does not match {latent_t} H3 latent frames")
                if audio is None:
                    sound = torch.zeros([1, 32, 2, audio_t])
                else:
                    sound, _ = _encode_ref_audio(audio_vae, shot_audio(audio, first, end, length))
                    # The silent-padded tail can round one latent step differently; never more.
                    if abs(sound.shape[-1] - audio_t) > 1:
                        raise ValueError(f"DEAS_H3_FACE_REFINE: audio latent {sound.shape[-1]} differs from {audio_t}")
                    sound = torch.nn.functional.pad(sound, (0, max(0, audio_t - sound.shape[-1])))[..., :audio_t]
                video, sound = video.to(mm.intermediate_device()), sound.to(mm.intermediate_device())
                latent = {"samples": comfy.nested_tensor.NestedTensor((video, sound)),
                          "noise_mask": comfy.nested_tensor.NestedTensor((torch.ones_like(video), torch.zeros_like(sound)))}
                sampled = SamplerCustomAdvanced.execute(noise=noise, guider=guider, sampler=sampler,
                                                        sigmas=sigmas, latent_image=latent).result[0]["samples"]
                mm.throw_exception_if_processing_interrupted()
                refined = vae.decode(sampled.unbind()[0] if sampled.is_nested else sampled)
                refined = refined.reshape(-1, *refined.shape[-3:])[:count].float().cpu()
                if refined.shape[0] != count:
                    raise ValueError("DEAS_H3_FACE_REFINE: decoded frame count differs from the shot")
                refined = comfy.utils.common_upscale(refined.movedim(-1, 1), side, side, "bicubic", "disabled").movedim(1, -1).clamp(0, 1)
                alpha = feather_mask(mask[:, top:top + side, left:left + side], feather)[..., None]
                region = out[first:end, top:top + side, left:left + side]
                out[first:end, top:top + side, left:left + side] = region * (1 - alpha) + refined * alpha
                del crop, video, sound, latent, sampled, refined, alpha
            del track, packed
        mm.throw_exception_if_processing_interrupted()
        return (out,)


NODE_CLASS_MAPPINGS = {"DEAS_SAM3VideoWindow": SAM3VideoWindow, "DEAS_SAM3ShotMask": SAM3ShotMask,
                       "DEAS_H3FaceRefine": H3FaceRefine}
