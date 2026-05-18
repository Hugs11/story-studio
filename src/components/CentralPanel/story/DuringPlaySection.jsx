import { useState } from 'react';
import { Toggle } from '../../common/Toggle';
import { Tooltip } from '../../common/Tooltip';
import {
  encodeMenuNavigationTarget,
  encodeStoryHomeStepNavigationTarget,
  encodeStoryNavigationTarget,
} from '../../../store/navigationTargets';
import { NAV_TARGET_NEXT_STORY } from './storyUtils';

const TITLE_CONTROL_DEFAULTS = {
  autoplay: false,
  ok: true,
  home: true,
  pause: false,
  wheel: true,
};

const PLAY_CONTROLS = [
  { key: 'pause',    label: 'Pause',               tip: "Permet de mettre l'histoire en pause pendant la lecture",                              def: false },
  { key: 'autoplay', label: 'Lecture automatique',  tip: "À la fin de l'audio, la boîte suit automatiquement la transition de fin. Désactive-le si l'enfant doit appuyer sur OK.", def: false },
  { key: 'wheel',    label: 'Molette',              tip: 'Permet de naviguer avec la molette pendant la lecture',                               def: false },
];

const TITLE_CONTROLS = [
  { key: 'autoplay', label: 'Lecture automatique', tip: "L'histoire se lance toute seule sans que l'enfant appuie sur OK",       def: false },
  { key: 'ok',       label: 'Bouton OK',            tip: "L'enfant peut appuyer sur OK pour lancer l'histoire",                   def: true },
  { key: 'home',     label: 'Bouton Accueil',        tip: 'L\'enfant peut revenir au menu parent avec le bouton Accueil',          def: true },
  { key: 'pause',    label: 'Bouton pause',          tip: "Permet de mettre en pause l'audio du titre pendant la sélection",      def: false },
  { key: 'wheel',    label: 'Molette',              tip: 'L\'enfant peut naviguer entre les histoires avec la molette',           def: true },
];

export function DuringPlaySection({ node, allMenus = [], allStories = [], parentMenu = null, effectiveReturnTargetName, onUpdate }) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const controls = node.controlSettings ?? {};
  const titleControls = node.titleControlSettings ?? {};

  return (
    <div className="card">
      <div className="card-title">Pendant la lecture</div>

      <div className="sequence-controls">
        {PLAY_CONTROLS.map(({ key, label, tip, def }) => (
          <label key={key} className="sequence-control">
            <Tooltip text={tip} placement="above" style={{ flex: 1 }}>
              <span>{label}</span>
            </Tooltip>
            <Toggle
              on={controls[key] ?? def}
              onChange={(v) => onUpdate({ controlSettings: { ...controls, [key]: v } })}
            />
          </label>
        ))}
        <label className="sequence-control">
          {node.returnOnHomeNone ? (
            <Tooltip text="Le bouton Accueil est désactivé pendant cette lecture : il ne déclenche aucune transition." placement="above" style={{ flex: 1 }}>
              <span>Accueil</span>
            </Tooltip>
          ) : (
            <>
              <Tooltip text={`Destination quand l'enfant appuie sur Accueil pendant la lecture. Par défaut : ${effectiveReturnTargetName || 'la fin configurée de l’histoire'}.`} placement="above">
                <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', whiteSpace: 'nowrap' }}>Accueil</span>
              </Tooltip>
              <select
              className="field-input"
              style={{ flex: 1, minWidth: 0, fontSize: 11, padding: '2px 4px' }}
              value={node.returnOnHome ?? ''}
              onChange={(e) => onUpdate({ returnOnHome: e.target.value || null, returnOnHomeNone: false })}
            >
              <option value="">Identique fin histoire</option>
              <option value={NAV_TARGET_NEXT_STORY}>Histoire suivante</option>
              {allMenus.length > 0 && (
                <optgroup label="Dossiers">
                  {allMenus.map((menu) => (
                    <option key={`home-${menu.id}`} value={encodeMenuNavigationTarget(menu.id)}>
                      {menu.name || '(sans nom)'}
                    </option>
                  ))}
                </optgroup>
              )}
              {allStories.length > 0 && (
                <>
                  <optgroup label="Histoires">
                    {allStories.filter((s) => s.id !== node.id).map((story) => (
                      <option key={`home-s-${story.id}`} value={encodeStoryNavigationTarget(story.id)}>
                        {story.name || '(sans nom)'}
                      </option>
                    ))}
                  </optgroup>
                  {allStories.some((s) => s.id !== node.id && s.hasAfterPlaybackHomeStep) && (
                    <optgroup label="Retours de fin importés">
                      {allStories
                        .filter((s) => s.id !== node.id && s.hasAfterPlaybackHomeStep)
                        .map((story) => (
                          <option key={`home-step-${story.id}`} value={encodeStoryHomeStepNavigationTarget(story.id)}>
                            Retour de fin — {story.name || '(sans nom)'}
                          </option>
                        ))}
                    </optgroup>
                  )}
                </>
              )}
            </select>
            </>
          )}
          <Toggle
            on={!node.returnOnHomeNone}
            onChange={(v) => onUpdate({ returnOnHome: null, returnOnHomeNone: !v })}
          />
        </label>
      </div>

      <div className="advanced-toggle-row">
        <div className="advanced-toggle-copy">
          <div className="field-label">Écran de sélection</div>
          <div className="advanced-toggle-desc">
            Boutons actifs pendant l'audio de sélection
          </div>
        </div>
        <button
          type="button"
          className={`btn advanced-toggle-btn ${showAdvanced ? 'is-active' : ''}`}
          aria-expanded={showAdvanced}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          Réglages avancés
        </button>
      </div>

      {showAdvanced && (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginBottom: 8 }}>
            Boutons actifs pendant l'audio de l'écran de sélection
          </div>
          <div className="sequence-controls">
            {TITLE_CONTROLS.map(({ key, label, tip, def }) => (
              <label key={key} className="sequence-control">
                <Tooltip text={tip} placement="above">
                  <span style={{ flex: 1 }}>{label}</span>
                </Tooltip>
                <Toggle
                  on={titleControls[key] ?? TITLE_CONTROL_DEFAULTS[key] ?? def}
                  onChange={(v) => onUpdate({
                    titleControlSettings: { ...TITLE_CONTROL_DEFAULTS, ...titleControls, [key]: v },
                  })}
                />
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
