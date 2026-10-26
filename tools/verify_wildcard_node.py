"""Exercise DEAS-compiled wildcard inputs through the real node and real PNG saver, without models or a running service."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import types

root=Path(__file__).resolve().parents[1]
pack=Path(sys.argv[1]).resolve()
out=Path(sys.argv[2]).resolve()
out.mkdir(parents=True,exist_ok=True)
sys.argv=['wildcard-probe','--cpu']
sys.path[:0]=[str(pack.parents[1]),str(pack/'nodes')]
# Only the node's optional route registration is disabled; its real build/library code runs unchanged.
server=types.ModuleType('server')
server.PromptServer=None
sys.modules['server']=server
def load(name,path):
 spec=importlib.util.spec_from_file_location(name,path)
 assert spec is not None and spec.loader is not None
 module=importlib.util.module_from_spec(spec)
 spec.loader.exec_module(module)
 return module
wild=load('wildcard_probe',pack/'nodes/nodes_wildcard_preset_prompt_builder.py')
metadata=load('metadata_probe',pack/'nodes/nodes_metadata.py')
import folder_paths
import torch
from PIL import Image
folder_paths.set_output_directory(str(out))
rules={'style':'Booru','seed':7,'reroll':3,'token_budget':200,'auto_reroll':False,'selection_state':{'Character Selection/1 Girl/presets':{'enabled':True,'weight':1.2}}}
intent={'recipeId':'checkpoint-text-to-image-diagnostic','version':1,'positivePrompt':'manual base','negativePrompt':'blur','checkpoint':'fixture.safetensors','seed':42,'width':512,'height':512,'steps':1,'cfg':1,'sampler':'euler','scheduler':'normal','outputPrefix':'DEAS_wildcard_probe','wildcard':rules}
allow={'nodes':['CheckpointLoaderSimple','CLIPTextEncode','EmptyLatentImage','KSampler','VAEDecode','SaveImage','DaSiWa_WildcardPresetPromptBuilder','DaSiWa_MetadataConfig','DaSiWa_MetadataImageSaver'],'checkpoints':['fixture.safetensors'],'samplers':['euler'],'schedulers':['normal']}
js="import {compileRecipe} from './src/lib/execution.ts';process.stdout.write(JSON.stringify(compileRecipe("+json.dumps(intent)+","+json.dumps(allow)+").graph));"
graph=json.loads(subprocess.check_output(['node','--experimental-strip-types','--input-type=module','-e',js],cwd=root,text=True,encoding='utf-8'))
node=wild.DaSiWa_WildcardPresetPromptBuilder()
positive,negative=node.build(**graph['WP']['inputs'])
assert positive=='manual base, (1girl:1.2)',positive
assert negative=='blur',negative
assert node.build(**graph['WP']['inputs'])==(positive,negative)
assert wild.resolve_pattern('soft {red|blue} light',7,'test',3) in ('soft red light','soft blue light')
# Actual auto-reroll choices vary while preserving subjects; no JS reimplementation.
auto=dict(graph['WP']['inputs'],auto_reroll=True,selection_state=json.dumps({'Scene/Simple Lighting/wildcards':{'enabled':True,'weight':1}}))
choices={node.build(**auto)[0] for _ in range(64)}
assert len(choices)>1,choices
assert all(text.startswith('manual base, ') for text in choices)
a=node.IS_CHANGED(**auto);b=node.IS_CHANGED(**auto)
assert a!=b
# Resolve only WP links in the existing metadata config; no model/conditioning is needed to save a CPU pixel.
config=metadata.DaSiWa_MetadataConfig().gather(**{key:([positive,negative][value[1]] if isinstance(value,list) and value[0]=='WP' else value) for key,value in graph['M']['inputs'].items()})[0]
saved=metadata.DaSiWa_MetadataImageSaver().save_images(images=torch.zeros((1,1,1,3)),filename_prefix='DEAS_wildcard_probe',file_format='png',compression=44,save_output=True,metadata_config=config,prompt=graph)
file=out/saved['ui']['images'][0]['filename']
with Image.open(file) as image:
 parameters=image.info['parameters']
 assert parameters.startswith(positive+'\nNegative prompt: '+negative),parameters
 embedded=json.loads(image.info['prompt'])
 assert embedded['WP']['inputs']['selection_state']==graph['WP']['inputs']['selection_state']
print(json.dumps({'node':graph['WP']['class_type'],'positive':positive,'negative':negative,'autoRerollDistinct':len(choices),'png':str(file),'parameters':parameters},ensure_ascii=False,indent=2))
