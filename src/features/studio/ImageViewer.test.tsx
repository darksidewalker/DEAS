import {cleanup,fireEvent,render,screen} from '@testing-library/react';
import {afterEach,beforeEach,expect,test,vi} from 'vitest';
import {I18nProvider} from '../../i18n/I18nProvider';
import {ImageViewer} from './ImageViewer';

beforeEach(()=>{
 localStorage.setItem('deas.locale.v1','en');
 vi.spyOn(HTMLElement.prototype,'getBoundingClientRect').mockReturnValue({left:0,top:0,width:800,height:600} as DOMRect);
});
afterEach(()=>{cleanup();vi.restoreAllMocks();localStorage.clear();});
function mount(width=100,height=50){
 const close=vi.fn();render(<I18nProvider><ImageViewer src="fixture.png" alt="picture" onClose={close}/></I18nProvider>);
 const image=screen.getByRole('dialog').querySelector('img')!;
 Object.defineProperties(image,{naturalWidth:{value:width},naturalHeight:{value:height}});fireEvent.load(image);
 return {close,image,box:document.querySelector('.wb-viewer-box')!};
}
test.each([[100,50,8],[100,200,3],[4000,1000,.2]])('fit fills the available edge without cropping (%i × %i)',(width,height,scale)=>{
 const {image}=mount(width,height);expect(image.style.transform).toContain(`scale(${scale})`);
 fireEvent.click(screen.getByRole('button',{name:'100%'}));expect(image.style.transform).toContain('scale(1)');
 fireEvent.click(screen.getByRole('button',{name:'Fit'}));expect(image.style.transform).toContain(`scale(${scale})`);
});
test('tiny images stay zoomable after an upscaled edge-fit',()=>{
 const {image,box}=mount(1,1);expect(image.style.transform).toContain('scale(600)');
 fireEvent.wheel(box,{deltaY:-100,clientX:200,clientY:150});
 expect(Number(image.style.transform.match(/scale\(([^)]+)\)/)![1])).toBeGreaterThan(600);
});
test('backdrop closes, while image/toolbar clicks and zoom do not',()=>{
 const {close,image,box}=mount();fireEvent.click(image);fireEvent.click(screen.getByRole('button',{name:'Zoom in'}));
 expect(close).not.toHaveBeenCalled();const before=image.style.transform;
 fireEvent.wheel(box,{deltaY:100,clientX:200,clientY:150});expect(image.style.transform).not.toBe(before);
 fireEvent.click(box);expect(close).toHaveBeenCalledTimes(1);
});
test.each(['.wb-viewer-tools','.wb-viewer'])('empty overlay background closes (%s)',selector=>{
 const {close}=mount();fireEvent.click(document.querySelector('.wb-viewer-name')!);expect(close).not.toHaveBeenCalled();
 fireEvent.click(document.querySelector(selector)!);expect(close).toHaveBeenCalledTimes(1);
});
test('dragging the picture onto the backdrop does not dismiss the viewer',()=>{
 const {close,image,box}=mount();
 fireEvent(image,new MouseEvent('pointerdown',{bubbles:true,button:0,clientX:100,clientY:100}));
 fireEvent(window,new MouseEvent('pointermove',{clientX:150,clientY:130}));fireEvent(window,new MouseEvent('pointerup'));
 fireEvent.click(box);expect(close).not.toHaveBeenCalled();
 fireEvent.click(box);expect(close).toHaveBeenCalledTimes(1);
});
