import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
test('native media producers delegate destinations and never join a flat workspace category', () => {
  const producers = [
    'piper/output.rs', 'xtts/output.rs', 'comfyui/jobs.rs',
    'project_files/recording.rs', 'project_files/audio/pipeline.rs',
    'project_files/audio/split.rs', 'project_files/audio/edit/operations.rs',
  ];
  for (const file of producers) {
    const source = read(`src-tauri/src/services/${file}`).split('#[cfg(test)]')[0];
    assert.doesNotMatch(source, /\.join\("(?:voix-generees|images-generees|fichiers-importes|enregistrements|zips-extraits)"\)/, file);
    assert.match(source, /media_output_dir/, file);
    assert.match(source, /project_destination/, file);
  }
});
test('frontend producers capture an output lease rather than a project filename prefix', () => {
  for (const file of [
    'src/hooks/useAiGeneration.js', 'src/hooks/useImportSession.js',
    'src/components/RecordModal/RecordModal.jsx',
    'src/components/AudioAssemblyModal/AudioAssemblyModal.jsx',
    'src/components/AudioSplitterModal/AudioSplitterModal.jsx',
    'src/components/AudioEditorModal/useStagedAudioEdit.js',
    'src/components/TextImageGenerator/generateTextImage.js',
    'src/components/ImageEditorModal/imageEditorExport.js',
  ]) {
    const source = read(file);
    assert.match(source, /projectMediaOutput/, file);
    assert.doesNotMatch(source, /addProjectPrefix\(/, file);
  }
  const aggregate = read('src/components/AggregatePacks/AggregatePacksFunnel.jsx');
  assert.match(aggregate, /create_session_workspace/);
  assert.doesNotMatch(aggregate, /projectDestination|projectMediaOutput/);
});
