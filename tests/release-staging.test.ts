import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,mkdirSync,chmodSync,cpSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';

test('release staging rejects dirty/existing destinations and excludes stale bundles/targets',{skip:process.platform!=='linux'},()=>{
 const root=mkdtempSync(join(tmpdir(),'deas-release-'));
 try{
  cpSync(new URL('../build-linux.sh',import.meta.url),join(root,'build-linux.sh'));
  writeFileSync(join(root,'package.json'),JSON.stringify({version:'1.2.3'}));
  mkdirSync(join(root,'node_modules'));mkdirSync(join(root,'bin'));
  for(const [name,body] of Object.entries({
   npm:'exit 0',rustc:'echo rustc-mock',
   cargo:`if [ "$1" = xwin ]; then\n [ -f enable-xwin ] || exit 1\n [ "$2" != build ] || { mkdir -p src-tauri/target/x86_64-pc-windows-msvc/release; printf windows > src-tauri/target/x86_64-pc-windows-msvc/release/deas.exe; }\n exit 0\nfi\nmkdir -p src-tauri/target/release\nprintf binary > src-tauri/target/release/deas`,
   npx:`[ ! -f fail-bundle ] || exit 1\nif [ "$2" = bundle ]; then\n [ "$*" = 'tauri bundle --target x86_64-pc-windows-msvc --bundles nsis --ci --no-sign' ]\n mkdir -p src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis\n printf installer > src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/fresh_x64-setup.exe\nelse\n mkdir -p src-tauri/target/release/bundle/{deb,appimage}\n printf deb > src-tauri/target/release/bundle/deb/fresh.deb\n printf image > src-tauri/target/release/bundle/appimage/fresh.AppImage\nfi`,
  })){const path=join(root,'bin',name);writeFileSync(path,'#!/usr/bin/env bash\nset -e\n'+body+'\n');chmodSync(path,0o755);}
  const git=(...args:string[])=>execFileSync('git',args,{cwd:root});
  git('init','-q');git('add','build-linux.sh','package.json');git('-c','user.name=Test','-c','user.email=test@example.test','commit','-qm','fixture');
  writeFileSync(join(root,'.git','info','exclude'),'bin/\nnode_modules/\nartifacts/\nsrc-tauri/\nfail-bundle\n');
  const run=(...args:string[])=>spawnSync('bash',['build-linux.sh',...args],{cwd:root,env:{...process.env,PATH:join(root,'bin')+':'+process.env.PATH},encoding:'utf8'});
  writeFileSync(join(root,'untracked'),'dirty');
  assert.notEqual(run('--release').status,0,'untracked sources must reject release');
  assert.equal(existsSync(join(root,'artifacts')),false,'guard runs before build');
  assert.equal(run().status,0,'plain builds permit dirty sources');
  rmSync(join(root,'untracked'));
  writeFileSync(join(root,'package.json'),JSON.stringify({version:'1.2.4'}));
  assert.notEqual(run('--release').status,0,'tracked changes must reject release');
  git('checkout','--','package.json');
  const deb=join(root,'src-tauri/target/release/bundle/deb');mkdirSync(deb,{recursive:true});
  writeFileSync(join(deb,'stale.deb'),'stale');
  execFileSync('touch',['-t','200001010000',join(deb,'stale.deb')]);
  writeFileSync(join(root,'fail-bundle'),'fail');
  assert.notEqual(run('--release').status,0);
  const releases=join(root,'artifacts/releases');
  assert.deepEqual(readdirSync(releases),[],'failed staging is removed');
  rmSync(join(root,'fail-bundle'));
  const result=run('--release');assert.equal(result.status,0,result.stderr);
  const dest=join(releases,'v1.2.3');
  assert.deepEqual(readdirSync(dest).sort(),['BUILD-MANIFEST.json','SHA256SUMS','deas-linux-amd64','fresh.AppImage','fresh.deb']);
  assert.deepEqual(JSON.parse(readFileSync(join(dest,'BUILD-MANIFEST.json'),'utf8')).targets,['x86_64-unknown-linux-gnu']);
  execFileSync('sha256sum',['-c','SHA256SUMS'],{cwd:dest});
  writeFileSync(join(dest,'user-file'),'preserve');
  assert.notEqual(run('--release').status,0);
  assert.equal(readFileSync(join(dest,'user-file'),'utf8'),'preserve');
  rmSync(dest,{recursive:true});
  writeFileSync(join(root,'enable-xwin'),'enabled');
  writeFileSync(join(root,'.git','info','exclude'),readFileSync(join(root,'.git','info','exclude'),'utf8')+'enable-xwin\n');
  const cross=run('--release');assert.equal(cross.status,0,cross.stderr);
  assert.deepEqual(JSON.parse(readFileSync(join(dest,'BUILD-MANIFEST.json'),'utf8')).targets,['x86_64-unknown-linux-gnu','x86_64-pc-windows-msvc']);
  execFileSync('7z',['t',join(dest,'DEAS_1.2.3_windows_x64-portable.zip')]);
  execFileSync('sha256sum',['-c','SHA256SUMS'],{cwd:dest});
 }finally{rmSync(root,{recursive:true,force:true});}
});
