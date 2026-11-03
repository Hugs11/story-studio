// Validation explicite du catalogue par le moteur Rust de production.
// Le harness est compilé dans une copie temporaire des seules sources : aucune
// modification native du dépôt, aucun média/modèle privé, aucune archive écrite.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

const root = fileURLToPath(new URL('../', import.meta.url));
const script = fileURLToPath(import.meta.url);

async function transport() {
  const { ADVANCED_EXAMPLES, createAdvancedExample } = await import('../src/store/advancedExamples/catalog.js');
  const { prepareExampleInsertion } = await import('../src/store/advancedExamples/transaction.js');
  const { createAdvancedProject, applyAdvancedGesture } = await import('../src/store/projectModel/authoring.js');
  const { documentFlatGraph, packFlatGraph } = await import('../src/tabs/EmulatorTab/flatGraph.js');
  const lines = createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const send = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const invoke = async (command, args = {}) => {
    send({ command, args });
    const line = await lines.next();
    assert.equal(line.done, false, 'transport Rust interrompu');
    const response = JSON.parse(line.value);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  };
  const readView = (project) => invoke('read', { payload: project.authoring.payload });
  const applyGesture = (project, gesture) => applyAdvancedGesture(project, gesture, { invokeCommand: invoke });
  const diagnostics = [];
  const previews = [];
  for (const metadata of ADVANCED_EXAMPLES) {
    const example = createAdvancedExample(metadata.id);
    const initial = createAdvancedProject({ payload: await invoke('create'), projectName: 'Nouveau pack' });
    const before = await readView(initial);
    const inserted = await prepareExampleInsertion(initial, example, { applyGesture, readView });
    assert.equal(inserted.report.example.replacedInitialRoot, true);
    const view = await readView(inserted.project);
    assert.equal(view.metadata.title.value, example.title, 'le pack neuf porte le titre de son exemple');
    assert.equal(inserted.project.projectName, example.title);
    previews.push({ id: metadata.id, title: metadata.title, project: inserted.project, view });
    assert.equal(view.stages.length, example.stages.length);
    assert.equal(view.actions.length, example.actions.length);
    assert.equal(view.entry.status, 'unique');
    assert.equal(view.stages.find((stage) => stage.path === view.entry.stagePath).uuid, inserted.report.example.entryUuid);
    assert(!view.stages.some((stage) => stage.uuid === before.stages[0].uuid));
    assert.deepEqual(view.packIdentity, before.packIdentity, 'identité du pack conservée');
    const readiness = await invoke('readiness', { payload: inserted.project.authoring.payload });
    assert.equal(readiness.blocked, false, `${metadata.id}: ${JSON.stringify(readiness.diagnostics)}`);
    const prepared = await invoke('prepare', { payload: inserted.project.authoring.payload });
    const standard = prepared.story;
    const documentGraph = documentFlatGraph(view, inserted.project);
    const packGraph = packFlatGraph(standard, '/archive-non-ecrite.zip');
    assert.equal(documentGraph.readiness.incompleteControls, 0);
    assert.equal(documentGraph.readiness.danglingTransitions, 0);
    assert.equal(packGraph.stages.size, documentGraph.stages.size);
    assert.equal(packGraph.actions.size, documentGraph.actions.size);
    for (const stage of documentGraph.stages.values()) {
      const exported = packGraph.stages.get(prepared.stageIdMap[stage.uuid]);
      assert(exported, 'l’Écran reste identifiable dans la copie standard');
      assert.equal(exported.name, stage.name);
      assert.deepEqual(exported.controlSettings, stage.controlSettings);
      for (const slot of ['okTransition', 'homeTransition']) {
        const transition = stage[slot];
        if (!transition) { assert.equal(exported[slot], null); continue; }
        assert.equal(exported[slot].optionIndex, transition.optionIndex);
        const documentTargets = documentGraph.actions.get(transition.actionNode).options
          .map((target) => prepared.stageIdMap[documentGraph.stages.get(target).uuid]);
        const exportedTargets = packGraph.actions.get(exported[slot].actionNode).options;
        assert.deepEqual(exportedTargets, documentTargets, 'ordre et destinations conservés à l’export');
      }
    }
    for (const stage of view.stages) {
      assert(stage.name.value.trim());
      assert.equal(stage.audio.presence === 'value', false);
      assert.equal(stage.image.presence === 'value', false);
    }
    // Deuxième insertion : aucun remaniement du projet existant et aucun UUID
    // recyclé ; la première entrée et les noms/contrôles/raccords restent intacts.
    const second = await prepareExampleInsertion(inserted.project, example, {
      applyGesture, readView, anchor: { x: 9000, y: 5000 },
    });
    assert.equal(second.report.example.replacedInitialRoot, false);
    const after = await readView(second.project);
    assert.equal(after.entry.stagePath, view.entry.stagePath);
    assert.equal(after.stages.length, view.stages.length * 2);
    assert.equal(after.actions.length, view.actions.length * 2);
    const oldIds = new Set(view.stages.map((stage) => stage.uuid));
    for (const uuid of second.report.example.stages) assert(!oldIds.has(uuid));
    for (const old of view.stages) {
      const current = after.stages.find((stage) => stage.uuid === old.uuid);
      assert.deepEqual(current, old);
    }
    assert.equal((await invoke('readiness', { payload: second.project.authoring.payload })).blocked, false);
    await invoke('prepare', { payload: second.project.authoring.payload });
    diagnostics.push({ id: metadata.id, stages: view.stages.length, actions: view.actions.length,
      readiness: readiness.diagnostics });
  }
  if (process.env.STORY_EXAMPLE_PREVIEW) {
    await fs.writeFile(process.env.STORY_EXAMPLE_PREVIEW, JSON.stringify(previews), { mode: 0o600 });
  }
  send({ command: 'done', diagnostics });
  process.stdin.destroy();
}

const rustHarness = String.raw`
#[cfg(test)]
mod native_examples_transport {
    use std::io::{BufRead, BufReader, Write};
    use std::process::{Command, Stdio};
    use serde_json::{json, Value};
    use crate::commands::project_codec;
    #[test]
    fn catalogue_transactions_readiness_and_standard_copy() {
        let mut child = Command::new(std::env::var("STORY_EXAMPLES_NODE").unwrap())
            .arg(std::env::var("STORY_EXAMPLES_SCRIPT").unwrap()).arg("--transport")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
        let mut input = child.stdin.take().unwrap();
        let mut output = BufReader::new(child.stdout.take().unwrap());
        loop {
            let mut line = String::new();
            assert!(output.read_line(&mut line).unwrap() > 0, "transport Node interrompu");
            let request: Value = serde_json::from_str(&line).unwrap();
            let args = &request["args"];
            let payload = || args["payload"].as_str().unwrap().to_string();
            let result = match request["command"].as_str().unwrap() {
                "done" => { println!("{}", request["diagnostics"]); break; },
                "create" => json!(project_codec::create_advanced_document("Nouveau pack".into(), None).unwrap()),
                "read" => serde_json::to_value(project_codec::read_advanced_graph_view(payload()).unwrap()).unwrap(),
                "readiness" => serde_json::to_value(project_codec::assess_advanced_payload_readiness(payload()).unwrap()).unwrap(),
                "apply_advanced_gesture" => serde_json::to_value(project_codec::apply_advanced_gesture(
                    payload(), serde_json::from_value(args["mediaBindings"].clone()).unwrap(),
                    serde_json::from_value(args["gesture"].clone()).unwrap()).unwrap()).unwrap(),
                "prepare" => {
                    let decoded = crate::native_pack::persistence::decode_authoring_payload(&payload()).unwrap();
                    let prepared = crate::native_pack::preparation::prepare_graph_document_for_export(&decoded).unwrap();
                    json!({"story":prepared.standard_value(), "stageIdMap":prepared.stage_id_map})
                },
                other => panic!("Commande inconnue : {other}"),
            };
            writeln!(input, "{}", json!({"result":result})).unwrap();
            input.flush().unwrap();
        }
        drop(input);
        assert!(child.wait().unwrap().success());
    }
}
`;

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'story-examples-native-'));
  const native = path.join(temporary, 'src-tauri');
  try {
    await fs.mkdir(native);
    for (const item of ['src', 'resources', 'capabilities', 'icons', 'windows', 'Cargo.toml', 'Cargo.lock', 'build.rs', 'tauri.conf.json']) {
      await fs.cp(path.join(root, 'src-tauri', item), path.join(native, item), { recursive: true });
    }
    // Ces liens ne sont que des entrées de compilation en lecture. Les sorties
    // cargo restent dans le target local existant ; rien n'est copié ni publié.
    const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
    await fs.symlink(path.join(root, 'src-tauri/tests'), path.join(native, 'tests'), directoryLinkType);
    for (const item of ['scripts', 'src', 'dist']) {
      await fs.symlink(path.join(root, item), path.join(temporary, item), directoryLinkType);
    }
    for (const item of ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'THIRD_PARTY_SOURCE_OFFER.md']) {
      await fs.copyFile(path.join(root, item), path.join(temporary, item));
    }
    await fs.appendFile(path.join(native, 'src/lib.rs'), rustHarness);
    const cargo = spawn('cargo', ['test', '--offline', '--lib', 'native_examples_transport', '--', '--nocapture'], {
      cwd: native, stdio: 'inherit', env: { ...process.env,
        CARGO_TARGET_DIR: path.join(root, 'src-tauri/target'),
        STORY_EXAMPLES_NODE: process.execPath, STORY_EXAMPLES_SCRIPT: script,
      },
    });
    const code = await new Promise((resolve, reject) => {
      cargo.once('error', reject); cargo.once('exit', resolve);
    });
    if (code !== 0) throw new Error(`Validation native échouée (${code}).`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv.includes('--transport')) await transport();
else await main();
