import {expect,test} from 'vitest';
import {adjustPeopleBox} from './PeopleBoxes';
import {readPeopleBoxes} from '../../lib/forge';

test('box movement preserves size at image edges; resize clamps at 2% and the source frame',()=>{
 const box:[number,number,number,number]=[0.25,0.25,0.75,0.75];
 expect(adjustPeopleBox(box,9,-9,false)).toEqual([0.5,0,1,0.5]);
 expect(adjustPeopleBox(box,-9,9,true)).toEqual([0.25,0.25,0.27,1]);
 expect(box).toEqual([0.25,0.25,0.75,0.75]);
});

test('minimum boxes survive strict validation after resizing and movement, including near one',()=>{
 const resized=adjustPeopleBox([0.01,0.25,0.5,0.75],-1,0,true);
 const minimum=adjustPeopleBox([0.01,0.98,0.5,1],-1,-1,true);
 for(const box of [resized,minimum,adjustPeopleBox(minimum,0.42,-0.3,false),adjustPeopleBox(minimum,9,9,false),adjustPeopleBox(minimum,-9,-9,false)]){
  expect(readPeopleBoxes([{n:1,box}])).not.toBeNull();
  expect(box[2]-box[0]).toBeGreaterThanOrEqual(0.02);
  expect(box[3]-box[1]).toBeGreaterThanOrEqual(0.02);
  expect(box.every(v=>v>=0&&v<=1)).toBe(true);
 }
});

test('box imports reject invalid coordinates, identities and payload shape without mutating valid input',()=>{
 const boxes=[{n:32,box:[0,0,1,1]}];
 expect(readPeopleBoxes(boxes)).toEqual(boxes);
 expect(readPeopleBoxes([])).toEqual([]);
 for(const raw of [null,{},'[]',[null],[{n:0,box:[0,0,1,1]}],[{n:1,box:[0,0,NaN,1]}],[{n:1,box:[0,0,Infinity,1]}],[{n:1,box:[0,0,1]}],Array.from({length:33},(_,i)=>({n:i+1,box:[0,0,1,1]}))])expect(readPeopleBoxes(raw)).toBeNull();
});
