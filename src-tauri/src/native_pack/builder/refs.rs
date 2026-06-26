//! Résolution des nœuds de référence (`CanonicalEntry::Ref`) à l'export.
//!
//! Un `ref` ne construit AUCUN sous-arbre : c'est une arête vers un nœud existant.
//! Pendant le parcours, l'option de menu correspondante reçoit un stage *placeholder*
//! et la cible est enregistrée ici. Une fois TOUT l'arbre construit (donc toutes les
//! cibles disponibles, y compris en avant), `resolve_pending_ref_options` réécrit chaque
//! option vers le vrai stage natif de la cible — en réutilisant exactement le résolveur
//! de `returnAfterPlay` (`resolve_story_return_transition` + tables préallouées).
use super::core::StoryBuilder;
use super::super::Transition;

/// Une option de menu (ou d'entrée racine) qui doit pointer vers un nœud existant.
pub(in crate::native_pack::builder) struct PendingRefOption {
    /// Action node hébergeant l'option à réécrire.
    pub(in crate::native_pack::builder) action_id: String,
    /// Index de l'option dans cet action node (= index de l'enfant dans le parcours).
    pub(in crate::native_pack::builder) option_index: usize,
    /// Cible typée (`menu:`/`story:`/`story_play:`/`story_home_step:`).
    pub(in crate::native_pack::builder) target: String,
}

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack::builder) fn record_ref_option(
        &mut self,
        action_id: &str,
        option_index: usize,
        target: &str,
    ) {
        self.pending_ref_options.push(PendingRefOption {
            action_id: action_id.to_string(),
            option_index,
            target: target.to_string(),
        });
    }

    /// Réécrit chaque option de référence vers le stage natif de sa cible.
    /// Échoue (fidélité = critère bloquant) si une cible reste irrésolue : mieux vaut
    /// une erreur explicite qu'un document avec une arête fantôme.
    pub(in crate::native_pack::builder) fn resolve_pending_ref_options(
        &mut self,
    ) -> Result<(), String> {
        let pending = std::mem::take(&mut self.pending_ref_options);
        // Deux temps pour éviter le conflit d'emprunt : résoudre (lecture) puis appliquer (écriture).
        let mut patches: Vec<(String, usize, String)> = Vec::with_capacity(pending.len());
        for option in &pending {
            let unresolved = Transition {
                action_node: String::new(),
                option_index: -1,
            };
            let transition =
                self.resolve_story_return_transition(Some(&option.target), unresolved);
            let stage_id = self.transition_target_stage_id(&transition).ok_or_else(|| {
                format!(
                    "Référence non résolue à l'export : cible « {} » introuvable.",
                    option.target
                )
            })?;
            patches.push((option.action_id.clone(), option.option_index, stage_id));
        }
        for (action_id, option_index, stage_id) in patches {
            let action = self
                .action_nodes
                .iter_mut()
                .find(|action| action.id == action_id)
                .ok_or_else(|| {
                    "Action node introuvable pour la résolution d'une référence.".to_string()
                })?;
            let slot = action.options.get_mut(option_index).ok_or_else(|| {
                "Index d'option hors limites pour la résolution d'une référence.".to_string()
            })?;
            *slot = stage_id;
        }
        Ok(())
    }
}
