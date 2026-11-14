#!/usr/bin/env python3
"""Convert the Open-H3-Regenerate-2K merged LoRA (Diffusers keys) to a ComfyUI-native MiniMax-H3 LoRA.

Usage (owned venv; no GPU needed):
  CUDA_VISIBLE_DEVICES= venv/bin/python -I tools/convert_open_h3_regenerate_lora.py \
      open_h3_regenerate_2k_lora.safetensors out.safetensors \
      [--curve sharp_curve_branches.safetensors] [--checkpoint <native H3 checkpoint>] [--drop turbo]

Mapping (source keys may carry a `transformer.` prefix; output keys are `diffusion_model.<target>.lora_A/B.weight`):
  transformer_blocks.N.attn.to_q|to_k|to_v    -> blocks.N.attn.qkv_proj   (fused, rows [q; k; v])
  transformer_blocks.N.attn.to_out.0          -> blocks.N.attn.out_proj
  transformer_blocks.N.ff.net.0.proj          -> blocks.N.mlp.fc1         (output halves swapped)
  transformer_blocks.N.ff.net.2               -> blocks.N.mlp.fc2
  token_refiner.refiner_blocks.N.<same>       -> token_refiner.blocks.N.<same>
  transformer_blocks.N.adaln_proj.linear.curve_A/B (curve file) -> blocks.N.adaln_proj.linear lora_A/B
    (only when the checkpoint is curve-form, i.e. has `adaln_t_table`; skipped with a reason otherwise).
    Note: the published curve_B tensors are all zero, as is the adaln lora_B of the upstream LMS Sharp v1.0 LoRA,
    so these branches currently add no delta; they are still mapped so a future non-zero file works.

Layout evidence (2026-11-13): FL2VA block 3 rows of the Diffusers base (Open-H3-Regenerate-2K base_model/transformer)
equal Comfy-Org/MiniMax-H3 minimax_h3_fl2va_bf16 bit for bit with qkv_proj rows 0/128/7168/14336 = to_q 0 / to_q 128 /
to_k 0 / to_v 0 (not per-head interleaved) and fc1 row 0 = ff.net.0.proj row 14336, fc1 row 14336 = ff row 0.
Code agrees: comfy/ldm/minimax/model.py splits qkv as q,k,v and swiglu chunks (gate, up); sglang minimax_h3
`_diffusers_h3_checkpoint` notes "Diffusers SwiGLU stores [value, gate]; the native fused MLP consumes [gate, value]".

--drop PART leaves a merged part out (e.g. turbo, for a base that already carries a Turbo distill). The upstream merge
concatenates refiner 384 / turbo 128 / sharp 64 along the rank axis in `lora/module_ranks.json` order, so keeping the
other parts' rank rows of A and columns of B is exact. Order evidence (2026-11-14): the sliced turbo delta equals the
published LightX2V FL2VA Turbo v1.2 (alpha/rank 8/128) delta with relative error 0 on sampled out_proj/fc2 modules.

Fused q/k/v: A = concat(A_q, A_k, A_v) rows, B = block-diagonal(B_q, B_k, B_v), so B @ A == stacked per-projection
deltas exactly. ComfyUI's MiniMaxH3 key map has no slice targets for LoRA files, hence the block-diagonal form.
No `.alpha` is written: comfy uses scale 1.0 without alpha, and the source has strengths folded (alpha == rank),
so strength 1.0 reproduces the source delta. Output is bf16, written tensor by tensor (input is never held whole).

License: the inputs and outputs derive from MiniMax H3 (MiniMax H3 Community License). Converted files are for local
use only; do not redistribute them.
"""
import argparse
import json
import os
import re
import struct
import sys

import torch
from safetensors import safe_open

QKV = {"to_q": 0, "to_k": 1, "to_v": 2}
FAMILY = {"attn.to_out.0": "attn.out_proj", "ff.net.0.proj": "mlp.fc1", "ff.net.2": "mlp.fc2"}
BLOCK = re.compile(r"^(?:transformer\.)?(transformer_blocks|token_refiner\.refiner_blocks)\.(\d+)\.(.+)\.(lora_A|lora_B|curve_A|curve_B)\.weight$")


def target_of(key):
    """Source key -> (native module, q/k/v slot or None, 'A'|'B'); raises on anything unknown."""
    m = BLOCK.match(key)
    if not m:
        raise ValueError(f"unsupported LoRA key: {key}")
    stack, n, mod, kind = m.groups()
    prefix = f"blocks.{n}" if stack == "transformer_blocks" else f"token_refiner.blocks.{n}"
    side = kind[-1]
    if kind.startswith("curve"):
        if mod != "adaln_proj.linear" or stack != "transformer_blocks":
            raise ValueError(f"unsupported curve key: {key}")
        return f"{prefix}.adaln_proj.linear", None, side
    if mod.startswith("attn.") and mod[5:] in QKV:
        return f"{prefix}.attn.qkv_proj", QKV[mod[5:]], side
    if mod in FAMILY:
        return f"{prefix}.{FAMILY[mod]}", None, side
    raise ValueError(f"unsupported LoRA module: {key}")


def read_header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        header = json.loads(f.read(n))
    header.pop("__metadata__", None)
    return header


def native_shapes(checkpoint):
    """Checkpoint header -> {native weight name: shape}, accepting bare, diffusion_model. or model.diffusion_model. keys."""
    out = {}
    for k, v in read_header(checkpoint).items():
        for p in ("model.diffusion_model.", "diffusion_model."):
            if k.startswith(p):
                k = k[len(p):]
                break
        out[k] = v["shape"]
    return out


def keep_ranks(lora, drop):
    """module_ranks.json beside the LoRA -> {source module: (rank indices of the parts not dropped, total rank)}."""
    path = os.path.join(os.path.dirname(os.path.abspath(lora)), "module_ranks.json")
    if not os.path.exists(path):
        raise ValueError(f"--drop needs {path} (lora/module_ranks.json from the Open-H3-Regenerate-2K repo)")
    with open(path) as f:
        ranks = json.load(f)
    keep = {}
    for module, info in ranks.items():
        parts = info["parts"]
        if set(drop) - set(parts):
            raise ValueError(f"{module}: unknown part(s) {sorted(set(drop) - set(parts))}; has {list(parts)}")
        if sum(parts.values()) != info["rank"]:
            raise ValueError(f"{module}: parts {parts} do not add up to rank {info['rank']}")
        idx, start = [], 0
        for name, r in parts.items():  # concatenated along the rank axis in this order
            if name not in drop:
                idx.extend(range(start, start + r))
            start += r
        if not idx:
            raise ValueError(f"{module}: --drop leaves no rank")
        keep[module] = (torch.tensor(idx), info["rank"])
    return keep


def plan(sources, keep=None):
    """[(file handle, path)] -> {target: {slot: {'A': (handle, key), 'B': ...}}} with shape checks."""
    groups = {}
    for f in sources:
        for key in f.keys():
            target, slot, side = target_of(key)
            entry = groups.setdefault(target, {}).setdefault(slot, {})
            if side in entry:
                raise ValueError(f"duplicate {side} for {target} slot {slot}: {key}")
            entry[side] = (f, key)
    for target, slots in groups.items():
        want = {0, 1, 2} if target.endswith("qkv_proj") else {None}
        if set(slots) != want:
            raise ValueError(f"{target}: expected parts {sorted(map(str, want))}, got {sorted(map(str, slots))}")
        for slot, e in slots.items():
            if set(e) != {"A", "B"}:
                raise ValueError(f"{target} slot {slot}: missing lora_A or lora_B")
            a, b = (e[s][0].get_slice(e[s][1]).get_shape() for s in "AB")
            if len(a) != 2 or len(b) != 2 or a[0] != b[1]:
                raise ValueError(f"{target} slot {slot}: incompatible A {a} / B {b}")
            key = e["A"][1]
            if keep is not None and ".lora_" in key:  # curve branches are separate modules, never rank-merged
                module = key.removeprefix("transformer.").rsplit(".lora_", 1)[0]
                if module not in keep:
                    raise ValueError(f"module_ranks.json has no {module}")
                e["keep"], rank = keep[module]
                if a[0] != rank:
                    raise ValueError(f"{module}: rank {a[0]} != module_ranks.json rank {rank}")
                a, b = [len(e["keep"]), a[1]], [b[0], len(e["keep"])]
            e["shapes"] = (a, b)
    return groups


def out_shapes(slots):
    parts = [slots[s]["shapes"] for s in sorted(slots, key=lambda s: -1 if s is None else s)]
    ins = {a[1] for a, _ in parts}
    if len(ins) != 1:
        raise ValueError(f"q/k/v input dims differ: {ins}")
    rank = sum(a[0] for a, _ in parts)
    return [rank, ins.pop()], [sum(b[0] for _, b in parts), rank]


def build(target, slots):
    """Load one target's source factors (fp32) and return native (A, B) in bf16."""
    def get(s, side):
        t = slots[s][side][0].get_tensor(slots[s][side][1]).float()
        k = slots[s].get("keep")
        return t if k is None else t.index_select(0 if side == "A" else 1, k)
    if target.endswith("qkv_proj"):
        As = [get(s, "A") for s in (0, 1, 2)]
        Bs = [get(s, "B") for s in (0, 1, 2)]
        return torch.cat(As, 0).bfloat16(), torch.block_diag(*Bs).bfloat16()
    a, b = get(None, "A"), get(None, "B")
    if target.endswith("mlp.fc1"):
        h = b.shape[0] // 2  # Diffusers [value, gate] -> native [gate, value]
        b = torch.cat((b[h:], b[:h]), 0)
    return a.bfloat16(), b.bfloat16()


def convert(lora, out, curve=None, checkpoint=None, log=print, drop=()):
    if os.path.exists(out):
        raise FileExistsError(f"refusing to overwrite existing file: {out}")
    if curve and not checkpoint:
        raise ValueError("--curve needs --checkpoint (curve branches only apply to curve-form checkpoints)")
    shapes = native_shapes(checkpoint) if checkpoint else None
    handles = [safe_open(lora, framework="pt")]
    if curve:
        if "adaln_t_table" in shapes:
            handles.append(safe_open(curve, framework="pt"))
            log(f"curve branches: applied ({curve})")
        else:
            log("curve branches: skipped - checkpoint has no adaln_t_table (not curve-form), "
                "so blocks.N.adaln_proj.linear does not take the 8-D curve input")
    groups = plan(handles, keep_ranks(lora, drop) if drop else None)
    if drop:
        log(f"dropped part(s): {', '.join(drop)}")
    if not checkpoint:
        log("checkpoint: not given, target names/shapes not verified")

    layout, offset = [], 0
    for target in sorted(groups):
        a_shape, b_shape = out_shapes(groups[target])
        if shapes is not None:
            have = shapes.get(target + ".weight")
            if have is None:
                raise ValueError(f"checkpoint has no {target}.weight")
            if list(have) != [b_shape[0], a_shape[1]]:
                raise ValueError(f"{target}: delta {[b_shape[0], a_shape[1]]} != checkpoint weight {have}")
        for side, shape in (("A", a_shape), ("B", b_shape)):
            size = shape[0] * shape[1] * 2
            layout.append((f"diffusion_model.{target}.lora_{side}.weight", shape, offset, offset + size))
            offset += size
    meta = {"format": "lora", "source": os.path.basename(lora),
            "note": "Open-H3-Regenerate-2K converted to native MiniMax-H3 keys; strength 1.0 = source delta"
                    + (f" without {', '.join(drop)}" if drop else ""),
            "license": "MiniMax H3 Community License - local use only, do not redistribute"}
    header = {"__metadata__": meta, **{k: {"dtype": "BF16", "shape": s, "data_offsets": [b, e]} for k, s, b, e in layout}}
    blob = json.dumps(header, separators=(",", ":")).encode()
    blob += b" " * (-len(blob) % 8)

    with open(out, "xb") as f:  # x: never overwrite, even on a race
        try:
            f.write(struct.pack("<Q", len(blob)) + blob)
            for i, target in enumerate(sorted(groups)):
                a, b = build(target, groups[target])
                for t in (a, b):
                    f.write(t.contiguous().view(torch.uint8).numpy().tobytes())
                if (i + 1) % 20 == 0 or i + 1 == len(groups):
                    log(f"  {i + 1}/{len(groups)} modules")
        except BaseException:
            f.close()
            os.unlink(out)  # only ever our own partial file (created with "x")
            raise
    log(f"wrote {out}: {len(groups)} modules, {len(layout)} tensors, {(offset + len(blob) + 8) / 2**30:.2f} GiB")
    return [k for k, *_ in layout]


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("lora", help="open_h3_regenerate_2k_lora.safetensors (Diffusers keys)")
    p.add_argument("output", help="output .safetensors (must not exist)")
    p.add_argument("--curve", help="sharp_curve_branches.safetensors (needs --checkpoint)")
    p.add_argument("--checkpoint", help="native H3 checkpoint; header only is read to verify targets/shapes")
    p.add_argument("--drop", action="append", default=[], metavar="PART",
                   help="leave a merged part out, e.g. turbo (reads lora/module_ranks.json beside the LoRA); repeatable")
    args = p.parse_args(argv)
    try:
        convert(args.lora, args.output, args.curve, args.checkpoint, drop=tuple(args.drop))
    except (ValueError, FileExistsError) as e:
        sys.exit(f"error: {e}")


if __name__ == "__main__":
    main()
