// Windows : seule la racine renvoyée par spawn est enregistrée. L'API native
// taskkill /T gère son arbre. Le repli autorisé cible uniquement les exécutables
// sous src-tauri/target de ce clone ; les ports servent uniquement à vérifier.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { win32 } from 'node:path';
import { REPO_DIR } from './config.mjs';

export function isRepositoryDevExecutable(executable, repoDir) {
  if (typeof executable !== 'string' || !win32.isAbsolute(executable)) return false;
  // Les chemins d'exécutables Win32 sont insensibles à la casse ; une frontière
  // de répertoire exclut target-autre et les target des autres clones.
  const relative = win32.relative(win32.resolve(repoDir, 'src-tauri', 'target'), executable);
  return relative !== '' && relative !== '..' && !relative.startsWith('..\\') && !win32.isAbsolute(relative);
}

export function createCampaignProcessManager({
  platform = process.platform, run = spawnSync, repoDir = REPO_DIR,
  isPortOccupied = null, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
  now = Date.now, cleanupTimeoutMs = 30_000,
} = {}) {
  const checkPort = isPortOccupied ?? (port => {
    // Endpoints TCP IPv4 et IPv6, sans récupérer leurs propriétaires.
    const script = `$ErrorActionPreference = 'Stop'; @([System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners() | Where-Object Port -eq ${port}).Count -gt 0 | ConvertTo-Json -Compress`;
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error('Vérification des ports E2E impossible : ' + (result.stderr || result.error || result.status));
    return JSON.parse(result.stdout);
  });

  function identity(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('PID E2E invalide');
    const script = `$ErrorActionPreference = 'Stop'; $p = Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}'; `
      + `if ($p) { @{pid=$p.ProcessId; created=$p.CreationDate.ToUniversalTime().ToString('o'); executablePath=$p.ExecutablePath} | ConvertTo-Json -Compress }`;
    const result = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
    if (result.status !== 0) throw new Error(`Lecture du PID E2E impossible : ${result.stderr || result.error || result.status}`);
    const value = result.stdout.trim();
    return value ? JSON.parse(value) : null;
  }

  function readRoots(file) {
    if (!existsSync(file)) return { version: 1, roots: [] };
    const registry = JSON.parse(readFileSync(file, 'utf8'));
    // Les anciens registres incluaient des descendants découverts : ils ne
    // peuvent jamais autoriser une mise à mort avec le nouveau contrat.
    if (registry.version !== 1 || !Array.isArray(registry.roots)
      || registry.roots.some(root => !Number.isSafeInteger(root.pid) || root.pid <= 0
        || typeof root.created !== 'string' || !root.created)) {
      throw new Error('Registre E2E incompatible : seules les racines lancées sont admises');
    }
    return registry;
  }

  async function stopVerified(process, tree) {
    const args = ['/PID', String(process.pid), ...(tree ? ['/T'] : []), '/F'];
    const result = run('taskkill', args, { encoding: 'utf8', windowsHide: true });
    const deadline = now() + cleanupTimeoutMs;
    let retriedRoot = false;
    for (;;) {
      const current = identity(process.pid);
      // taskkill /T peut échouer sur un enfant déjà terminé. Seule l'identité
      // encore vivante constitue un refus ; un PID réattribué ne nous appartient plus.
      if (!current || current.created !== process.created) return;
      if (tree && result.status !== 0 && !retriedRoot) {
        // /T peut avoir arrêté les enfants mais laissé npm/cmd vivant.
        // L'identité vient d'être revérifiée, le repli reste limité à la racine.
        run('taskkill', ['/PID', String(process.pid), '/F'], { encoding: 'utf8', windowsHide: true });
        retriedRoot = true;
      }
      if (now() >= deadline) throw new Error(`Nettoyage de la racine E2E ${process.pid} impossible : processus toujours vivant après ${cleanupTimeoutMs} ms ; ${result.stderr || result.error || result.status}`);
      await sleep(250);
    }
  }

  const manager = {
    registerCampaignProcess(file, rootPid) {
      if (platform !== 'win32') return;
      const registry = readRoots(file);
      const root = identity(rootPid);
      if (!root || root.pid !== rootPid) throw new Error(`PID lancé non enregistré : ${rootPid}`);
      if (!registry.roots.some(entry => entry.pid === root.pid && entry.created === root.created)) registry.roots.push(root);
      writeFileSync(file + '.tmp', JSON.stringify(registry, null, 2) + '\n');
      renameSync(file + '.tmp', file);
    },
    async cleanupCampaignProcesses(file) {
      if (platform !== 'win32' || !existsSync(file)) return;
      for (const root of readRoots(file).roots) {
        const current = identity(root.pid);
        if (!current || current.created !== root.created) continue;
        await stopVerified(root, true);
      }
    },
    async cleanupAppProcesses(file) {
      if (platform !== 'win32') return;
      await manager.cleanupCampaignProcesses(file);
      // Contrainte native : npm/cmd peut terminer avant son binaire de dev.
      // Ce repli autorisé est borné au target de CE clone, jamais à un port.
      const script = "$ErrorActionPreference = 'Stop'; ConvertTo-Json -Compress -InputObject @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.CreationDate } | ForEach-Object { @{pid=$_.ProcessId; created=$_.CreationDate.ToUniversalTime().ToString('o'); executablePath=$_.ExecutablePath} })";
      const listed = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true });
      if (listed.status !== 0) throw new Error(`Inventaire des exécutables de dev impossible : ${listed.stderr || listed.error || listed.status}`);
      for (const process of JSON.parse(listed.stdout)) {
        if (!isRepositoryDevExecutable(process.executablePath, repoDir)) continue;
        const current = identity(process.pid);
        if (!current || current.created !== process.created || !isRepositoryDevExecutable(current.executablePath, repoDir)) continue;
        await stopVerified(current, false);
      }
      const deadline = now() + cleanupTimeoutMs;
      for (;;) {
        const ports = [1420, 9222];
        const occupied = await Promise.all(ports.map(checkPort));
        const remaining = ports.filter((_, index) => occupied[index]);
        if (!remaining.length) return;
        if (now() >= deadline) throw new Error(`Nettoyage E2E échoué : ports ${remaining.join(', ')} toujours occupés après ${cleanupTimeoutMs} ms`);
        await sleep(500);
      }
    },
  };
  return manager;
}

export const { registerCampaignProcess, cleanupAppProcesses } = createCampaignProcessManager();
