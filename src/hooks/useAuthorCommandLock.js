// Le raccord React du verrou de commandes : une table gardée, branchée partout.
//
// La règle vit dans `advancedAuthoring/commandLock.js`, sans React, pour être
// éprouvée sans monter d'interface. La ref conserve le lecteur de la session,
// pas l'état affiché : acquisition et libération sont visibles avant le rendu.

import { useRef } from 'react';

import { lockAuthorCommands } from '../store/advancedAuthoring/commandLock.js';
import { logger } from '../utils/logger.js';

export function useAuthorCommandLock({ isLocked, commands }) {
  const readLockRef = useRef(isLocked);
  readLockRef.current = isLocked;
  return lockAuthorCommands(
    commands,
    () => readLockRef.current(),
    (name) => logger.info(`advanced:command-held command=${name}`),
  );
}
