"""Save real CPU test pixels via core and DaSiWa savers using a DEAS-resolved prefix; no model/service."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys

root=Path(__file__).resolve().parents[1]
comfy=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve()
out.mkdir(parents=True,exist_ok=True)
js="""import {outputPrefix,defaultOutputNaming} from './src/lib/outputNaming.ts';
console.log(outputPrefix(defaultOutputNaming,{type:'image',seed:42,model:'folder/My Model.safetensors'},new Date(2026,0,2,3,4,5)));"""
prefix=subprocess.check_output(['node','--experimental-strip-types','--input-type=module','-e',js],cwd=root,text=True).strip()
assert prefix=='image/2026-01-02/03-04-05-42-My-Model',prefix
sys.argv=['output-naming-probe','--cpu']
sys.path.insert(0,str(comfy))
import folder_paths
import nodes
import torch
from PIL import Image
folder_paths.set_output_directory(str(out))
pack=comfy/'custom_nodes/ComfyUI-DaSiWa-Nodes'
sys.path.insert(0,str(pack/'nodes'))
spec=importlib.util.spec_from_file_location('naming_metadata_probe',pack/'nodes/nodes_metadata.py')
assert spec and spec.loader
metadata=importlib.util.module_from_spec(spec)
spec.loader.exec_module(metadata)
adapter_spec=importlib.util.spec_from_file_location('deas_output_naming',root/'src-tauri/src/output_naming.py')
adapter=importlib.util.module_from_spec(adapter_spec)
# The probe has no server instance; only its registration point is stubbed.
import server
from types import SimpleNamespace
server.PromptServer.instance=SimpleNamespace(add_on_prompt_handler=lambda handler:None)
adapter_spec.loader.exec_module(adapter)
nodes.NODE_CLASS_MAPPINGS['DaSiWa_MetadataImageSaver']=metadata.DaSiWa_MetadataImageSaver
request={'extra_data':{'extra_pnginfo':{'deas_output_naming':True}}}
assert adapter.prepare(request) is request
wrapped=nodes.SaveImage.save_images
adapter.prepare(request)
assert nodes.SaveImage.save_images is wrapped
paths=[]
for saver in (nodes.SaveImage(),metadata.DaSiWa_MetadataImageSaver()):
 for _ in range(2):
  kwargs={} if isinstance(saver,nodes.SaveImage) else {'file_format':'png','compression':44,'save_output':True,'prompt':{'7':{'class_type':'DaSiWa_MetadataImageSaver','inputs':{'filename_prefix':prefix}}}}
  saved=saver.save_images(extra_pnginfo={'deas_output_naming':True},images=torch.zeros((1,8,8,3)),filename_prefix=prefix,**kwargs)
  entry=saved['ui']['images'][0]
  path=out/entry['subfolder']/entry['filename']
  assert entry['subfolder']=='image/2026-01-02',entry
  assert entry['filename'].startswith('03-04-05-42-My-Model-') and entry['filename'].endswith('.png') and '_' not in entry['filename'],entry
  assert path not in paths,'counter reused a filename'
  with Image.open(path) as image:assert image.size==(8,8)
  paths.append(path)
# Unmarked standalone saver calls retain their original naming.
plain=nodes.SaveImage().save_images(images=torch.zeros((1,8,8,3)),filename_prefix='standalone')
assert plain['ui']['images'][0]['filename'].endswith('_.png')
assert len(list((out/'image/2026-01-02').glob('*.png')))>=4
print(json.dumps({'prefix':prefix,'saved':[str(p) for p in paths]},indent=2))
