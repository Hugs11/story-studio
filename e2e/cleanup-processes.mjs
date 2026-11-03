import { cleanupAppProcesses } from './lib/campaign-processes.mjs';
if (!process.argv[2]) throw new Error('Registre de PID requis');
await cleanupAppProcesses(process.argv[2]);
