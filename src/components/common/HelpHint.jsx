// Un « ? » discret à côté d'un réglage dont le sens ne va pas de soi : la
// bulle de l'application l'explique au survol, et au focus pour qui navigue
// au clavier. Le texte est aussi le nom accessible du bouton : un lecteur
// d'écran le lit sans survol.

import { Tooltip } from './Tooltip';
import './HelpHint.css';

export function HelpHint({ text }) {
  return (
    <Tooltip text={text} asChild wrap>
      <button type="button" className="help-hint" aria-label={text}>?</button>
    </Tooltip>
  );
}
