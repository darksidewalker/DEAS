"""Chromium warning layout and failed-job presentation; IPC fixtures, no native execution."""
import json
from pathlib import Path
import sys
from playwright.sync_api import sync_playwright, expect
from verify_projects import INIT
URL=(sys.argv[1] if len(sys.argv)>1 else 'http://127.0.0.1:4197').rstrip('/')
OUT=Path(sys.argv[2]) if len(sys.argv)>2 else Path.home()/'.hermes/cache/scratch/deas-view-warnings'
FAILURE=r"""
const originalInvoke=window.__TAURI_INTERNALS__.invoke;
let submittedIntent;
window.__TAURI_INTERNALS__.invoke=async(command,args={})=>{
 if(command==='native_workbench_run'){submittedIntent=structuredClone(args.intent);window.__calls.push({command,args});return window.__job={id:'fixture-failure',baseUrl:'http://127.0.0.1:7801/',promptId:'fixture',state:'failed',outputs:[],error:'node 5 (KSampler): RuntimeError: Missing checkpoint Select a compatible dependency.',intent:submittedIntent,generationReady:false};}
 return originalInvoke(command,args);
};
"""

def main():
 OUT.mkdir(parents=True,exist_ok=True)
 with sync_playwright() as p:
  browser=p.chromium.launch()
  for width in [1440,960,320]:
   normal=browser.new_page(viewport={'width':width,'height':1000})
   normal.add_init_script(INIT.replace('LOCALE',json.dumps('en'))+FAILURE)
   normal.goto(URL+'/tools/inpaint-fixture.html',wait_until='networkidle')
   stage=normal.locator('.wb-stage');before=stage.bounding_box()
   expect(normal.locator('.wb-stage-warning')).to_have_count(0)
   warning=browser.new_page(viewport={'width':width,'height':1000})
   warning.add_init_script(INIT.replace('LOCALE',json.dumps('en'))+"localStorage.setItem('deas.pref.studio.run.checkpoint',JSON.stringify('qwen3vl_4b_fp8_scaled.safetensors'));")
   warning.goto(URL+'/tools/inpaint-fixture.html',wait_until='networkidle')
   alert=warning.locator('.wb-stage > .wb-stage-warning')
   expect(alert).to_be_visible();expect(alert).to_contain_text('qwen3vl_4b_fp8_scaled.safetensors')
   assert alert.evaluate('e=>getComputedStyle(e).position')=='absolute'
   after=warning.locator('.wb-stage').bounding_box()
   assert all(abs(before[key]-after[key])<=1 for key in ['x','y','width','height']),(width,before,after)
   assert warning.locator('[role="alert"]').count()==1
   warning.screenshot(path=str(OUT/f'missing-{width}.png'),full_page=True)
   normal.locator('[data-run]').click()
   error=normal.locator('.wb-stage > .wb-stage-warning')
   expect(error).to_be_visible();expect(error).to_contain_text('Select a compatible dependency.')
   assert '\\n' not in error.inner_text()
   normal.evaluate('window.scrollTo(0,0)')
   failed_bounds=stage.bounding_box()
   assert all(abs(before[key]-failed_bounds[key])<=1 for key in ['x','y','width','height']),(width,before,failed_bounds)
   normal.screenshot(path=str(OUT/f'failed-{width}.png'),full_page=True)
   assert not normal.evaluate('window.__unexpected'),normal.evaluate('window.__unexpected')
   warning.close();normal.close()
  browser.close()
 print('PASS: missing-dependency and failed-job warnings stay inside a fixed View at 1440/960/320px (Chromium IPC fixtures).')

if __name__=='__main__':main()
