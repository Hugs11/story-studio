use super::core::StoryBuilder;

use super::super::*;
use super::transitions::transition;

impl<'a> StoryBuilder<'a> {
    pub(in crate::native_pack::builder) fn resolve_story_return_transition(
        &self,
        target_menu_id: Option<&str>,
        fallback_transition: Transition,
    ) -> Transition {
        self.resolved_story_return_transition(target_menu_id)
            .unwrap_or(fallback_transition)
    }

    /// La transition d'une cible typée **réellement résolue**, sans repli.
    /// `None` signifie « cette cible ne désigne encore aucun nœud construit » :
    /// l'appelant décide alors s'il replie ou s'il exige une cible réelle.
    fn resolved_story_return_transition(&self, target_menu_id: Option<&str>) -> Option<Transition> {
        match decode_navigation_target(target_menu_id)? {
            NavigationTarget::Root => self
                .root_action_id
                .as_ref()
                .map(|action_id| transition(action_id, 0)),
            NavigationTarget::CurrentMenu | NavigationTarget::NextStory => None,
            NavigationTarget::Menu(target_id) => self
                .menu_prealloc
                .get(target_id)
                .map(|prealloc| prealloc.replay_transition.clone()),
            NavigationTarget::Story(story_id) => self
                .story_prealloc
                .get(story_id)
                .and_then(|prealloc| prealloc.approach_transition.clone()),
            NavigationTarget::StoryPlay(story_id) => self
                .story_prealloc
                .get(story_id)
                .map(|prealloc| transition(&prealloc.play_action_id, 0)),
            NavigationTarget::StoryHomeStep(story_id) => self
                .story_prealloc
                .get(story_id)
                .and_then(|prealloc| prealloc.home_step_action_id.as_deref())
                .map(|action_id| transition(action_id, 0)),
        }
    }

    pub(in crate::native_pack::builder) fn resolve_story_home_transition(
        &self,
        target_menu_id: Option<&str>,
        fallback_transition: Transition,
    ) -> Transition {
        // "story_play:X" sur une cible Home signifie que le lecteur est arrivé via
        // le stage de lecture. Home doit revenir au stage titre/sélection (approach),
        // pas directement à la lecture.
        if let Some(t) = target_menu_id {
            if let Some(story_id) = t.strip_prefix("story_play:") {
                return self
                    .story_prealloc
                    .get(story_id)
                    .and_then(|p| p.approach_transition.clone())
                    .unwrap_or_else(|| {
                        self.resolve_story_return_transition(Some(t), fallback_transition.clone())
                    });
            }
        }
        self.resolve_story_return_transition(target_menu_id, fallback_transition)
    }

    pub(in crate::native_pack::builder) fn resolve_play_home_transition_for_story(
        &self,
        story: &CanonicalStory,
        target_menu_id: Option<&str>,
        fallback_transition: Transition,
    ) -> Transition {
        let imported_native_story = story
            .native_stage_id
            .as_deref()
            .is_some_and(|stage_id| !stage_id.trim().is_empty());
        if imported_native_story {
            self.resolve_story_return_transition(target_menu_id, fallback_transition)
        } else {
            self.resolve_story_home_transition(target_menu_id, fallback_transition)
        }
    }

    /// Stage natif d'une cible déjà PRÉALLOUÉ (donc disponible avant sa construction).
    /// Permet de résoudre une convergence « en avant » (vers un nœud bâti plus tard),
    /// là où `transition_target_stage_id` échouerait faute d'action node déjà présent.
    /// Limité aux cibles dont le stage est préalloué : `story_play:` / `story_home_step:`.
    pub(in crate::native_pack::builder) fn preallocated_target_stage(
        &self,
        target: &str,
    ) -> Option<String> {
        match decode_navigation_target(Some(target))? {
            NavigationTarget::StoryPlay(story_id) => self
                .story_prealloc
                .get(story_id)
                .map(|prealloc| prealloc.play_stage_id.clone()),
            NavigationTarget::StoryHomeStep(story_id) => self
                .story_prealloc
                .get(story_id)
                .and_then(|prealloc| prealloc.home_step_stage_id.clone()),
            _ => None,
        }
    }

    /// Résolveur unifié cible typée → stage natif, partagé par les nœuds `ref` et la
    /// convergence de fin (`okChoiceTargets`) — c'est le « sucre au-dessus de `ref` » de
    /// fin de séquence. D'abord le stage préalloué (résout les cibles « en avant »), sinon la
    /// résolution via transition (cibles déjà construites). Le `fallback` paramètre la
    /// sémantique : `Some(transition)` pour une convergence indulgente, `None` pour
    /// exiger une cible réelle (refs).
    ///
    /// `None` remplace l'ancienne sentinelle `option_index: -1` : depuis que la
    /// sélection est typée, `-1` désigne `Random` et ne peut plus servir de
    /// marqueur interne « cible non résolue ».
    pub(in crate::native_pack::builder) fn resolve_target_stage(
        &self,
        target: &str,
        fallback: Option<Transition>,
    ) -> Option<String> {
        if let Some(stage_id) = self.preallocated_target_stage(target) {
            return Some(stage_id);
        }
        let transition = self
            .resolved_story_return_transition(Some(target))
            .or(fallback)?;
        self.transition_target_stage_id(&transition)
    }

    /// Le stage désigné par une transition **déjà construite**. Une sélection
    /// `Random` ne désigne pas un stage unique : elle rend `None` plutôt qu'une
    /// destination arbitraire.
    pub(in crate::native_pack::builder) fn transition_target_stage_id(
        &self,
        transition: &Transition,
    ) -> Option<String> {
        let option_index = transition.selection.fixed_index()?;
        self.action_nodes
            .iter()
            .find(|action| action.id == transition.action_node)
            .and_then(|action| action.option_target(option_index))
            .map(str::to_string)
    }

    pub(in crate::native_pack::builder) fn resolve_title_home_transition(
        &self,
        story: &CanonicalStory,
        siblings: &[CanonicalEntry],
        story_index: usize,
        fallback_transition: Transition,
    ) -> Option<Transition> {
        if story.title_return_on_home_none {
            return None;
        }

        if let Some(target) = story.title_return_on_home.as_deref() {
            let resolved = resolve_next_story_target(Some(target), siblings, story_index);
            return Some(
                self.resolve_story_return_transition(resolved.as_deref(), fallback_transition),
            );
        }

        Some(fallback_transition)
    }
}
