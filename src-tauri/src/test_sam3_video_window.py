"""Focused stdlib tests; --comfy-root additionally exercises the installed Core decoder on CPU."""
import importlib.util
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest
from fractions import Fraction
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("sam3_video_window", Path(__file__).with_name("sam3_video_window.py"))
assert spec is not None and spec.loader is not None
window = importlib.util.module_from_spec(spec)
spec.loader.exec_module(window)


def plan(**kwargs):
    values = dict(width=64, height=48, fps=Fraction(24), frames=24, seconds=1,
                  start=0, duration=0.5, max_objects=4, available=10**10)
    values.update(kwargs)
    return window.window_plan(**values)


class WindowTests(unittest.TestCase):
    def test_managed_mapping_and_shot_schema_import_without_core(self):
        self.assertEqual(set(window.NODE_CLASS_MAPPINGS), {"DEAS_SAM3VideoWindow", "DEAS_SAM3ShotMask", "DEAS_H3FaceRefine"})
        node = window.NODE_CLASS_MAPPINGS["DEAS_SAM3ShotMask"]
        self.assertEqual(node.RETURN_TYPES, ("MASK",))
        self.assertEqual(node.FUNCTION,"mask")
        inputs = node.INPUT_TYPES()["required"]
        self.assertEqual({k:v[0] for k,v in inputs.items()}, {
            "images":"IMAGE", "model":"MODEL", "conditioning":"CONDITIONING",
            "detection_threshold":"FLOAT", "max_objects":"INT", "detect_interval":"INT", "scene_threshold":"FLOAT"})
        self.assertEqual(inputs["scene_threshold"][1], {"default":0.3,"min":5e-324,"max":1.0})

    def test_cgroup_pool_intersects_ancestors_and_never_adds_used_pages_twice(self):
        with tempfile.TemporaryDirectory(prefix="deas-cgroup-") as directory:
            root=Path(directory)
            child=root / "service" / "worker"
            child.mkdir(parents=True)
            (root / "memory.max").write_text("1000")
            (root / "memory.current").write_text("700")
            (child / "memory.max").write_text("max")
            self.assertEqual(window.cgroup_available(800,"/service/worker",root),300)
            self.assertEqual(window.cgroup_available(200,"/service/worker",root),200)
            (child / "memory.max").write_text("100")
            (child / "memory.current").write_text("90")
            self.assertEqual(window.cgroup_available(800,"/service/worker",root),10)
            (child / "memory.current").write_text("101")
            self.assertEqual(window.cgroup_available(800,"/service/worker",root),0)
            with self.assertRaises(ValueError):
                window.cgroup_available(800,"/../escape",root)
            (child / "memory.current").write_text("invalid")
            with self.assertRaises(ValueError):
                window.cgroup_available(800,"/service/worker",root)

    def test_source_plan_and_memory_are_proportional(self):
        count, estimate, budget = plan()
        self.assertEqual(count, 12)
        self.assertEqual(budget, 7_500_000_000)
        self.assertGreater(estimate, 0)
        self.assertEqual(plan(available=estimate * 2)[1], estimate)
        with self.assertRaisesRegex(ValueError, "75% of available"):
            plan(available=estimate)

    def test_whole_window_unpacked_tracker_masks_are_included_for_tiny_sources(self):
        count, estimate, _ = plan(width=8,height=8,max_objects=1)
        self.assertGreaterEqual(estimate,count*1008*1008*8)
        with self.assertRaisesRegex(ValueError,"75% of available"):
            plan(width=8,height=8,max_objects=1,available=count*1008*1008*4)

    def test_changed_frame_dimensions_are_rejected_before_rgb_conversion(self):
        from types import SimpleNamespace
        frame=SimpleNamespace(width=4096,height=4096,to_ndarray=lambda **kwargs: self.fail("RGB conversion must not run"))
        packet=SimpleNamespace(stream=SimpleNamespace(type="video"),decode=lambda:[frame])
        with self.assertRaisesRegex(ValueError,"before RGB conversion"):
            list(window.CheckedPacket(packet,64,48,lambda:None).decode())
        frame.width=64;frame.height=48
        self.assertEqual(list(window.CheckedPacket(packet,64,48,lambda:None).decode()),[frame])
        # Audio frames carry no geometry and pass through when refinement keeps the soundtrack.
        sound=SimpleNamespace(samples=1024)
        audio=SimpleNamespace(stream=SimpleNamespace(type="audio"),decode=lambda:[sound])
        self.assertEqual(list(window.CheckedPacket(audio,64,48,lambda:None).decode()),[sound])

    def test_invalid_metadata_numeric_windows_and_unsupported_rates_fail_closed(self):
        for changes in [dict(width=0), dict(height=-1), dict(frames=0), dict(frames=1.5),
                        dict(fps=0), dict(fps=121), dict(fps=Fraction(24000,1001)),
                        dict(fps=Fraction(30000,1001)), dict(seconds=2), dict(start=-0.1),
                        dict(start=1), dict(start=0.75), dict(start=math.nan), dict(start=True),
                        dict(duration=0), dict(duration=math.inf), dict(duration=0.01),
                        dict(start=0.01), dict(max_objects=0), dict(max_objects=65),
                        dict(max_objects=1.1), dict(available=0), dict(available=math.inf)]:
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                plan(**changes)
        self.assertEqual(plan(fps=Fraction(2997,100), frames=2997, seconds=100,
                              duration=100,available=10**12)[0], 2997)

    def test_packet_timing_rejects_vfr_missing_duplicate_and_incomplete_windows(self):
        from types import SimpleNamespace
        def packets(stamps):
            return iter(SimpleNamespace(pts=p, dts=d, size=10) for p,d in stamps)
        check=lambda: None
        window.checked_packets(packets([(0,-2),(3,-1),(1,0),(2,1)]),Fraction(1,24),Fraction(24),0,4,check)
        for stamps in [[(0,0),(0,1)], [(None,0)], [(0,None)], [(0,0)]]:
            with self.assertRaises(ValueError):
                window.checked_packets(packets(stamps),Fraction(1,24),Fraction(24),0,2,check)
        with self.assertRaisesRegex(ValueError,"variable-rate"):
            window.checked_packets(packets([(1,0)]),Fraction(1,48),Fraction(24),0,1,check)

    def test_decoded_count_dimensions_and_cancellation_are_checked(self):
        class Frame:
            shape = (48,64,3)
        check = lambda: None
        self.assertEqual(len(list(window.checked_frames(iter([Frame()]*2),64,48,2,check))),2)
        for fs in [[], [Frame()], [Frame()]*3]:
            with self.assertRaisesRegex(ValueError,"frame count"):
                list(window.checked_frames(iter(fs),64,48,2,check))
        with self.assertRaisesRegex(ValueError,"dimensions"):
            list(window.checked_frames(iter([Frame()]),48,64,1,check))
        def cancelled():
            raise RuntimeError("cancelled")
        with self.assertRaisesRegex(RuntimeError,"cancelled"):
            list(window.checked_frames(iter([Frame()]),64,48,1,cancelled))


class CoreWindowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if "--comfy-root" not in sys.argv:
            raise unittest.SkipTest("explicit installed Core path required")
        import av
        import numpy as np
        cls.temp = tempfile.TemporaryDirectory(prefix="deas-sam-window-")
        cls.root = cls.temp.name
        cls.path = os.path.join(cls.root,"source.mp4")
        with av.open(cls.path,"w") as container:
            stream=container.add_stream("libx264",rate=24)
            stream.width=64; stream.height=48; stream.pix_fmt="yuv444p"
            for n in range(24):
                frame=av.VideoFrame.from_ndarray(np.full((48,64,3),n*8,dtype=np.uint8),format="rgb24")
                for packet in stream.encode(frame): container.mux(packet)
            for packet in stream.encode(): container.mux(packet)

    @classmethod
    def tearDownClass(cls):
        if hasattr(cls,"temp"): cls.temp.cleanup()

    def source(self):
        from comfy_api.latest import InputImpl
        return InputImpl.VideoFromFile(self.path)

    def model(self):
        from types import SimpleNamespace
        from comfy.model_base import SAM3
        # Type-only loader fixture: no weights, GPU allocation or inference.
        return SimpleNamespace(model=SAM3.__new__(SAM3))

    def test_core_trim_is_applied_before_silent_bounded_decode(self):
        from comfy_extras.nodes_video import GetVideoComponents
        with patch("folder_paths.get_input_directory",return_value=self.root):
            bounded,=window.SAM3VideoWindow().window(self.source(),self.model(),0.25,0.25,4)
            self.assertEqual(bounded.get_active_trim_window(),(0.25,0.25))
            result=GetVideoComponents.execute(bounded).result
            self.assertEqual(tuple(result[0].shape),(6,48,64,3))
            self.assertIsNone(result[1])
            self.assertEqual(result[2],24.0)
            self.assertAlmostEqual(float(result[0][0].mean()),48/255,delta=0.02)

    def test_memory_rechecked_before_get_components_and_source_swap_rejected(self):
        from comfy_api.latest import InputImpl
        with patch("folder_paths.get_input_directory",return_value=self.root):
            bounded,=window.SAM3VideoWindow().window(self.source(),self.model(),0,0.25,4)
            with patch("psutil.virtual_memory") as memory, patch.object(InputImpl.VideoFromFile,"get_components_internal",side_effect=AssertionError("decode must not run")):
                memory.return_value.available=1
                with self.assertRaisesRegex(ValueError,"memory"):
                    bounded.get_components()
            with patch("psutil.virtual_memory") as memory, patch.object(InputImpl.VideoFromFile,"as_trimmed",side_effect=AssertionError("trim must not run")):
                memory.return_value.available=1
                with self.assertRaisesRegex(ValueError,"memory"):
                    window.SAM3VideoWindow().window(self.source(),self.model(),0,0.25,4)
            with patch("os.stat") as stat:
                stat.return_value.st_dev=-1
                with self.assertRaisesRegex(ValueError,"source changed"):
                    bounded.get_components()

    def test_source_change_during_decode_is_rejected_before_tracking(self):
        from comfy_api.latest import InputImpl
        original = InputImpl.VideoFromFile.get_components_internal
        saved = os.stat(self.path)
        def changed(video, container):
            components = original(video, container)
            os.utime(self.path, ns=(saved.st_atime_ns, saved.st_mtime_ns + 1_000_000))
            return components
        try:
            with patch("folder_paths.get_input_directory",return_value=self.root):
                bounded,=window.SAM3VideoWindow().window(self.source(),self.model(),0,0.25,4)
                with patch.object(InputImpl.VideoFromFile,"get_components_internal",autospec=True,side_effect=changed):
                    with self.assertRaisesRegex(ValueError,"source changed"):
                        bounded.get_components()
        finally:
            os.utime(self.path, ns=(saved.st_atime_ns, saved.st_mtime_ns))

    def test_admission_never_calls_core_trim_duration_decode_fallback(self):
        from comfy_api.latest import InputImpl
        with patch("folder_paths.get_input_directory",return_value=self.root):
            with patch.object(InputImpl.VideoFromFile,"as_trimmed",side_effect=AssertionError("unbound trim lookup")), patch.object(InputImpl.VideoFromFile,"get_duration",side_effect=AssertionError("unbound duration lookup")):
                bounded,=window.SAM3VideoWindow().window(self.source(),self.model(),0.25,0.25,4)
                self.assertEqual(bounded.get_active_trim_window(),(0.25,0.25))
                self.assertEqual(tuple(bounded.get_components().images.shape),(6,48,64,3))

    def test_source_replaced_between_stat_and_open_is_rejected(self):
        import builtins
        import shutil
        original_open = builtins.open
        replacement = self.path + ".replacement"
        shutil.copy2(self.path,replacement)
        def swapped(path,*args,**kwargs):
            if os.fspath(path) == self.path and os.path.exists(replacement):
                os.replace(replacement,self.path)
            return original_open(path,*args,**kwargs)
        with patch("folder_paths.get_input_directory",return_value=self.root):
            bounded,=window.SAM3VideoWindow().window(self.source(),self.model(),0,0.25,4)
            with patch("builtins.open",side_effect=swapped):
                with self.assertRaisesRegex(ValueError,"source changed"):
                    bounded.get_components()

    def test_codec_max_pixels_option_rejects_excessive_surface(self):
        import av
        from av.error import FFmpegError
        with av.open(self.path,"r") as container:
            stream=container.streams.video[0]
            stream.codec_context.options={"max_pixels":"64"}
            with self.assertRaises(FFmpegError):
                list(container.decode(stream))

    def test_core_api_saver_dispatch_preserves_flat_dynamic_inputs_and_no_face_masks(self):
        import asyncio
        import av
        import execution
        from comfy_extras.nodes_sam3 import SAM3_TrackToMask
        from comfy_extras.nodes_video import CreateVideo, SaveVideo
        from comfy_extras.nodes_mask import MaskToImage
        masks = SAM3_TrackToMask.execute({"packed_masks":None,"orig_size":(49,65),"n_frames":3}).result[0]
        self.assertEqual(tuple(masks.shape),(3,49,65))
        self.assertEqual(float(masks.sum()),0)
        images = MaskToImage.execute(masks).result[0]
        video = CreateVideo.execute(images,24,bit_depth=8,color_space="sRGB",chroma_subsampling="444").result[0]
        data,missing,v3 = execution.get_input_data({"video":video,"filename_prefix":"no-faces",
            "format":"mp4","format.codec":"h264"},SaveVideo,"7")
        self.assertEqual(missing,{})
        self.assertEqual(data["format"],["mp4"])
        self.assertEqual(data["format.codec"],["h264"])
        with patch("folder_paths.get_output_directory",return_value=self.root):
            result = asyncio.run(execution._async_map_node_over_list("cpu-probe","7",SaveVideo,data,
                SaveVideo.FUNCTION,v3_data=v3))[0]
        descriptor = result.ui.as_dict()["images"][0]
        with av.open(os.path.join(self.root,descriptor["filename"])) as container:
            stream = container.streams.video[0]
            self.assertEqual((stream.width,stream.height),(65,49))
            self.assertEqual(stream.average_rate,Fraction(24))
            self.assertEqual(len(container.streams.audio),0)
            frames=list(container.decode(stream))
            self.assertEqual(len(frames),3)
            self.assertEqual(int(frames[0].to_ndarray(format="rgb24").max()),0)

    def test_non_file_and_external_paths_rejected(self):
        with patch("folder_paths.get_input_directory",return_value=self.root):
            with self.assertRaisesRegex(ValueError,"not a Core SAM3"):
                window.SAM3VideoWindow().window(self.source(),None,0,0.25,4)
            with self.assertRaisesRegex(ValueError,"LoadVideo"):
                window.SAM3VideoWindow().window(object(),None,0,0.25,4)
        with patch("folder_paths.get_input_directory",return_value=os.path.join(self.root,"other")):
            with self.assertRaisesRegex(ValueError,"top-level"):
                window.SAM3VideoWindow().window(self.source(),self.model(),0,0.25,4)


class CoreShotTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if "--comfy-root" not in sys.argv:
            raise unittest.SkipTest("explicit installed Core path required")

    def frames(self, levels, h=5, w=7):
        import torch
        return torch.tensor(levels, dtype=torch.float32)[:, None, None, None].expand(-1,h,w,3)

    def run_shots(self, images, threshold=0.3, no_faces=False):
        import torch
        import comfy.model_management as mm
        from types import SimpleNamespace
        from comfy_extras.nodes_sam3 import SAM3_TrackToMask
        calls = []
        def forward_video(**kwargs):
            frames = kwargs["images"]
            calls.append((frames, kwargs))
            n = len(frames)
            # Actual Core tracker execute + TrackToMask, only model inference is synthetic.
            packed = None if no_faces else torch.full((n,2,2,1), 1 if len(calls)%2 else 128, dtype=torch.uint8)
            return {"packed_masks":packed, "n_frames":n, "scores":[]}
        model = SimpleNamespace(model=SimpleNamespace(get_dtype=lambda:torch.float32,
            diffusion_model=SimpleNamespace(forward_video=forward_video)))
        conditioning = [object()]
        with patch.object(mm,"load_model_gpu"), patch("comfy_extras.nodes_sam3._extract_text_prompts",return_value=[(None,None,None)]), patch.object(SAM3_TrackToMask,"execute",wraps=SAM3_TrackToMask.execute) as union:
            with self.assertLogs(window._log,level="INFO") as logs:
                masks, = window.SAM3ShotMask().mask(images,model,conditioning,0.55,8,2,threshold)
            self.assertEqual(union.call_count,len(calls))
            for call in union.call_args_list:
                self.assertEqual(call.kwargs["object_indices"],"")
        self.assertEqual(masks.device.type,"cpu")
        self.assertEqual(masks.dtype,torch.float32)
        self.assertEqual(tuple(masks.shape),tuple(images.shape[:3]))
        self.assertEqual(len(logs.output),len(calls))
        for line in logs.output:
            self.assertIn("DEAS_SAM3ShotMask",line)
            self.assertIn("window_relative_frames_zero_based_half_open=[",line)
        offset = 0
        for frames, kwargs in calls:
            torch.testing.assert_close(frames,images[offset:offset+len(frames)].movedim(-1,1),rtol=0,atol=0)
            self.assertEqual(frames.untyped_storage().data_ptr(),images.untyped_storage().data_ptr())
            self.assertIsNone(kwargs["initial_masks"])
            self.assertEqual(kwargs["detect_interval"],2)
            self.assertEqual(kwargs["new_det_thresh"],0.55)
            self.assertEqual(kwargs["max_objects"],8)
            offset += len(frames)
        return masks, [len(f) for f,_ in calls]

    def test_resets_order_original_views_and_core_union(self):
        masks, lengths = self.run_shots(self.frames([0,0,1,1,0]))
        self.assertEqual(lengths,[2,2,1])
        self.assertGreater(float(masks[0,0,0]),0)
        self.assertEqual(float(masks[2,0,0]),0)
        self.assertGreater(float(masks[4,0,0]),0)

    def test_one_frame_no_cut_and_flash_edges(self):
        for levels, expected in [([0],[1]), ([0,0,0],[3]), ([0,1,0],[1,1,1]),
                                 ([0,1,1],[1,2]), ([0,0,1],[2,1]), ([0,0.25],[1,1])]:
            with self.subTest(levels=levels):
                _, lengths = self.run_shots(self.frames(levels),threshold=0.25)
                self.assertEqual(lengths,expected)
        _, lengths = self.run_shots(self.frames([0,1]),threshold=1)
        self.assertEqual(lengths,[1,1])

    def test_no_faces_remain_zero_and_tiles_cover_odd_edges(self):
        masks, lengths = self.run_shots(self.frames([0,1,1],h=129,w=131),no_faces=True)
        self.assertEqual(lengths,[1,2])
        self.assertEqual(float(masks.sum()),0)

    def test_mean_score_not_max_or_downsample_and_input_not_mutated(self):
        import torch
        images = self.frames([0,0],h=129,w=131).clone()
        images[1,-1,-1,:] = 1
        original = images.clone()
        _, lengths = self.run_shots(images,threshold=0.01)
        self.assertEqual(lengths,[2])
        torch.testing.assert_close(images,original,rtol=0,atol=0)

    def test_invalid_frames_thresholds_and_union_fail_closed(self):
        import torch
        from comfy_api.latest import io
        from comfy_extras.nodes_sam3 import SAM3_VideoTrack, SAM3_TrackToMask
        node = window.SAM3ShotMask()
        def run(images,threshold=0.3):
            return node.mask(images,object(),object(),0.5,8,1,threshold)
        for images in [torch.empty(0,2,2,3),torch.zeros(1,2,2,4),torch.zeros(1,2,2,3,dtype=torch.uint8),
                       self.frames([math.nan]),self.frames([math.inf]),self.frames([-0.1]),self.frames([1.1])]:
            with self.subTest(shape=images.shape), patch.object(SAM3_VideoTrack,"execute") as tracker:
                with self.assertRaises(ValueError): run(images)
                tracker.assert_not_called()
        for threshold in [True,0,-1,1.1,math.nan,math.inf,"0.3"]:
            with self.assertRaises(ValueError): run(self.frames([0]),threshold)
        track = {"orig_size":(5,7),"n_frames":1,"packed_masks":None}
        for masks in [torch.zeros(2,5,7),torch.zeros(1,7,5),torch.full((1,5,7),math.nan),torch.full((1,5,7),1.1)]:
            with patch.object(SAM3_VideoTrack,"execute",return_value=io.NodeOutput(track)), patch.object(SAM3_TrackToMask,"execute",return_value=io.NodeOutput(masks)):
                with self.assertRaises(ValueError): run(self.frames([0]))
        for bad in [{**track,"n_frames":2},{**track,"orig_size":(7,5)}, {**track,"packed_masks":torch.zeros(2,1,2,1,dtype=torch.uint8)},
                    {**track,"packed_masks":torch.zeros(1,1,2,1)},
                    {**track,"packed_masks":torch.zeros(1,1,1009,1,dtype=torch.uint8)},
                    {**track,"packed_masks":torch.zeros(1,1,1,127,dtype=torch.uint8)}]:
            with patch.object(SAM3_VideoTrack,"execute",return_value=io.NodeOutput(bad)), patch.object(SAM3_TrackToMask,"execute") as union:
                with self.assertRaises(ValueError): run(self.frames([0]))
                union.assert_not_called()

    def test_interrupt_during_scoring_and_between_shots(self):
        import comfy.model_management as mm
        from comfy_api.latest import io
        from comfy_extras.nodes_sam3 import SAM3_VideoTrack
        with patch.object(mm,"throw_exception_if_processing_interrupted",side_effect=RuntimeError("scoring stop")), patch.object(SAM3_VideoTrack,"execute") as tracker:
            with self.assertRaisesRegex(RuntimeError,"scoring stop"):
                window.SAM3ShotMask().mask(self.frames([0,1]),None,None,0.5,8,1,0.3)
            tracker.assert_not_called()
        count = 0
        def tracker(**kwargs):
            nonlocal count
            count += 1
            return io.NodeOutput({"orig_size":(5,7),"n_frames":1,"packed_masks":None})
        checks = 0
        def interrupt():
            nonlocal checks
            checks += 1
            # Two scoring tiles, pre-allocation, pre-shot, post-track, union tile, next-shot.
            if checks == 7: raise RuntimeError("between shots")
        with patch.object(mm,"throw_exception_if_processing_interrupted",side_effect=interrupt), patch.object(SAM3_VideoTrack,"execute",side_effect=tracker):
            with self.assertRaisesRegex(RuntimeError,"between shots"):
                window.SAM3ShotMask().mask(self.frames([0,1]),None,None,0.5,8,1,0.3)
        self.assertEqual(count,1)


class CoreRefineTests(unittest.TestCase):
    """Crop/pad/stitch arithmetic with real Core helpers; only SAM/H3 inference is synthetic."""
    @classmethod
    def setUpClass(cls):
        if "--comfy-root" not in sys.argv:
            raise unittest.SkipTest("explicit installed Core path required")

    def test_crop_box_scales_with_face_height_clamps_to_frame_and_reports_presence(self):
        import torch
        mask = torch.zeros(10, 100, 200, dtype=torch.bool)
        mask[2:8, 40:60, 100:120] = True
        tops, lefts, side, present = window.crop_box(mask, 2.5)
        self.assertEqual((tops, lefts, side), ([25] * 10, [85] * 10, 50))
        self.assertEqual(present.nonzero().flatten().tolist(), [2, 3, 4, 5, 6, 7])
        edge = torch.zeros(3, 100, 200, dtype=torch.bool)
        edge[:, 0:10, 190:200] = True
        self.assertEqual(window.crop_box(edge, 2.5)[:3], ([0] * 3, [175] * 3, 25))
        huge = torch.zeros(2, 100, 200, dtype=torch.bool)
        huge[:, 10:90, 10:20] = True
        self.assertEqual(window.crop_box(huge, 8.0)[2], 100)
        self.assertIsNone(window.crop_box(torch.zeros(4, 8, 8, dtype=torch.bool), 2.5))
        self.assertEqual((window.face_height(mask), window.face_height(huge)), (20, 80))
        # A face crossing the frame: same face-scaled side, box follows it, smoothed, held when lost.
        walk = torch.zeros(20, 100, 400, dtype=torch.bool)
        for f in range(20):
            if f != 10:
                walk[f, 40:60, 10 + 18 * f:30 + 18 * f] = True
        tops, lefts, side, present = window.crop_box(walk, 2.5)
        self.assertEqual((side, int(present.sum()), set(tops)), (50, 19, {25}))
        self.assertEqual(lefts, sorted(lefts))
        self.assertGreater(lefts[-1] - lefts[0], 250)
        for f in present.nonzero().flatten().tolist():  # the face stays inside its moving crop
            self.assertTrue(walk[f, :, lefts[f]:lefts[f] + side].sum() == walk[f].sum(), f)
        self.assertTrue(max(b - a for a, b in zip(lefts, lefts[1:])) <= 20)
        self.assertEqual(window.face_height(torch.zeros(2, 4, 4, dtype=torch.bool)), 0)

    def test_feather_grows_and_softens_without_leaking_far(self):
        import torch
        mask = torch.zeros(1, 21, 21, dtype=torch.bool)
        mask[0, 10, 10] = True
        self.assertTrue(torch.equal(window.feather_mask(mask, 0), mask.float()))
        soft = window.feather_mask(mask, 2)
        self.assertEqual(soft[0, 10, 10].item(), 1.0)
        self.assertTrue(0 < soft[0, 10, 13].item() < 1)
        self.assertEqual(soft[0, 0, 0].item(), 0.0)

    def test_shot_audio_slices_frame_exact_and_silent_pads_to_h3_length(self):
        import torch
        wave = torch.arange(1, 96001, dtype=torch.float32)[None, None].repeat(1, 2, 1)
        clip = window.shot_audio({"waveform": wave, "sample_rate": 48000}, 24, 48, 39)
        self.assertEqual(clip["sample_rate"], 48000)
        self.assertEqual(clip["waveform"].shape, (1, 2, 78000))
        self.assertEqual(clip["waveform"][0, 0, 0].item(), 48001)
        self.assertEqual(clip["waveform"][0, 0, 47999].item(), 96000)
        self.assertEqual(clip["waveform"][0, :, 48000:].abs().sum().item(), 0)

    def test_refine_refuses_non_h3_rate_before_any_inference(self):
        import torch
        with self.assertRaisesRegex(ValueError, "24 fps"):
            window.H3FaceRefine().refine(torch.zeros(5, 8, 8, 3), 30.0, None, None, 0.5, 4, 1, 0.0,
                                         None, None, None, None, None, 2.5, 6)

    def test_refine_pads_to_h3_grid_holds_audio_and_stitches_only_the_feathered_face(self):
        import torch
        from types import SimpleNamespace
        from comfy_extras import nodes_sam3, nodes_custom_sampler
        from comfy_extras.nodes_minimax_h3 import temporal_shape
        frames, h, w = 30, 64, 96
        images = torch.full((frames, h, w, 3), 0.25)
        mask = torch.zeros(frames, h, w)
        mask[:, 20:30, 40:50] = 1
        seen = {}
        class Vae:
            def encode(self, pixels):
                seen["pixels"] = tuple(pixels.shape)
                return torch.zeros(1, 24, temporal_shape(frames)[1], 48, 48)
            def decode(self, latent):
                return torch.ones(1, 39, 768, 768, 3)
        def sample(**kwargs):
            seen["noise_mask"] = kwargs["latent_image"]["noise_mask"].unbind()
            return SimpleNamespace(result=({"samples": kwargs["latent_image"]["samples"]},))
        track = {"packed_masks": torch.zeros(frames, 1, 2, 2, dtype=torch.uint8)}
        with patch.object(window, "track_shot", return_value=track), \
                patch.object(nodes_sam3.SAM3_TrackToMask, "execute", return_value=SimpleNamespace(result=(mask,))), \
                patch.object(nodes_custom_sampler.SamplerCustomAdvanced, "execute", side_effect=sample):
            out, = window.H3FaceRefine().refine(images, 24.0, None, None, 0.5, 4, 1, 0.0, None, None, None, None,
                                               Vae(), 2.5, 0)
        self.assertEqual(seen["pixels"], (39, 768, 768, 3))
        video_mask, audio_mask = seen["noise_mask"]
        self.assertEqual((video_mask.min().item(), audio_mask.max().item()), (1.0, 0.0))
        self.assertEqual(out.shape, images.shape)
        self.assertAlmostEqual(out[:, 20:30, 40:50].mean().item(), 1.0, places=4)
        outside = out.clone(); outside[:, 20:30, 40:50] = 0.25
        self.assertTrue(torch.equal(outside, images))
        # A minimum face size above the 10 px face keeps the original pixels without sampling.
        seen.clear()
        with patch.object(window, "track_shot", return_value=track), \
                patch.object(nodes_sam3.SAM3_TrackToMask, "execute", return_value=SimpleNamespace(result=(mask,))), \
                patch.object(nodes_custom_sampler.SamplerCustomAdvanced, "execute", side_effect=sample):
            out, = window.H3FaceRefine().refine(images, 24.0, None, None, 0.5, 4, 1, 0.0, None, None, None, None,
                                               Vae(), 2.5, 0, min_face=11)
        self.assertEqual(seen, {})
        self.assertTrue(torch.equal(out, images))


if __name__ == "__main__":
    if "--comfy-root" in sys.argv:
        root=sys.argv[sys.argv.index("--comfy-root")+1]
        sys.path.insert(0,root)
        # Core policy must be set before its model-management import.
        from comfy.cli_args import args
        args.cpu=True
    unittest.main(argv=[sys.argv[0]],verbosity=2)
