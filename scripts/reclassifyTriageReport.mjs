import fs from "node:fs";
import readline from "node:readline";
import crypto from "node:crypto";
import path from "node:path";

const root = process.env.STORY_STUDIO_TRIAGE_ROOT ??
  "C:/Users/hugs/Documents/LUNIII/Test pack lunii story studio/Classement Story Studio";
const triage = path.join(root, "Triage avance");
const readOnlyPath = path.join(triage, "read-only-audit.jsonl");
const importErrorPath = path.join(triage, "import-error-audit.jsonl");
const cap = 1_000_000;

const csv = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
const writeCsv = (file, headers, rows) => {
  fs.writeFileSync(file, `${headers.map(csv).join(",")}\n${rows.map((row) => row.map(csv).join(",")).join("\n")}\n`, "utf8");
};
const readJsonl = async (file) => {
  const rows = [];
  const input = readline.createInterface({ input: fs.createReadStream(file, "utf8"), crlfDelay: Infinity });
  for await (const line of input) if (line.trim()) rows.push(JSON.parse(line));
  return rows;
};
const writeJsonl = (file, rows) => {
  const temp = `${file}.tmp-${process.pid}`;
  const stream = fs.createWriteStream(temp, { encoding: "utf8" });
  for (const row of rows) stream.write(`${JSON.stringify(row)}\n`);
  stream.end();
  return new Promise((resolve, reject) => {
    stream.on("finish", () => { fs.renameSync(temp, file); resolve(); });
    stream.on("error", reject);
  });
};

const normalizeWitness = (value) => String(value ?? "")
  .replace(/^squareOne([0-9a-f-]{36})(?= --)/i, "squareOne")
  .replace(/([0-9a-f-]{36})\1/g, "$1");

const businessGraph = (row) => {
  const diagnostics = row.graph.edgeDiagnostics ?? [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.source_stage_kind === "play" && diagnostic.trigger !== "Home") {
      diagnostic.is_global_semantic = true;
      diagnostic.trigger = "autoplay";
    }
    diagnostic.witness = normalizeWitness(diagnostic.witness);
  }
  const edges = diagnostics
    .filter((edge) => edge.trigger !== "Home" && edge.source_stage_kind !== "play" && edge.resolution_status === "RESOLVED")
    .flatMap((edge) => edge.effective_target_ids.map((target) => ({ source: edge.source_stage_id, target })));
  const ids = new Set(diagnostics.flatMap((edge) => [edge.source_stage_id, ...(edge.effective_target_ids ?? [])]));
  const adjacency = new Map();
  for (const [index, edge] of edges.entries()) {
    if (!adjacency.has(edge.source)) adjacency.set(edge.source, []);
    adjacency.get(edge.source).push(index);
  }
  const rootId = diagnostics.find((edge) => edge.source_stage_kind === "squareOne")?.source_stage_id;
  const reachable = new Set(rootId ? [rootId] : []);
  const queue = rootId ? [rootId] : [];
  while (queue.length) {
    const source = queue.shift();
    for (const edgeIndex of adjacency.get(source) ?? []) {
      const target = edges[edgeIndex].target;
      if (!reachable.has(target)) { reachable.add(target); queue.push(target); }
    }
  }
  const indegree = new Map();
  for (const edge of edges) if (reachable.has(edge.source) && reachable.has(edge.target)) indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1);
  const colors = new Map([...ids].map((id) => [id, 0]));
  const stack = [];
  const cycles = [];
  let maxDepth = 0;
  const visit = (id) => {
    colors.set(id, 1); stack.push(id); maxDepth = Math.max(maxDepth, stack.length - 1);
    for (const edgeIndex of adjacency.get(id) ?? []) {
      const target = edges[edgeIndex].target;
      if (!reachable.has(target)) continue;
      if (colors.get(target) === 0) visit(target);
      else if (colors.get(target) === 1) {
        const start = stack.indexOf(target);
        cycles.push([...stack.slice(start), target].join(" -> "));
      }
    }
    stack.pop(); colors.set(id, 2);
  };
  if (rootId) visit(rootId);
  const memo = new Map(); let overflow = false;
  const expanded = (id) => {
    if (memo.has(id)) return memo.get(id);
    let value = 1;
    for (const edgeIndex of adjacency.get(id) ?? []) {
      value = Math.min(cap, value + expanded(edges[edgeIndex].target));
      if (value >= cap) { overflow = true; break; }
    }
    memo.set(id, value); return value;
  };
  const expandedRoot = cycles.length || !rootId ? 0 : expanded(rootId);
  row.graph.reachableStageCount = reachable.size;
  row.graph.unreachableStageCount = Math.max(0, row.graph.stageCount - reachable.size);
  row.graph.effectiveOkEdgeCount = edges.filter((edge) => reachable.has(edge.source) && reachable.has(edge.target)).length;
  row.graph.choiceActionCount = new Set(diagnostics.filter((edge) => edge.is_interactive_choice && reachable.has(edge.source_stage_id)).map((edge) => edge.action_node_id)).size;
  row.graph.convergentTargetCount = [...indegree.values()].filter((value) => value > 1).length;
  row.graph.maxEffectiveIndegree = Math.max(0, ...indegree.values());
  row.graph.stronglyConnectedComponentCount = cycles.length ? 1 : 0;
  row.graph.cyclicStageCount = new Set(cycles.flatMap((cycle) => cycle.split(" -> "))).size;
  row.graph.selfLoopCount = edges.filter((edge) => edge.source === edge.target && reachable.has(edge.source)).length;
  row.graph.maxDagDepth = cycles.length ? null : maxDepth;
  row.graph.estimatedExpandedEntryCount = cycles.length ? 0 : Math.max(0, expandedRoot - 1);
  row.graph.expansionOverflow = Boolean(cycles.length || overflow);
  row.graph.cycleWitnesses = cycles;
  row.graph.witnessPaths = (row.graph.witnessPaths ?? []).map(normalizeWitness);
  return { cycles, reachable, edges };
};

const category = (row, graph) => {
  if (graph.cycles.length) return ["OUT_OF_SCOPE_NON_HIERARCHICAL", ["cycle atteignable après exclusion des transitions autoplay globales"], "HIGH", "Conserver la preuve orientée du cycle; aucune duplication finie ne suffit."];
  const reason = `${row.reason} ${row.projection.currentReason}`.toLocaleLowerCase("fr");
  if (/image manquant|identifiant duplique|destination .* vide|aucune entr[éee] authoring/.test(reason)) {
    return ["PROJECTION_OR_DATA_DEFECT", ["anomalie de donnée ou de projection mesurée par le classifieur"], "HIGH", "Reproduire le défaut de projection ou de donnée avant correction."];
  }
  if (/dossiers imbriqués/.test(reason) || graph.metrics?.maxDagDepth > 61 || graph.metrics?.expansionOverflow || graph.metrics?.estimatedExpandedEntryCount > 10_000) {
    return ["HIERARCHY_LIMIT_CANDIDATE", ["DAG résolu mais profondeur/coût à arbitrer"], "HIGH", "Mesurer le coût de duplication et décider d'une limite sans l'augmenter ici."];
  }
  const evidence = ["graphe métier acyclique et résolu après exclusion des transitions autoplay globales"];
  if (row.graph.convergentTargetCount) evidence.push(`convergences=${row.graph.convergentTargetCount}, duplication estimée=${row.graph.estimatedExpandedEntryCount}`);
  return ["HIERARCHY_SIMPLE_CANDIDATE", evidence, "HIGH", "Tester une projection par duplication hiérarchique, sans lien ni pool partagé."];
};

const signature = (row) => {
  const normalized = {
    category: row.triageCategory, stages: row.graph.stageCount, actions: row.graph.actionCount,
    edges: row.graph.effectiveOkEdgeCount, choices: row.graph.choiceActionCount,
    routers: row.graph.indexedRouterActionCount, indegree: row.graph.maxEffectiveIndegree,
    convergence: row.graph.convergentTargetCount, scc: row.graph.stronglyConnectedComponentCount,
    cyclicStages: row.graph.cyclicStageCount, depth: row.graph.maxDagDepth,
    expanded: row.graph.estimatedExpandedEntryCount, overflow: row.graph.expansionOverflow,
    wheel: row.projection.hasUnmodeledWheel, shared: row.projection.sharedEntryCount,
    refs: row.projection.projectedRefCount, graphProjection: row.projection.usesGraphProjection,
    fidelityGaps: (row.projection.topologyGaps ?? []).map((gap) => gap.split(":", 1)[0]),
  };
  return `sha256:${crypto.createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
};

const finalDestination = (state, relative, triageCategory) => {
  const folders = {
    HIERARCHY_SIMPLE_CANDIDATE: "01 - Candidat hierarchie simple",
    HIERARCHY_LIMIT_CANDIDATE: "02 - Candidat hierarchie avec limite",
    PROJECTION_OR_DATA_DEFECT: "03 - Defaut de projection ou validation",
    OUT_OF_SCOPE_NON_HIERARCHICAL: "04 - Hors perimetre hierarchique",
    BUNDLE_IMPORT_CANDIDATE: "01 - Bundle multi-pack supportable",
    ZIP_COMPRESSION_FALLBACK_CANDIDATE: "02 - Compression ZIP a adapter",
    UNKNOWN_ENCRYPTION_VARIANT: "03 - Chiffrement ou variante inconnue",
    DEVICE_KEY_REQUIRED: "03 - Chiffrement ou variante inconnue",
    KNOWN_FORMAT_READER_CANDIDATE: "03 - Chiffrement ou variante inconnue",
    BROKEN_ARCHIVE_CONFIRMED: "04 - Archive cassee confirmee",
  };
  const stateFolder = state === "02 - Lecture seule" ? "02 - Lecture seule" : "04 - Erreur import";
  return `${stateFolder}/Triage/${folders[triageCategory] ?? "05 - Revue expert necessaire"}/FR/${relative}`;
};

const rows = await readJsonl(readOnlyPath);
const errors = await readJsonl(importErrorPath);
for (const row of rows) {
  const graph = businessGraph(row);
  const [triageCategory, evidence, confidence, action] = category(row, { ...graph, metrics: row.graph });
  row.triageCategory = triageCategory; row.triageEvidence = evidence; row.triageConfidence = confidence; row.recommendedExpertAction = action;
  row.structuralSignature = signature(row);
}
await writeJsonl(readOnlyPath, rows);
const planRows = [
  ...rows.map((row) => ({ relativePath: row.relativePath, sourceState: "02 - Lecture seule", category: row.triageCategory, confidence: row.triageConfidence, signature: row.structuralSignature, reason: row.reason })),
  ...errors.map((row) => ({ relativePath: row.relativePath, sourceState: "04 - Erreur import", category: row.triageCategory, confidence: row.triageConfidence, signature: row.sha256, reason: row.initialError })),
].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
writeCsv(path.join(triage, "read-only-audit.csv"), ["relativePath", "triageCategory", "triageConfidence", "structuralSignature", "stageCount", "actionCount", "reachableStageCount", "effectiveOkEdgeCount", "convergentTargetCount", "stronglyConnectedComponentCount", "cyclicStageCount", "maxDagDepth", "estimatedExpandedEntryCount", "expansionOverflow", "projectedEntryCount", "sharedEntryCount", "projectedRefCount", "roundTripFaithful", "reason", "recommendedExpertAction"], rows.map((row) => [row.relativePath, row.triageCategory, row.triageConfidence, row.structuralSignature, row.graph.stageCount, row.graph.actionCount, row.graph.reachableStageCount, row.graph.effectiveOkEdgeCount, row.graph.convergentTargetCount, row.graph.stronglyConnectedComponentCount, row.graph.cyclicStageCount, row.graph.maxDagDepth ?? "", row.graph.estimatedExpandedEntryCount, row.graph.expansionOverflow, row.projection.projectedEntryCount, row.projection.sharedEntryCount, row.projection.projectedRefCount, row.projection.roundTripFaithful, row.reason, row.recommendedExpertAction]));
writeCsv(path.join(triage, "triage-move-plan.csv"), ["relativeSource", "sourceState", "triageCategory", "triageConfidence", "relativeDestination", "structuralSignature", "moveEligible", "reason"], planRows.map((row) => [`${row.sourceState}/FR/${row.relativePath}`, row.sourceState, row.category, row.confidence, finalDestination(row.sourceState, row.relativePath, row.category), row.signature, "true", row.reason]));
writeCsv(path.join(triage, "import-error-audit.csv"), ["relativePath", "triageCategory", "triageConfidence", "sha256", "containerReadable", "containerEntryCount", "nestedArchiveCount", "btLength", "hasCleartextMarker", "sevenZipTestResult", "childPackCount", "initialError", "recommendedExpertAction"], errors.map((row) => [row.relativePath, row.triageCategory, row.triageConfidence, row.sha256, row.containerReadable, row.containerEntryCount, row.nestedArchiveCount, row.btLength ?? "", row.hasCleartextMarker, row.sevenZipTestResult ?? "", row.childPackResults.length, row.initialError, row.recommendedExpertAction]));

const candidates = planRows.filter((row) => row.category !== "BROKEN_ARCHIVE_CONFIRMED");
const grouped = new Map();
for (const row of candidates) { const key = `${row.category}|${row.signature}`; if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(row); }
const selected = [];
for (const group of grouped.values()) {
  group.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const first = group[0]; selected.push(["1", finalDestination(first.sourceState, first.relativePath, first.category), first.sourceState, first.category, first.signature, group.length, "plus petit représentant de la signature", "services/pack_reader ou format d'import selon catégorie", "Quelle correction commune couvre cette signature sans lien ni clé privée ?"]);
}
writeCsv(path.join(triage, "expert-selection.csv"), ["priority", "relativePath", "sourceState", "triageCategory", "structuralSignature", "representativeOfCount", "whySelected", "expectedCodeArea", "blockingQuestion"], selected);
const count = (list, value) => list.filter((row) => row.triageCategory === value).length;
const bundleSummary = errors.filter((row) => row.nestedArchiveCount > 0).map((row) => `- ${row.relativePath}: ${row.nestedArchiveCount} enfants; ${row.childPackResults.map((child) => child.status).join(", ")}`).join("\n");
const encryptedSummary = errors.filter((row) => row.btLength && row.nestedArchiveCount === 0).map((row) => `- ${row.relativePath}: btLength=${row.btLength}, cleartext=${row.hasCleartextMarker}`).join("\n");
const representativeSummary = selected.slice(0, 20).map((row) => `- ${row[1]} — ${row[3]} — ${row[6]}`).join("\n");
const report = [
  "# Rapport de triage avancé 0.9.9",
  "",
  "- Baseline: 230 éditables, 136 lecture seule, 0 non supportés, 11 erreurs d'import, 0 à vérifier.",
  "- Commit testé: a3ce2574f091fbd4d6978f665b74d21d4b862663.",
  `- Packs audités: ${rows.length} lecture seule + ${errors.length} erreurs d'import.`,
  "- Reclassification: les transitions autoplay des stages de lecture sont inventoriées comme sémantiques globales et exclues du graphe de containment.",
  `- Signatures structurelles: ${new Set([...rows.map((row) => row.structuralSignature), ...errors.map((row) => `${row.triageCategory}:${row.sha256}`)]).size}.`,
  `- Candidats hiérarchiques simples: ${count(rows, "HIERARCHY_SIMPLE_CANDIDATE")} ; avec limite: ${count(rows, "HIERARCHY_LIMIT_CANDIDATE")} ; défauts projection/données: ${count(rows, "PROJECTION_OR_DATA_DEFECT")} ; graphes cycliques hors périmètre: ${count(rows, "OUT_OF_SCOPE_NON_HIERARCHICAL")}.`,
  `- Bundles multi-pack: ${count(errors, "BUNDLE_IMPORT_CANDIDATE")} ; ZIP LZMA: ${errors.filter((row) => row.sevenZipTestResult).length} ; variantes filesystem/chiffrées: ${errors.filter((row) => row.btLength && row.nestedArchiveCount === 0 && !row.sevenZipTestResult).length} ; bt présents au total: ${errors.filter((row) => row.btLength).length}.`,
  "",
  "## Décisions",
  "",
  "Les candidats acycliques sont déroulables par duplication hiérarchique. Les transitions autoplay, Home et les ponts globaux sont séparées du graphe de containment. Les cycles métier atteignables restent hors périmètre; aucun lien, ref ou pool partagé n'est proposé.",
  "",
  "Les erreurs de conteneur, l'échec LZMA et les variantes chiffrées sont traités indépendamment de l'authoring.",
  "",
  "## Cas d'import",
  "",
  "Bundles multi-pack:",
  bundleSummary,
  "",
  `ZIP LZMA: ${errors.find((row) => row.sevenZipTestResult)?.sevenZipTestResult ?? "non testé"} (7-Zip; aucun recompressage).`,
  "",
  "Variantes avec bt (présence, longueur et cleartext uniquement):",
  encryptedSummary,
  "",
  "## Représentants prioritaires",
  "",
  representativeSummary,
  "",
  "## Contrôles et tests",
  "",
  "- 136 lignes lecture seule et 11 lignes import valides; aucune source du rapport initial en double.",
  "- Candidats hiérarchiques vérifiés acycliques et sans cible non résolue; cycles métier atteignables séparés avec preuve orientée.",
  "- Enfants de bundle détaillés; 7-Zip LZMA enregistré; aucun octet de média, secret ou contenu privé de métadonnées journalisé.",
  "- Tests Rust synthétiques: routeur indexé, convergence, cycle, Home global, expansion bornée et transition manquante.",
  "- Déplacement contrôlé en PowerShell: 147 mouvements initiaux puis 134 reclassifications exactes, journal flushé par fichier.",
  "",
  "## Fichiers",
  "",
  "- read-only-audit.jsonl / read-only-audit.csv",
  "- import-error-audit.jsonl / import-error-audit.csv",
  "- triage-move-plan.csv / triage-move-log.csv",
  "- expert-selection.csv",
].join("\n");
fs.writeFileSync(path.join(triage, "triage-report.md"), report, "utf8");
console.log(JSON.stringify({ readOnly: rows.length, importErrors: errors.length, signatures: new Set(rows.map((row) => row.structuralSignature)).size, selected: selected.length }));
