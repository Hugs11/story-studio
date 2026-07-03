//! Classification des arêtes natives (Étape 2c — verrou central).
//!
//! Deux étages strictement séparés (cf. plan §3) :
//!   A. `classify_stage_edges` — classe **statique** d'une arête (fonction pure du graphe,
//!      sans état de parcours) : Ok / ChoiceOption / Home / GlobalNight / Unresolved.
//!   B. `project_edge` — **décision de projection** (classe statique × état `placed`) :
//!      Containment / Reference / OutOfTree.
//!
//! Ce module n'est PAS branché sur l'import de prod : il sert uniquement d'ancrage de
//! mesure pour la baseline métriques (Étape 2d). D'où le gating `#[cfg(test)]` sur sa
//! déclaration dans `mod.rs` — il n'est compilé que pour les tests.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::transitions::transition_action_options;

/// Nature statique d'une arête sortante, indépendante du parcours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum EdgeClass {
    /// `okTransition` vers une action à 1 option (enchaînement narratif linéaire).
    Ok,
    /// `okTransition` vers une action à ≥2 options (chaque option est une arête de choix).
    ChoiceOption,
    /// `homeTransition` — ne rentre jamais dans l'arbre (badge).
    Home,
    /// Cible appartenant aux nœuds night-mode / retours globaux détectés.
    GlobalNight,
    /// Cible OK ne résolvant vers aucun stage connu.
    Unresolved,
}

/// Décision de placement dans l'arbre, fonction de la classe et de l'état du parcours.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Projection {
    /// Le nœud cible est possédé comme enfant (première visite).
    Containment,
    /// Le nœud cible est déjà placé ailleurs → une `ref`.
    Reference,
    /// L'arête ne produit ni nœud ni ref (Home, global, cassée).
    OutOfTree,
}

/// Une arête sortante classée statiquement (cible + classe).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct ClassifiedEdge {
    pub(super) target: String,
    pub(super) class: EdgeClass,
}

/// Étage A — classe statique des arêtes sortantes d'un stage (OK puis Home).
///
/// `global_nodes` = stages night-mode / retours globaux détectés, exclus de l'arbre.
pub(super) fn classify_stage_edges(
    stage: &Value,
    stages: &HashMap<&str, &Value>,
    actions: &HashMap<&str, &Value>,
    global_nodes: &HashSet<&str>,
) -> Vec<ClassifiedEdge> {
    let mut edges = Vec::new();

    let ok_targets = transition_action_options(stage.get("okTransition"), actions);
    let ok_base = if ok_targets.len() >= 2 {
        EdgeClass::ChoiceOption
    } else {
        EdgeClass::Ok
    };
    for target in ok_targets {
        let class = if global_nodes.contains(target) {
            EdgeClass::GlobalNight
        } else if !stages.contains_key(target) {
            EdgeClass::Unresolved
        } else {
            ok_base
        };
        edges.push(ClassifiedEdge {
            target: target.to_string(),
            class,
        });
    }

    for target in transition_action_options(stage.get("homeTransition"), actions) {
        edges.push(ClassifiedEdge {
            target: target.to_string(),
            class: EdgeClass::Home,
        });
    }

    edges
}

/// Étage B — décision de projection : classe statique × le fait que la cible soit déjà placée.
pub(super) fn project_edge(class: EdgeClass, target_placed: bool) -> Projection {
    match class {
        EdgeClass::Home | EdgeClass::GlobalNight | EdgeClass::Unresolved => Projection::OutOfTree,
        EdgeClass::Ok | EdgeClass::ChoiceOption => {
            if target_placed {
                Projection::Reference
            } else {
                Projection::Containment
            }
        }
    }
}

/// Compteurs de projection sur un graphe (ancrage de test + socle Étape 3 / baseline 2d).
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct ProjectionStats {
    pub(super) containment: usize,
    pub(super) reference: usize,
    pub(super) home: usize,
    pub(super) global: usize,
    pub(super) unresolved: usize,
}

/// Parcours DFS depuis `root` en ne suivant (pour descendre) que les arêtes Ok/ChoiceOption ;
/// Home/global/cassées sont comptées mais ne placent jamais de nœud. Pur, sans effet de bord
/// sur l'import. Les compteurs sont déterministes pour un graphe donné.
pub(super) fn project_graph(
    root: &str,
    stages: &HashMap<&str, &Value>,
    actions: &HashMap<&str, &Value>,
    global_nodes: &HashSet<&str>,
) -> ProjectionStats {
    let mut stats = ProjectionStats::default();
    let mut placed: HashSet<String> = HashSet::new();
    let mut stack: Vec<String> = Vec::new();
    if stages.contains_key(root) {
        placed.insert(root.to_string());
        stack.push(root.to_string());
    }

    while let Some(id) = stack.pop() {
        let Some(stage) = stages.get(id.as_str()) else {
            continue;
        };
        for ClassifiedEdge { target, class } in
            classify_stage_edges(stage, stages, actions, global_nodes)
        {
            match class {
                EdgeClass::Home => stats.home += 1,
                EdgeClass::GlobalNight => stats.global += 1,
                EdgeClass::Unresolved => stats.unresolved += 1,
                EdgeClass::Ok | EdgeClass::ChoiceOption => {
                    match project_edge(class, placed.contains(&target)) {
                        Projection::Containment => {
                            stats.containment += 1;
                            placed.insert(target.clone());
                            stack.push(target);
                        }
                        Projection::Reference => stats.reference += 1,
                        Projection::OutOfTree => {}
                    }
                }
            }
        }
    }

    stats
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stage(uuid: &str, ok_action: Option<&str>, home_action: Option<&str>) -> Value {
        let mut node = serde_json::json!({ "uuid": uuid, "controlSettings": {} });
        if let Some(action) = ok_action {
            node["okTransition"] = serde_json::json!({ "actionNode": action, "optionIndex": 0 });
        }
        if let Some(action) = home_action {
            node["homeTransition"] = serde_json::json!({ "actionNode": action, "optionIndex": 0 });
        }
        node
    }

    fn action(options: &[&str]) -> Value {
        serde_json::json!({ "options": options })
    }

    /// Convergence : root --choix--> {a, b} ; a --ok--> t ; b --ok--> t.
    /// `t` a un in-degree OK de 2 (1 nœud convergent, 1 arête de référence).
    fn convergent_graph() -> (Vec<Value>, Vec<(String, Value)>) {
        let stages = vec![
            stage("root", Some("act-root"), None),
            stage("a", Some("act-a"), None),
            stage("b", Some("act-b"), None),
            stage("t", None, None),
        ];
        let actions = vec![
            ("act-root".to_string(), action(&["a", "b"])),
            ("act-a".to_string(), action(&["t"])),
            ("act-b".to_string(), action(&["t"])),
        ];
        (stages, actions)
    }

    fn index<'a>(
        stages: &'a [Value],
        actions: &'a [(String, Value)],
    ) -> (HashMap<&'a str, &'a Value>, HashMap<&'a str, &'a Value>) {
        let smap = stages
            .iter()
            .map(|s| (s.get("uuid").and_then(|v| v.as_str()).unwrap(), s))
            .collect();
        let amap = actions.iter().map(|(id, a)| (id.as_str(), a)).collect();
        (smap, amap)
    }

    #[test]
    fn single_option_ok_is_classified_ok() {
        let (stages, actions) = convergent_graph();
        let (smap, amap) = index(&stages, &actions);
        let edges = classify_stage_edges(&stages[1], &smap, &amap, &HashSet::new()); // "a"
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].class, EdgeClass::Ok);
        assert_eq!(edges[0].target, "t");
    }

    #[test]
    fn multi_option_ok_is_classified_choice_option() {
        let (stages, actions) = convergent_graph();
        let (smap, amap) = index(&stages, &actions);
        let edges = classify_stage_edges(&stages[0], &smap, &amap, &HashSet::new()); // "root"
        assert_eq!(edges.len(), 2);
        assert!(edges.iter().all(|e| e.class == EdgeClass::ChoiceOption));
    }

    #[test]
    fn home_edge_is_classified_home() {
        let stages = vec![stage("x", None, Some("home-act")), stage("root", None, None)];
        let actions = vec![("home-act".to_string(), action(&["root"]))];
        let (smap, amap) = index(&stages, &actions);
        let edges = classify_stage_edges(&stages[0], &smap, &amap, &HashSet::new());
        assert_eq!(edges.len(), 1);
        assert_eq!(edges[0].class, EdgeClass::Home);
    }

    #[test]
    fn unknown_target_is_unresolved_and_global_node_overrides() {
        let stages = vec![stage("x", Some("act"), None)];
        let actions = vec![("act".to_string(), action(&["ghost"]))];
        let (smap, amap) = index(&stages, &actions);
        assert_eq!(
            classify_stage_edges(&stages[0], &smap, &amap, &HashSet::new())[0].class,
            EdgeClass::Unresolved,
        );
        let globals: HashSet<&str> = ["ghost"].into_iter().collect();
        assert_eq!(
            classify_stage_edges(&stages[0], &smap, &amap, &globals)[0].class,
            EdgeClass::GlobalNight,
        );
    }

    #[test]
    fn project_edge_depends_on_placed_state() {
        assert_eq!(project_edge(EdgeClass::Ok, false), Projection::Containment);
        assert_eq!(project_edge(EdgeClass::Ok, true), Projection::Reference);
        assert_eq!(
            project_edge(EdgeClass::ChoiceOption, true),
            Projection::Reference
        );
        assert_eq!(project_edge(EdgeClass::Home, false), Projection::OutOfTree);
        assert_eq!(
            project_edge(EdgeClass::GlobalNight, false),
            Projection::OutOfTree
        );
    }

    #[test]
    fn convergent_graph_yields_one_reference_edge() {
        let (stages, actions) = convergent_graph();
        let (smap, amap) = index(&stages, &actions);
        let stats = project_graph("root", &smap, &amap, &HashSet::new());
        // root place a, b, t → 3 containment ; b→t retombe sur t déjà placé → 1 reference.
        assert_eq!(stats.containment, 3);
        assert_eq!(stats.reference, 1);
        assert_eq!(stats.home, 0);
    }

    #[test]
    fn home_edges_never_place_a_node_in_the_tree() {
        // root --ok--> a ; a --home--> orphan. `orphan` ne doit jamais être placé.
        let stages = vec![
            stage("root", Some("act-root"), None),
            stage("a", None, Some("home-act")),
            stage("orphan", None, None),
        ];
        let actions = vec![
            ("act-root".to_string(), action(&["a"])),
            ("home-act".to_string(), action(&["orphan"])),
        ];
        let (smap, amap) = index(&stages, &actions);
        let stats = project_graph("root", &smap, &amap, &HashSet::new());
        assert_eq!(stats.containment, 1); // seulement "a"
        assert_eq!(stats.home, 1);
        assert_eq!(stats.reference, 0);
    }
}
