import { consumeGenerationRequest } from '../src/store/catalogue/generationLanding.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { generationState, generationTag, generationFilterState } from '../src/store/catalogue/generationState.js';
import { normalizeEntry } from '../src/store/catalogue/entryModel.js';
import { formatTags } from '../src/store/catalogue/formatTag.js';
import { filterControls } from '../src/store/catalogue/filterState.js';
import { evaluateCard, normalizeFilters } from '../src/store/catalogue/filters.js';
import { createCatalogueOpenApi } from '../src/store/catalogue/catalogueOpenApi.js';

for (const state of ['unknown','upToDate','modifiedSince']) test(`generation evidence: ${state}`,()=>{
  const raw={id:'c',values:{title:'A'},exemplars:[{id:'p',format:'project',state:'available',availability:'available',generation:{state,outputExemplarId:'o'}}]};
  const card=normalizeEntry(raw);
  assert.equal(card.exemplars[0].generation.state,state);
  assert.equal(Boolean(evaluateCard(card,normalizeFilters({packStates:['modifiedSince']}))),state==='modifiedSince');
  assert.equal(generationTag({state}).regenerate,state==='modifiedSince');
  assert.equal(generationTag({state}).reason?.key ?? null,state==='modifiedSince'?'catalogue:generation.modified.reason':null);
  assert.equal(formatTags(card.exemplars)[0].regenerate,state==='modifiedSince');
  assert.equal(generationFilterState(card.exemplars),state==='modifiedSince'?'modifiedSince':null);
  const control=filterControls([card]).find(c=>c.family==='packStates');
  assert.equal(control.unavailable,false);
  assert.deepEqual(control.values,state === 'modifiedSince' ? ['modifiedSince'] : [],'only states present in the catalogue are offered');
});
test('unknown state is never inferred from a UUID or dates',()=>{
  const card=normalizeEntry({exemplars:[{format:'project',modifiedAt:999,observation:{identity:{reliable:true,value:'same'}}},{format:'zip',modifiedAt:1,observation:{identity:{reliable:true,value:'same'}}}]});
  assert.equal(card.exemplars[0].generation.state,'unknown');
  assert.equal(card.packState,null);
  assert.equal(formatTags([{format:'zip',available:true,generation:{state:'modifiedSince'}}])[0].regenerate,false,'the regeneration dot belongs only to projects');
  assert.deepEqual(generationState({state:'invented'}),{state:'unknown',outputExemplarId:null});
});
test('recordGeneration is a typed IPC call after the host success callback',async()=>{
  const calls=[];
  const api=createCatalogueOpenApi({invoke:async(command,args)=>{calls.push({command,args});return {recorded:false,reason:'outputNotCovered'};}});
  assert.deepEqual(await api.recordGeneration({projectPath:'/a.mbah',outputPath:'/b.zip'}),{recorded:false,reason:'outputNotCovered'});
  assert.deepEqual(calls,[{command:'catalogue_record_generation',args:{projectPath:'/a.mbah',outputPath:'/b.zip'}}]);
});

test('open-and-generate waits for the editor and is consumed once, including effect replay',()=>{
  const request={};
  const waiting={consumed:null,catalogueActive:true,editorReady:false};
  assert.equal(consumeGenerationRequest(request,waiting).generate,false);
  assert.equal(consumeGenerationRequest(request,{...waiting,catalogueActive:false}).generate,false);
  assert.equal(consumeGenerationRequest(request,{...waiting,editorReady:true}).generate,false);
  const landed=consumeGenerationRequest(request,{...waiting,catalogueActive:false,editorReady:true});
  assert.equal(landed.generate,true);
  assert.equal(consumeGenerationRequest(request,{consumed:landed.consumed,catalogueActive:false,editorReady:true}).generate,false);
});
