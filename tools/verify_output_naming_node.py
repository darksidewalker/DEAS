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
assert prefix=='image/2026_01_02/03-04-05-42-My_Model',prefix
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
paths=[]
for saver in (nodes.SaveImage(),metadata.DaSiWa_MetadataImageSaver()):
 for _ in range(2):
  kwargs={} if isinstance(saver,nodes.SaveImage) else {'file_format':'png','compression':44,'save_output':True,'prompt':{'7':{'class_type':'DaSiWa_MetadataImageSaver','inputs':{'filename_prefix':prefix}}}}
  saved=saver.save_images(images=torch.zeros((1,8,8,3)),filename_prefix=prefix,**kwargs)
  entry=saved['ui']['images'][0]
  path=out/entry['subfolder']/entry['filename']
  assert entry['subfolder']=='image/2026_01_02',entry
  assert entry['filename'].startswith('03-04-05-42-My_Model_') and entry['filename'].endswith('_.png'),entry
  assert path not in paths,'counter reused a filename'
  with Image.open(path) as image:assert image.size==(8,8)
  paths.append(path)
assert len(list((out/'image/2026_01_02').glob('*.png')))>=4
print(json.dumps({'prefix':prefix,'saved':[str(p) for p in paths]},indent=2))
