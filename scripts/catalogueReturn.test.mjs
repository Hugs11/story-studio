import test from 'node:test';
import assert from 'node:assert/strict';
import { runner } from './reactHookDriver.mjs';
import './tauriDiskHarness.mjs';
const { useProjectLifecycle } = await import('../src/hooks/useProjectLifecycle.js');

for (const outcome of ['cancelled','failed','saved','backgroundCancelled','locked']) {
  test(`return to catalogue: ${outcome}`,async()=>{
    const calls=[];
    const ref=()=>({current:'old'});
    const options={
      store:{resetProject:()=>calls.push('reset')},
      confirmBackgroundWork:async()=>{calls.push('background');return outcome!=='backgroundCancelled';},
      askSaveBeforeLeaveCurrent:async()=>{calls.push('saveGuard');return outcome==='saved';},
      handleSave:()=>{}, onOpenCatalogue:()=>calls.push('catalogue'),
      setMediaLibraryPaths:()=>calls.push('library'),savedSnapshotRef:ref(),autoSavePathRef:ref(),autoSaveSnapshotRef:ref(),
      setAutoSavedPath:()=>{},resetWorkSession:()=>calls.push('sessionReset'),sdStore:{clearDone:()=>calls.push('sdDone')},xttsStore:{clearDone:()=>calls.push('xttsDone')},setImportNotice:()=>{},
    };
    let hook;
    const app=runner(()=>{hook=useProjectLifecycle(options);});
    app.render();app.flush();
    const result=await hook.handleReturnToCatalogue();
    assert.equal(result,outcome==='saved');
    if(outcome==='saved') {
      assert.deepEqual(calls,['background','saveGuard','catalogue','reset','library','sessionReset','sdDone','xttsDone']);
      assert.equal(options.savedSnapshotRef.current,null);
    } else {
      assert.deepEqual(calls,outcome==='backgroundCancelled'?['background']:['background','saveGuard']);
      assert.equal(options.savedSnapshotRef.current,'old');
    }
    app.unmount();
  });
}
