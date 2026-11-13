"""Contract tests for tools/convert_open_h3_regenerate_lora.py (synthetic tiny tensors, CPU only).

Run: CUDA_VISIBLE_DEVICES= /data/GitHub/deas-environment/venv/bin/python -I \
       tools/test_convert_open_h3_regenerate_lora.py -v
ComfyUI key-map checks need COMFYUI_DIR (default /data/GitHub/deas-environment/ComfyUI); the full-size key check
also reads the header of H3_CHECKPOINT (default: the local graviton checkpoint) and is skipped when it is absent.
"""
import io
import json
import logging
import os
import struct
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

import torch
from safetensors.torch import load_file, save_file

sys.path.insert(0, str(Path(__file__).resolve().parent))
import convert_open_h3_regenerate_lora as conv  # noqa: E402

COMFY = os.environ.get("COMFYUI_DIR", "/data/GitHub/deas-environment/ComfyUI")
H3_CHECKPOINT = os.environ.get("H3_CHECKPOINT", "/data/GitHub/AI-Ressources/models/diffusion_models/MiniMaxH3/"
                               "dasiwa_minimax_h3_graviton_v5_pruned_bf16.safetensors")
HID, HEADS, HD, FFN, LAYERS, REFINER, CURVE = 16, 2, 8, 24, 2, 1, 8
INNER = HEADS * HD
DIFFUSERS_MODULES = {  # Diffusers module -> (in, out)
    "attn.to_q": (HID, INNER), "attn.to_k": (HID, INNER), "attn.to_v": (HID, INNER),
    "attn.to_out.0": (INNER, HID), "ff.net.0.proj": (HID, 2 * FFN), "ff.net.2": (FFN, HID)}


def comfy():
    if not Path(COMFY, "comfy").is_dir():
        raise unittest.SkipTest(f"ComfyUI not found at {COMFY}")
    if COMFY not in sys.path:
        sys.path.insert(0, COMFY)
    from comfy.cli_args import args
    args.cpu = True  # no GPU: another job owns it
    import comfy.lora
    import comfy.model_detection
    return comfy


def native_checkpoint(curve=True):
    """Tiny native H3 state dict (shapes only matter)."""
    z = lambda *s: torch.zeros(s, dtype=torch.bfloat16)
    sd = {"video_patch_proj.weight": z(HID, 8), "audio_patch_proj.weight": z(HID, 4), "condition_proj.weight": z(HID, 12),
          "final_layer.video_out.weight": z(8, HID), "final_layer.audio_out.weight": z(4, HID),
          "final_layer.adaln_proj.linear.weight": z(2 * HID, CURVE), "rope.inv_freq": z(2)}
    if curve:
        sd["adaln_t_table"] = z(33, CURVE)
    else:
        sd |= {"time_embedder.proj_in.weight": z(HID, 8), "time_embedder.proj_out.weight": z(CURVE, HID)}
    blocks = [f"blocks.{n}" for n in range(LAYERS)] + [f"token_refiner.blocks.{n}" for n in range(REFINER)]
    for b in blocks:
        sd |= {f"{b}.attn.qkv_proj.weight": z(3 * INNER, HID), f"{b}.attn.out_proj.weight": z(HID, INNER),
               f"{b}.attn.q_norm.weight": z(HD), f"{b}.attn.k_norm.weight": z(HD),
               f"{b}.mlp.fc1.weight": z(2 * FFN, HID), f"{b}.mlp.fc2.weight": z(HID, FFN)}
        if not b.startswith("token"):
            sd[f"{b}.adaln_proj.linear.weight"] = z(18 * HID, CURVE)
    return sd


def diffusers_lora(rank=3):
    g = torch.Generator().manual_seed(0)
    sd = {}
    for prefix in [f"transformer.transformer_blocks.{n}" for n in range(LAYERS)] + \
                  [f"transformer.token_refiner.refiner_blocks.{n}" for n in range(REFINER)]:
        for i, (mod, (fan_in, fan_out)) in enumerate(DIFFUSERS_MODULES.items()):
            r = rank + i % 2  # uneven ranks exercise the block-diagonal fuse
            sd[f"{prefix}.{mod}.lora_A.weight"] = torch.randn(r, fan_in, generator=g)
            sd[f"{prefix}.{mod}.lora_B.weight"] = torch.randn(fan_out, r, generator=g)
    return sd


def curve_lora(rank=4):
    g = torch.Generator().manual_seed(1)
    sd = {}
    for n in range(LAYERS):
        sd[f"transformer.transformer_blocks.{n}.adaln_proj.linear.curve_A.weight"] = torch.randn(rank, CURVE, generator=g)
        sd[f"transformer.transformer_blocks.{n}.adaln_proj.linear.curve_B.weight"] = torch.randn(18 * HID, rank, generator=g)
    return sd


def delta(sd, module):
    return sd[f"{module}.lora_B.weight"].float() @ sd[f"{module}.lora_A.weight"].float()


def expected_deltas(src, curve=None):
    """Native weight deltas from the Diffusers factors, written out independently of the converter."""
    out = {}
    for stack, native in (("transformer.transformer_blocks", "blocks"), ("transformer.token_refiner.refiner_blocks", "token_refiner.blocks")):
        for n in range(LAYERS if native == "blocks" else REFINER):
            s, t = f"{stack}.{n}", f"diffusion_model.{native}.{n}"
            out[f"{t}.attn.qkv_proj"] = torch.cat([delta(src, f"{s}.attn.to_{p}") for p in "qkv"])
            out[f"{t}.attn.out_proj"] = delta(src, f"{s}.attn.to_out.0")
            value, gate = delta(src, f"{s}.ff.net.0.proj").chunk(2)
            out[f"{t}.mlp.fc1"] = torch.cat([gate, value])  # native swiglu chunks (gate, up)
            out[f"{t}.mlp.fc2"] = delta(src, f"{s}.ff.net.2")
    for n in range(LAYERS if curve else 0):
        s = f"transformer.transformer_blocks.{n}.adaln_proj.linear"
        out[f"diffusion_model.blocks.{n}.adaln_proj.linear"] = curve[f"{s}.curve_B.weight"] @ curve[f"{s}.curve_A.weight"]
    return out


class ConvertTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.src, self.curve = diffusers_lora(), curve_lora()
        save_file(self.src, self.dir / "lora.safetensors")
        save_file(self.curve, self.dir / "curve.safetensors")
        save_file(native_checkpoint(True), self.dir / "ckpt_curve.safetensors")
        save_file(native_checkpoint(False), self.dir / "ckpt_plain.safetensors")

    def tearDown(self):
        self.tmp.cleanup()

    def run_convert(self, out, curve=True, ckpt="ckpt_curve"):
        buf = io.StringIO()
        with redirect_stdout(buf):
            conv.convert(str(self.dir / "lora.safetensors"), str(self.dir / out),
                         str(self.dir / "curve.safetensors") if curve else None,
                         str(self.dir / f"{ckpt}.safetensors") if ckpt else None)
        return load_file(self.dir / out), buf.getvalue()

    def test_every_family_maps_and_deltas_match(self):
        out, log = self.run_convert("o.safetensors")
        want = expected_deltas(self.src, self.curve)
        self.assertEqual({k.rsplit(".lora_", 1)[0] for k in out}, set(want))
        self.assertIn("curve branches: applied", log)
        self.assertTrue(all(t.dtype == torch.bfloat16 for t in out.values()))
        self.assertFalse(any(k.endswith(".alpha") for k in out))
        for module, d in want.items():
            got = delta(out, module)
            err = ((got - d).norm() / d.norm()).item()
            self.assertLess(err, 1e-2, module)  # bf16 factors

    def test_qkv_is_block_diagonal_stack(self):
        out, _ = self.run_convert("o.safetensors", curve=False, ckpt=None)
        s, t = "transformer.transformer_blocks.1.attn", "diffusion_model.blocks.1.attn.qkv_proj"
        a = torch.cat([self.src[f"{s}.to_{p}.lora_A.weight"] for p in "qkv"])
        b = torch.block_diag(*[self.src[f"{s}.to_{p}.lora_B.weight"] for p in "qkv"])
        torch.testing.assert_close(out[f"{t}.lora_A.weight"], a.bfloat16(), rtol=0, atol=0)
        torch.testing.assert_close(out[f"{t}.lora_B.weight"], b.bfloat16(), rtol=0, atol=0)
        rq = self.src[f"{s}.to_q.lora_A.weight"].shape[0]
        self.assertTrue((out[f"{t}.lora_B.weight"][:INNER, rq:] == 0).all())  # q rows never see k/v ranks

    def test_fc1_swaps_value_gate_halves(self):
        out, _ = self.run_convert("o.safetensors", curve=False, ckpt=None)
        b_src = self.src["transformer.transformer_blocks.0.ff.net.0.proj.lora_B.weight"]
        b_out = out["diffusion_model.blocks.0.mlp.fc1.lora_B.weight"].float()
        torch.testing.assert_close(b_out[:FFN], b_src[FFN:].bfloat16().float())  # native first half = Diffusers gate
        torch.testing.assert_close(b_out[FFN:], b_src[:FFN].bfloat16().float())

    def test_curve_skipped_on_non_curve_checkpoint(self):
        out, log = self.run_convert("o.safetensors", ckpt="ckpt_plain")
        self.assertIn("curve branches: skipped", log)
        self.assertIn("adaln_t_table", log)
        self.assertFalse(any("adaln_proj" in k for k in out))

    def test_curve_requires_checkpoint(self):
        with self.assertRaisesRegex(ValueError, "--checkpoint"):
            self.run_convert("o.safetensors", ckpt=None)

    def test_refuses_overwrite(self):
        (self.dir / "o.safetensors").write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            self.run_convert("o.safetensors")
        self.assertEqual((self.dir / "o.safetensors").read_bytes(), b"keep")

    def test_unknown_key_and_shape_mismatch_fail_without_output(self):
        bad = dict(self.src, **{"transformer.proj_out.lora_A.weight": torch.zeros(3, HID)})
        save_file(bad, self.dir / "lora.safetensors")
        with self.assertRaisesRegex(ValueError, "unsupported"):
            self.run_convert("o.safetensors", curve=False)
        ck = native_checkpoint(True)
        ck["blocks.0.mlp.fc2.weight"] = torch.zeros(HID, FFN + 1)
        save_file(ck, self.dir / "ckpt_curve.safetensors")
        save_file(self.src, self.dir / "lora.safetensors")
        with self.assertRaisesRegex(ValueError, "blocks.0.mlp.fc2"):
            self.run_convert("o.safetensors", curve=False)
        self.assertFalse((self.dir / "o.safetensors").exists())

    def test_cli_exit_on_existing_output(self):
        (self.dir / "o.safetensors").write_bytes(b"keep")
        with self.assertRaises(SystemExit) as cm:
            conv.main([str(self.dir / "lora.safetensors"), str(self.dir / "o.safetensors")])
        self.assertIn("refusing to overwrite", str(cm.exception.code))


def meta_model(shapes):
    """Build ComfyUI's MiniMaxH3 model on the meta device from header shapes (no weights loaded)."""
    c = comfy()
    sd = {k: torch.empty(s, device="meta") for k, s in shapes.items()}
    mc = c.model_detection.model_config_from_unet(sd, "")
    with torch.device("meta"):
        return mc.get_model(sd, "", device=torch.device("meta"))


class ComfyKeyMapTest(unittest.TestCase):
    def assert_comfy_loads_everything(self, model, lora_sd, expected_targets):
        c = comfy()
        key_map = c.lora.model_lora_keys_unet(model, {})
        with self.assertLogs(level="WARNING") as logs:
            logging.warning("sentinel")
            patches = c.lora.load_lora(lora_sd, key_map)
        self.assertEqual([m for m in logs.output if "not loaded" in m], [])
        self.assertEqual(set(patches), {f"{t}.weight" for t in expected_targets})
        return c, patches

    def test_tiny_model_key_map_and_patch_math(self):
        with tempfile.TemporaryDirectory() as d:
            src, curve = diffusers_lora(), curve_lora()
            save_file(src, f"{d}/l.safetensors")
            save_file(curve, f"{d}/c.safetensors")
            ck = native_checkpoint(True)
            save_file(ck, f"{d}/k.safetensors")
            with redirect_stdout(io.StringIO()):
                conv.convert(f"{d}/l.safetensors", f"{d}/o.safetensors", f"{d}/c.safetensors", f"{d}/k.safetensors")
            out = load_file(f"{d}/o.safetensors")
        model = meta_model({k: v.shape for k, v in ck.items()})
        want = expected_deltas(src, curve)
        c, patches = self.assert_comfy_loads_everything(model, out, want)
        for target, d in want.items():  # ComfyUI's own patch math at strength 1.0
            w = c.lora.calculate_weight([(1.0, patches[f"{target}.weight"], 1.0, None, None)],
                                        torch.zeros_like(d), f"{target}.weight")
            self.assertLess(((w - d).norm() / d.norm()).item(), 1e-2, target)

    def test_full_size_key_map_from_checkpoint_header(self):
        if not Path(H3_CHECKPOINT).is_file():
            self.skipTest(f"no H3 checkpoint at {H3_CHECKPOINT}")
        shapes = conv.native_shapes(H3_CHECKPOINT)
        if any(k.endswith(".comfy_quant") for k in shapes):
            self.skipTest("quantized checkpoint: its ops create weights only on load, so a meta model has no keys")
        model = meta_model(shapes)
        # one tiny placeholder per converted key: load_lora matches names, shapes are checked by convert()
        keys = [f"diffusion_model.{t}.lora_{s}.weight"
                for t in [f"blocks.{n}.{m}" for n in range(50) for m in ("attn.qkv_proj", "attn.out_proj", "mlp.fc1", "mlp.fc2", "adaln_proj.linear")]
                + [f"token_refiner.blocks.{n}.{m}" for n in range(2) for m in ("attn.qkv_proj", "attn.out_proj", "mlp.fc1", "mlp.fc2")]
                for s in "AB"]
        targets = {k.rsplit(".lora_", 1)[0] for k in keys}
        for t in targets:
            self.assertIn(t.removeprefix("diffusion_model.") + ".weight", shapes)
        self.assert_comfy_loads_everything(model, {k: torch.zeros(1, 1) for k in keys}, targets)


if __name__ == "__main__":
    unittest.main()
