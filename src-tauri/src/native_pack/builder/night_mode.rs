use super::super::{
    resolve_next_story_target, ActionNode, CanonicalEntry, StageNode, StoryBuilder, Transition,
};
use super::transitions::{action_node_name, night_story_controls, transition, zero_position};

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack) fn build_night_bridge(&mut self) -> Result<Transition, String> {
        let root_action_id = self
            .root_action_id
            .clone()
            .ok_or_else(|| "Action racine introuvable pour le bridge night.".to_string())?;
        let fallback_return = transition(&root_action_id, 0);
        let (return_transition, home_transition) =
            self.compute_night_bridge_targets(&[], 0, fallback_return);
        self.build_night_bridge_to(return_transition, home_transition)
    }

    /// Calcule les transitions de retour/accueil pour le night bridge d'une histoire donnée.
    ///
    /// Gère deux formes :
    /// - destination globale (`root`, `menu:<id>`, `story:<id>`, ...) : la transition résolue
    ///   est la même pour toutes les histoires, ce qui permet à `night_bridge_cache` de
    ///   partager un night stage unique.
    /// - destination dépendante de l'histoire courante (`next_story`) : `resolve_next_story_target`
    ///   produit une transition différente par histoire source, donc un night stage par histoire.
    pub(in crate::native_pack) fn compute_night_bridge_targets(
        &self,
        siblings: &[CanonicalEntry],
        story_index: usize,
        fallback_return: Transition,
    ) -> (Transition, Option<Transition>) {
        let raw_return = self.report.project.night_mode_return.as_deref();
        let night_return = if raw_return.is_some() {
            let resolved = resolve_next_story_target(raw_return, siblings, story_index);
            self.resolve_story_return_transition(resolved.as_deref(), fallback_return.clone())
        } else {
            fallback_return.clone()
        };

        let raw_home = self.report.project.night_mode_home_return.as_deref();
        let night_home = raw_home.map(|target| {
            let resolved = resolve_next_story_target(Some(target), siblings, story_index);
            self.resolve_story_home_transition(resolved.as_deref(), night_return.clone())
        });

        (night_return, night_home)
    }

    pub(in crate::native_pack) fn build_night_bridge_to(
        &mut self,
        return_transition: Transition,
        home_transition: Option<Transition>,
    ) -> Result<Transition, String> {
        let cache_key = format!(
            "{}#{}#{}",
            return_transition.action_node,
            return_transition.option_index,
            home_transition
                .as_ref()
                .map(|transition| format!("{}#{}", transition.action_node, transition.option_index))
                .unwrap_or_default()
        );
        if let Some(existing) = self.night_bridge_cache.get(&cache_key).cloned() {
            return Ok(existing);
        }

        let night_stage_id = self.next_id();
        let night_entry_action_id = self.next_id();

        self.action_nodes.push(ActionNode {
            id: night_entry_action_id.clone(),
            name: action_node_name(),
            options: vec![night_stage_id.clone()],
            position: zero_position(),
        });

        self.stage_nodes.push(StageNode {
            uuid: night_stage_id,
            name: "nightStage".to_string(),
            stage_type: "stage".to_string(),
            square_one: false,
            audio: Some(self.asset_name("nightModeAudio")?),
            image: None,
            control_settings: night_story_controls(
                self.report.project.options.end_message_autoplay,
            ),
            home_transition,
            ok_transition: Some(return_transition),
            position: zero_position(),
        });

        let bridge = transition(&night_entry_action_id, 0);
        self.night_bridge_cache.insert(cache_key, bridge.clone());
        Ok(bridge)
    }
}
