import { presentUserMessage } from '../../i18n/userMessage.js';
import { translateChecker } from '../../i18n/checkerPresentation.js';
// La readiness, lue en deux informations qui ne se confondent pas.
//
// `SUPPORTED` ne veut pas dire export autorisé : un document peut avoir toutes
// ses dimensions supportées et une décision d'auteur bloquante. Ce module
// sépare donc :
//
// - **le blocage**, dont `blocked` est l'unique autorité. Il vient de Rust, et
//   rien ici ne le recalcule, ne l'assouplit ni ne le durcit ;
// - **la qualification**, `interoperability` et ses dimensions, qui dit ce que
//   ce document a de qualifié — et où la qualification n'a pas pu être
//   observée.
//
// Le classement des diagnostics par niveau est un **miroir d'affichage** de
// `ReadinessDiagnostic::level()` : il sert à mettre en tête ce qui bloque, et
// rien d'autre. Il ne décide jamais si l'export part — la commande d'export
// refait ses propres vérifications et reste l'autorité, comme le plan l'exige.
// Un écart entre ce classement et `blocked` est un défaut d'affichage, pas une
// permission accordée ou retirée.

const READINESS_SOURCE = Object.freeze({
  DECODE: 'decode',
  GRAPH_INTEGRITY: 'graph-integrity',
  AUTHORING: 'authoring',
  READINESS: 'readiness',
});

export const READINESS_LEVEL = Object.freeze({
  INFO: 'INFO',
  WARNING: 'WARNING',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  ERROR: 'ERROR',
});

const QUALIFICATION = Object.freeze({
  UNTESTED: 'UNTESTED',
  PREPARED: 'PREPARED',
  SUPPORTED: 'SUPPORTED',
});

// Clés des libellés, résolues à chaque lecture (accesseurs des lignes).
const QUALIFICATION_LABELS = Object.freeze({
  UNTESTED: 'checker:readiness.qualification.untested',
  PREPARED: 'checker:readiness.qualification.prepared',
  SUPPORTED: 'checker:readiness.qualification.supported',
});

const SOURCE_LABELS = Object.freeze({
  decode: 'checker:readiness.source.decode',
  'graph-integrity': 'checker:readiness.source.integrity',
  authoring: 'checker:readiness.source.authoring',
  readiness: 'checker:readiness.source.readiness',
});

const LEVEL_LABELS = Object.freeze({
  INFO: 'checker:readiness.level.info',
  WARNING: 'checker:readiness.level.warning',
  ACTION_REQUIRED: 'checker:readiness.level.action',
  ERROR: 'checker:readiness.level.error',
});

// Valeur hors table : la donnée brute, comme avant.
function label(table, value, fallback = value) {
  return Object.hasOwn(table, value ?? '') ? translateChecker(table[value]) : fallback;
}

// Le niveau d'un diagnostic, tel que chaque source le sérialise. `graph-integrity`
// n'en porte pas : Rust le fixe à `Error` dans `level()`, et cette absence est
// la seule valeur déduite ici.
export function readinessDiagnosticLevel(diagnostic) {
  switch (diagnostic?.source) {
    case READINESS_SOURCE.DECODE:
      return diagnostic.severity === 'ERROR' ? READINESS_LEVEL.ERROR : READINESS_LEVEL.WARNING;
    case READINESS_SOURCE.GRAPH_INTEGRITY:
      return READINESS_LEVEL.ERROR;
    case READINESS_SOURCE.AUTHORING:
    case READINESS_SOURCE.READINESS:
      return diagnostic.level ?? READINESS_LEVEL.INFO;
    default:
      return READINESS_LEVEL.INFO;
  }
}

function readinessLevelLabel(level) {
  return label(LEVEL_LABELS, level);
}

function blocksDisplay(level) {
  return level === READINESS_LEVEL.ERROR || level === READINESS_LEVEL.ACTION_REQUIRED;
}

function codeOf(diagnostic) {
  return typeof diagnostic?.code === 'string' ? diagnostic.code : String(diagnostic?.code ?? '');
}

// La readiness rendue affichable. `blocked` est recopié tel quel : c'est le
// seul champ sur lequel l'interface a le droit de conclure « export refusé ».
export function summarizeReadiness(readiness) {
  if (!readiness) return null;
  const diagnostics = Array.isArray(readiness.diagnostics) ? readiness.diagnostics : [];
  const rows = diagnostics.map((diagnostic) => {
    const level = readinessDiagnosticLevel(diagnostic);
    return {
      source: diagnostic?.source ?? null,
      get sourceLabel() { return label(SOURCE_LABELS, diagnostic?.source, diagnostic?.source ?? translateChecker('checker:readiness.source.fallback')); },
      code: codeOf(diagnostic),
      path: diagnostic?.path ?? '',
      get message() { return presentUserMessage(diagnostic).message; },
      level,
      get levelLabel() { return readinessLevelLabel(level); },
      blocking: blocksDisplay(level),
      resolutions: Array.isArray(diagnostic?.resolutions) ? diagnostic.resolutions : [],
    };
  });

  const dimensions = Array.isArray(readiness.dimensions) ? readiness.dimensions : [];
  const unevaluated = Array.isArray(readiness.unevaluated) ? readiness.unevaluated : [];

  return {
    blocked: readiness.blocked === true,
    interoperability: readiness.interoperability ?? QUALIFICATION.UNTESTED,
    get interoperabilityLabel() {
      return label(QUALIFICATION_LABELS, readiness.interoperability, readiness.interoperability ?? translateChecker(QUALIFICATION_LABELS.UNTESTED));
    },
    // Les blocages d'abord, dans l'ordre où Rust les a rendus : l'ordre
    // rendu est une information, le réordonner par sévérité perdrait le lien
    // avec lui.
    blocking: rows.filter((row) => row.blocking),
    advisory: rows.filter((row) => !row.blocking),
    diagnostics: rows,
    dimensions: dimensions.map((dimension) => ({
      id: dimension?.id ?? '',
      qualification: dimension?.qualification ?? QUALIFICATION.UNTESTED,
      get qualificationLabel() { return label(QUALIFICATION_LABELS, dimension?.qualification); },
      evidence: Array.isArray(dimension?.evidence) ? dimension.evidence : [],
    })),
    // `UNTESTED` est une limite de qualification, pas un document invalide :
    // ces dimensions sont montrées comme « non observées », jamais comme des
    // erreurs.
    unevaluated: unevaluated.map((dimension) => ({
      id: dimension?.id ?? '',
      reason: dimension?.reason ?? '',
      lines: Array.isArray(dimension?.lines) ? dimension.lines : [],
    })),
  };
}
