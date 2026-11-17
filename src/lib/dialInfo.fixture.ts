/**
 * Test fixture: the native `native_dial_catalog` answer for four dials of the development machine's catalog (public dial metadata,
 * `GET /mainodes/dials/catalog`, 2026-11-16; texts shortened) plus one entry built from the pack's schema: no dial file there carries
 * per-pipeline measurements (`pipelines`) yet.
 */
export const dayNight='dials/h3_day_night_hook.safetensors',inkWash='dials/h3_ink_wash.safetensors',impact='dials/h3_impact_frame.safetensors',motionDial='dials/h3_motion.safetensors',measuredDial='dials/h3_measured_look.safetensors';
const none={useful:null,overcook:null};
export const catalogFixture={dials:[
 {dial:dayNight,family:'MiniMax H3',mode:'post',info:{version:2,description:'Time of day: +1 dusk, +2 night with a blue cast. Measured on Pika H3 Flex, 1 seed.',negative:'bright midday',positive:'night',pipeline:'Pika H3 Flex 6-step',notes:'',neg:{useful:1.5,overcook:3},pos:{useful:1.5,overcook:3},evidence:'one-seed'}},
 {dial:inkWash,family:'MiniMax H3',mode:'post',info:{version:2,description:'Ink wash: the scene becomes a flowing black ink-wash painting on paper; negative goes to clean cel-shaded anime colour.',negative:'cel-shaded colour',positive:'ink wash',pipeline:'Pika H3 Flex 6-step, time rows k = 6, audio: protect',
  notes:'Best as a constant look on text to video: 1.5 to 2. On a seep in/out curve, 2 at k = 6 follows but re-composes the landscape (k = 2 smears the look over the clip). With a reference picture it draws nothing up to 6. One scene, seed 4242.',neg:none,pos:{useful:2,overcook:null},evidence:'one-seed'}},
 {dial:impact,family:'MiniMax H3',mode:'post',info:{version:2,description:'Impact frame: the anime hit flash. Best on a short pulse at the moment of contact. k = 2 drew no flash at 3.0.',negative:'normal shading',positive:'impact frame',pipeline:'Pika H3 Flex 6-step, time rows k = 6, audio: protect',
  notes:'Text to video: pulse 4.5 (a 0.5 s step at the hit) gives ~6 inverted ink frames and the shot comes back clean; constant 3 inks the whole clip.',neg:none,pos:{useful:4.5,overcook:8},evidence:'one-seed'}},
 {dial:motionDial,family:'MiniMax H3',mode:'post',info:{version:2,description:'',negative:'',positive:'',pipeline:'',notes:'',neg:none,pos:none,evidence:null}},
 {dial:measuredDial,family:'MiniMax H3',mode:'post',info:{version:2,description:'A look measured per pipeline (schema example, not a real file).',negative:'plain',positive:'styled',pipeline:'6-step',notes:'',neg:{useful:1,overcook:null},pos:{useful:2.3,overcook:null},evidence:'multi-seed',kind:'look',
  pipelines:{t2v:{useful:2,overcook:4,steps:6,evidence:'multi-seed',notes:'follows at 6, smears at 2'},ref2v:{useful:null,overcook:null,steps:40,evidence:null,notes:''},fl2v:{useful:3,overcook:null,evidence:'one-seed',notes:'no curve measured'}}}},
],dropped:0,truncated:false};
/**
 * Entries for the catalog's `mode` and `family`: a pre-refiner H3 dial (a LoRA-style dial file; the development machine has 15 such files beside
 * 126 post-refiner ones, read from the file headers on 2026-11-17) and dials of the two other families the pack supports there (56 MOSS-Image,
 * 3 Krea 2). The file names of the other families are examples.
 */
export const preDial='dials/h3_motion_lora.safetensors',kreaDial='dials/krea2_example_hook.safetensors',mossDial='dials/moss_example.safetensors',unlabelled='dials/h3_unlabelled.safetensors';
const bare={version:2,description:'',negative:'',positive:'',pipeline:'',notes:'',neg:none,pos:none,evidence:null};
export const familyFixture={dials:[
 {dial:preDial,family:'MiniMax H3',mode:'pre',info:bare},
 {dial:kreaDial,family:'Krea 2',mode:'post',info:bare},
 {dial:mossDial,family:'MOSS-Image',mode:'post',info:bare},
 // What native hands over when the pack's answer has no usable family or mode: empty strings.
 {dial:unlabelled,family:'',mode:'',info:bare},
],dropped:0,truncated:false};
