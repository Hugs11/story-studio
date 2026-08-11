import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const EXTERNAL_SUITES = Object.freeze([
  {
    id: 'import-archive',
    allOf: ['STORY_STUDIO_PACK_ARCHIVE'],
    command: 'cargo test concurrent_external_pack_conversion_when_configured -- --ignored --nocapture',
  },
  {
    id: 'plain-folder',
    allOf: ['STORY_STUDIO_PLAIN_PACK_DIR'],
    command: 'cargo test converts_external_plain_pack_when_configured -- --ignored --nocapture',
  },
  {
    id: 'fidelity',
    anyOf: ['LUNII_FIDELITY_PACK', 'LUNII_FIDELITY_PACK_DIR'],
    command: 'cargo test fidelity_external_packs_from_env -- --ignored --nocapture',
  },
  {
    id: 'baseline',
    allOf: ['STORY_STUDIO_BASELINE_DIR'],
    command: 'cargo test baseline_import_metrics -- --ignored --nocapture',
  },
  {
    id: 'audio-reencode',
    allOf: ['SS_REENCODE_INPUTS', 'SS_REENCODE_OUTDIR', 'SS_FFMPEG'],
    command: 'cargo test reencode_sample_from_env -- --ignored --nocapture',
  },
  {
    id: 'checker-assets',
    allOf: ['SS_CHECK_ASSETS', 'SS_FFMPEG'],
    command: 'cargo test check_assets_from_env -- --ignored --nocapture',
  },
  {
    id: 'plan16',
    allOf: ['STORY_STUDIO_PLAN16_GRAPH_PACK'],
    command: 'cargo test plan16_graph_pack_from_env_is_read_only_without_native_graph -- --ignored --nocapture',
  },
  {
    id: 'suzanne',
    allOf: ['STORY_STUDIO_SUZANNE_PACK'],
    command: 'cargo test suzanne_pack_from_env_stays_authoring_editable -- --ignored --nocapture',
  },
  {
    id: 'authoring',
    allOf: ['STORY_STUDIO_AUTHORING_PACK'],
    command: 'cargo test authoring_pack_from_env_is_editable -- --ignored --nocapture',
  },
  {
    id: 'xtts',
    allOf: ['STORY_STUDIO_XTTS_TEST_DIR'],
    command: 'cargo test live_cpu_status_and_generation_use_finetuned_reference_voice -- --ignored --nocapture',
  },
]);

export function suiteReadiness(suite, env = process.env) {
  const missingAll = (suite.allOf ?? []).filter((name) => !env[name]);
  const anyReady = !suite.anyOf || suite.anyOf.some((name) => Boolean(env[name]));
  const missing = [
    ...missingAll,
    ...(!anyReady ? [`one of: ${suite.anyOf.join(', ')}`] : []),
  ];
  return { ready: missing.length === 0, missing };
}

function toolAvailable(command, args = ['--version']) {
  const result = spawnSync(command, args, { encoding: 'utf8', windowsHide: true });
  return result.status === 0;
}

export function buildPreflightReport(env = process.env) {
  return {
    platform: `${process.platform}/${process.arch}`,
    tools: {
      ffmpegOnPath: toolAvailable('ffmpeg'),
      sevenZipOnPath: toolAvailable(process.platform === 'win32' ? '7z.exe' : '7z'),
      cargoAudit: toolAvailable('cargo-audit'),
    },
    suites: EXTERNAL_SUITES.map((suite) => ({
      id: suite.id,
      command: suite.command,
      variables: [...(suite.allOf ?? []), ...(suite.anyOf ?? [])],
      ...suiteReadiness(suite, env),
    })),
  };
}

function printReport(report) {
  console.log(`Plateforme : ${report.platform}`);
  console.log(`Outils PATH : ffmpeg=${report.tools.ffmpegOnPath ? 'PRÉSENT' : 'ABSENT'}; 7-Zip=${report.tools.sevenZipOnPath ? 'PRÉSENT' : 'ABSENT'}; cargo-audit=${report.tools.cargoAudit ? 'PRÉSENT' : 'ABSENT'}`);
  for (const suite of report.suites) {
    console.log(`[${suite.ready ? 'READY' : 'SKIP'}] ${suite.id}`);
    console.log(`  variables : ${suite.variables.join(', ') || 'aucune'}`);
    if (!suite.ready) console.log(`  absentes : ${suite.missing.join(', ')}`);
    console.log(`  commande : (cd src-tauri && ${suite.command})`);
  }
}

function main(args) {
  const report = buildPreflightReport();
  printReport(report);
  const required = args
    .filter((arg) => arg.startsWith('--require='))
    .map((arg) => arg.slice('--require='.length));
  for (const id of required) {
    const suite = report.suites.find((candidate) => candidate.id === id);
    if (!suite) {
      console.error(`Suite externe inconnue : ${id}`);
      process.exitCode = 2;
    } else if (!suite.ready) {
      console.error(`Suite externe demandée mais incomplète : ${id} (${suite.missing.join(', ')})`);
      process.exitCode = 2;
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2));
}
