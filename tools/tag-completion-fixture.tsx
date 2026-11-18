/** Real prompt controls with synthetic IPC; never contacts a model or reads user data. */
import {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {I18nProvider} from '../src/i18n/I18nProvider';
import {PromptTagOptions} from '../src/features/studio/PromptTagOptions';
import {PromptTextarea} from '../src/features/studio/PromptTextarea';
import '../src/styles.css';
import '../src/features/studio/workbench.css';
import '../src/features/forge/forge.css';
function Fixture(){const [value,setValue]=useState(''),[negative,setNegative]=useState('');return <main style={{padding:'16px',paddingTop:'30vh',height:'100vh',boxSizing:'border-box',overflow:'hidden'}}><div style={{display:'flex',gap:'12px'}}><div className='wb-prompt' style={{width:'50%'}}><label>PROMPT</label><PromptTextarea aria-label='Positive' root='/fixture/env' target='anima' value={value} onChange={e=>setValue(e.target.value)}/>{['Expand','Copy','Clear'].map((name,i)=><button key={name} className={'wb-prompt-expand '+['','wb-prompt-copy','wb-prompt-clear'][i]} aria-label={name}>{name[0]}</button>)}<PromptTagOptions root='/fixture/env' modelsDir='/fixture/ComfyUI/models'/><button className='forge-anchor forge-hammer' aria-label='Forge'>⚒</button></div><div className='wb-prompt' style={{width:'50%'}}><label>NEGATIVE</label><PromptTextarea aria-label='Negative' root='/fixture/env' target='anima' value={negative} onChange={e=>setNegative(e.target.value)}/></div></div></main>;}
createRoot(document.getElementById('fixture-root')!).render(<I18nProvider><Fixture/></I18nProvider>);
