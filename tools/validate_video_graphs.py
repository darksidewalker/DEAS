"""Offline validation of the DEAS video graphs against the real ComfyUI checkout (no server, no GPU, custom nodes loaded).
Model/file names are swapped for ones the extra-model-paths config lists so combo checks pass; the point is node names, input names and link types."""
import asyncio, json, sys, os
GRAPHS = sys.argv[1] if len(sys.argv) > 1 else '/home/darksidewalker/.hermes/cache/scratch/deas_video_graphs.json'  # read before argv is replaced for ComfyUI
sys.argv = ['probe', '--cpu', '--extra-model-paths-config', '/data/Downloads/deas-environment/deas-models.yaml']
os.chdir('/data/GitHub/ComfyUI'); sys.path.insert(0, '/data/GitHub/ComfyUI')
import comfy.options; comfy.options.enable_args_parsing()
import folder_paths, utils.extra_config
utils.extra_config.load_extra_path_config('/data/Downloads/deas-environment/deas-models.yaml')
import server
loop = asyncio.new_event_loop(); asyncio.set_event_loop(loop)
from app.assets.manager import default_asset_manager
server.PromptServer(loop, default_asset_manager())  # custom nodes register routes on PromptServer.instance at import time
import nodes, execution
loop.run_until_complete(nodes.init_extra_nodes(init_custom_nodes=True))
graphs = json.load(open(GRAPHS))
first = lambda kind: (folder_paths.get_filename_list(kind) or ['MISSING'])[0]
pick = {'unet': [n for n in folder_paths.get_filename_list('diffusion_models')], 'te': folder_paths.get_filename_list('text_encoders'), 'vae': folder_paths.get_filename_list('vae'), 'img': folder_paths.get_filename_list('input') if 'input' in folder_paths.folder_names_and_paths else [], 'lup': folder_paths.get_filename_list('latent_upscale_models')}
def sub(name, wants):
    for cand in pick[wants]:
        if all(k in cand.lower() for k in name):
            return cand
    return pick[wants][0] if pick[wants] else 'MISSING'
swap = {'LTX2/ltx.safetensors': sub(['ltx'], 'unet'), 'WAN22/high.safetensors': sub(['high'], 'unet'), 'WAN22/low.safetensors': sub(['low'], 'unet'), 'MiniMaxH3/fl2va.safetensors': sub(['h3'], 'unet'),
        'gemma_3_12B_it_fp8.safetensors': sub(['gemma'], 'te'), 'ltx-2.3_text_projection_bf16.safetensors': sub(['projection'], 'te'), 'umt5_xxl_fp8.safetensors': sub(['umt5'], 'te'), 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors': sub(['minimax'], 'te'),
        'LTX2/video_vae.safetensors': sub(['ltx', 'video'], 'vae'), 'LTX2/audio_vae.safetensors': sub(['ltx', 'audio'], 'vae'), 'Wan/wan_2.1_vae.safetensors': sub(['wan'], 'vae'), 'MiniMaxH3/video_vae.safetensors': sub(['h3', 'video'], 'vae'), 'MiniMaxH3/audio_vae.safetensors': sub(['h3', 'audio'], 'vae'),
        'ltx-2.3-spatial-upscaler-x2-1.1.safetensors': sub(['spatial'], 'lup')}
images = sorted(os.listdir(folder_paths.get_input_directory()))
image = next((f for f in images if f.lower().endswith(('.png', '.jpg', '.webp'))), 'MISSING')
# Video-to-video needs a top-level input video (core LoadVideo lists only those): a scratch input folder with a
# 1 s ffmpeg test clip, so the real input folder stays untouched.
scratch = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'deas-validate-input')
os.makedirs(scratch, exist_ok=True)
import shutil, subprocess
shutil.copy(os.path.join(folder_paths.get_input_directory(), image), os.path.join(scratch, image))
if not os.path.exists(os.path.join(scratch, 'source.mp4')):
    subprocess.run(['ffmpeg', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=24:duration=1', '-pix_fmt', 'yuv420p', os.path.join(scratch, 'source.mp4')], check=True)
folder_paths.set_input_directory(scratch)
ok = True
for family, g in graphs.items():
    text = json.dumps(g)
    for a, b in swap.items():
        text = text.replace(json.dumps(a)[1:-1], b.replace('\\', '\\\\'))
    text = text.replace('"ref.png"', json.dumps(image)).replace('"first.png"', json.dumps(image)).replace('"deas-inputs/a.png"', json.dumps(image))
    g = json.loads(text)
    result = loop.run_until_complete(execution.validate_prompt('deas-probe', g, None))
    valid, error, outputs, node_errors = result[0], result[1], result[2], result[3]
    print(f"{family}: valid={valid} outputs={outputs}")
    if not valid:
        ok = False
        print('ERR', error.get('message') if isinstance(error, dict) else error, (error.get('details') if isinstance(error, dict) else '')[:300])
        for nid, e in node_errors.items():
            print('NODE', nid, g[nid]['class_type'], json.dumps(e.get('errors'), ensure_ascii=False)[:600])
print('ALL VALID' if ok else 'INVALID')
