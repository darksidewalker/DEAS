#!/usr/bin/env python3
"""CPU contract proof for SAM3 tracked-mask video export, not SAM/H3 inference.

Uses the installed core's real packed-mask decoder, mask conversion and video
writer on synthetic tracks. No checkpoints, GPU allocation or live services.
"""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--comfyui-root', type=Path, required=True)
parser.add_argument('--scratch', type=Path, required=True)
parser.add_argument('--graph', type=Path, help='Native compiler graph JSON; validate against the installed Core without loading models.')
options = parser.parse_args()
root = options.comfyui_root.resolve()
options.scratch.mkdir(parents=True, exist_ok=True)
os.environ['PYTHONDONTWRITEBYTECODE'] = '1'
os.environ['CUDA_VISIBLE_DEVICES'] = ''
sys.dont_write_bytecode = True
sys.path.insert(0, str(root))
sys.argv = [sys.argv[0], '--cpu', '--disable-metadata']
from comfy.cli_args import args
args.cpu = True
args.disable_metadata = True
import av
import folder_paths
import torch
from comfy_extras.nodes_mask import MaskToImage
from comfy.ldm.sam3.tracker import pack_masks
from comfy_extras.nodes_sam3 import SAM3_TrackToMask, SAM3_VideoTrack
from comfy_extras.nodes_video import CreateVideo, SaveVideo

torch.set_num_threads(2)
frames, width, height, fps = 12, 64, 48, 24


def export(track_data, directory, name):
    masks = SAM3_TrackToMask.execute(track_data, object_indices='').result[0]
    assert masks.shape == (frames, height, width)
    images = MaskToImage.execute(masks).result[0]
    assert images.shape == (frames, height, width, 3)
    video = CreateVideo.execute(images=images, fps=fps).result[0]
    SaveVideo.execute(video=video, filename_prefix=name,
                      format={'format': 'mp4', 'codec': {'codec': 'h264'}})
    paths = list(directory.glob(name + '*.mp4'))
    assert len(paths) == 1, paths
    with av.open(str(paths[0])) as container:
        stream = container.streams.video[0]
        assert not container.streams.audio
        assert stream.average_rate == fps, stream.average_rate
        decoded = list(container.decode(stream))
        assert len(decoded) == frames, len(decoded)
        assert all((f.width, f.height) == (width, height) for f in decoded)
        pixels = torch.stack([torch.from_numpy(f.to_ndarray(format='rgb24').copy()) for f in decoded])
        assert all(f.pts is not None for f in decoded)
        assert all(a.pts < b.pts for a, b in zip(decoded, decoded[1:]))
    return pixels, paths[0].name


with tempfile.TemporaryDirectory(prefix='deas-sam-video-', dir=options.scratch) as temporary:
    directory = Path(temporary)
    old_output = folder_paths.get_output_directory()
    folder_paths.set_output_directory(str(directory))
    try:
        if options.graph:
            import asyncio
            import importlib.util
            import nodes
            import execution
            from comfy_extras.nodes_video import LoadVideo, GetVideoComponents
            from comfy_extras.nodes_sam3 import SAM3_TrackToMask, SAM3_VideoTrack
            spec = importlib.util.spec_from_file_location('deas_sam3_video_probe', Path(__file__).resolve().parents[1]/'src-tauri/src/sam3_video_window.py')
            assert spec is not None and spec.loader is not None
            adapter = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(adapter)
            nodes.NODE_CLASS_MAPPINGS.update(adapter.NODE_CLASS_MAPPINGS)
            nodes.NODE_CLASS_MAPPINGS.update({cls.define_schema().node_id:cls for cls in (LoadVideo,GetVideoComponents,SAM3_VideoTrack,SAM3_TrackToMask,MaskToImage,CreateVideo,SaveVideo)})
            graph = json.loads(options.graph.read_text())
            checkpoint = graph['1']['inputs']['ckpt_name']
            source = graph['2']['inputs']['file']
            assert isinstance(checkpoint,str) and checkpoint and '\\' not in checkpoint
            assert all(part not in ('','.','..') for part in checkpoint.split('/'))
            assert isinstance(source,str) and source and '/' not in source and '\\' not in source and source not in ('.','..')
            model_root = directory/'checkpoints'
            model_file = model_root/checkpoint
            assert model_file.resolve().is_relative_to(model_root.resolve())
            model_file.parent.mkdir(parents=True,exist_ok=True)
            model_file.touch()
            folder_paths.add_model_folder_path('checkpoints',str(model_root))
            old_input = folder_paths.get_input_directory()
            folder_paths.set_input_directory(str(directory))
            try:
                # Combo/schema validation only: no checkpoint is decoded or loaded.
                (directory/source).touch()
                validated = asyncio.run(execution.validate_prompt('deas-hf1-schema',graph,None))
                assert validated[0], validated
            finally:
                folder_paths.set_input_directory(old_input)
            print('PASS: native compiler graph accepted by installed Core validate_prompt; no inference')
        # Two tracked faces, one moving; union keeps each face and leaves the rest black.
        source_masks = torch.zeros(frames, 2, height, width, dtype=torch.bool)
        for frame in range(frames):
            source_masks[frame, 0, 8:16, 4 + frame:12 + frame] = True
            source_masks[frame, 1, 28:36, 44:52] = True
        track = {'packed_masks': pack_masks(source_masks), 'orig_size': (height, width), 'n_frames': frames}
        masks = SAM3_TrackToMask.execute(track, object_indices='').result[0]
        assert torch.equal(masks.bool(), source_masks.any(dim=1))
        selected = SAM3_TrackToMask.execute(track, object_indices='1').result[0]
        assert torch.equal(selected.bool(), source_masks[:, 1])
        decoded, tracked_file = export(track, directory, 'tracked')
        assert decoded[0, 10:14, 6:10].float().mean() > 240
        assert decoded[-1, 10:14, 17:21].float().mean() > 240
        assert decoded[:, 30:34, 46:50].float().mean() > 240
        assert decoded[:, 40:44, 4:8].float().mean() < 15
        empty = {'packed_masks': None, 'orig_size': (height, width), 'n_frames': frames}
        black, empty_file = export(empty, directory, 'empty')
        assert black.max().item() < 15
        assert not torch.cuda.is_initialized(), 'CPU contract must not initialize CUDA'
        result = {'status': 'PASS', 'kind': 'real core CPU mask/video operations; synthetic tracks, no inference',
                  'frames': frames, 'width': width, 'height': height, 'fps': fps,
                  'checks': ['per-object selection', 'union masks', 'moving mask preservation',
                             'no-face black preview', 'encoded frame count/dimensions/rate', 'monotonic timestamps', 'silent mask preview', 'no CUDA'],
                  'temporaryOutputs': [tracked_file, empty_file],
                  'trackerNode': SAM3_VideoTrack.define_schema().node_id}
        print(json.dumps(result, indent=2))
    finally:
        folder_paths.set_output_directory(old_output)
