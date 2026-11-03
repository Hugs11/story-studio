import { useTranslation } from 'react-i18next';
import { useState, useRef, useEffect } from 'react';
import { Button } from '../components/common/Button';
import { KeyboardShortcutsModal } from '../components/StorySettingsModal/KeyboardShortcutsModal';
import { useEscapeKey } from '../hooks/useEscapeKey';
import { OPTION_SECTION_IDS, OptionsSectionNav } from './OptionsTab/OptionsSectionNav';
import { useOptionsSectionNav } from './OptionsTab/useOptionsSectionNav';
import { SaveSection } from './OptionsTab/SaveSection';
import { CatalogueSection } from './OptionsTab/CatalogueSection';
import { InterfaceSection } from './OptionsTab/InterfaceSection';
import { ProjectsMediaSection } from './OptionsTab/ProjectsMediaSection';
import { VoiceSection } from './OptionsTab/VoiceSection';
import { AiImagesSection } from './OptionsTab/AiImagesSection';
import { AdvancedSection } from './OptionsTab/AdvancedSection';
import { YoutubeSection } from './OptionsTab/YoutubeSection';
import { DiagnosticSection } from './OptionsTab/DiagnosticSection';
import './OptionsTab.css';

export function OptionsTab({
  copyFilesEnabled,
  onCopyFilesChange,
  workspaceDir,
  configuredWorkspaceDir = '',
  onPickWorkspaceDir,
  useWorkspaceForNewProjects = false,
  onUseWorkspaceForNewProjectsChange = null,
  onConsolidateProject,
  autoSaveEnabled,
  onAutoSaveChange,
  autoSaveBackupLimit,
  onAutoSaveBackupLimitChange,
  themePreference,
  onThemePreferenceChange,
  xttsSettings,
  onUpdateXttsSettings,
  sdSettings,
  onUpdateSdSettings,
  keyboardShortcuts,
  onUpdateKeyboardShortcuts,
  onBackToHome,
  verboseLogging = false,
  onVerboseLoggingChange = null,
  onCopyLogPath = null,
  onResolveLogPath = null,
  project = null,
  initialSection = null,
  initialFocus = null,
  asModal = false,
  onClose = null,
}) {
  const { t } = useTranslation('settings');
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // En modale : Escape ferme les Préférences. La modale des raccourcis, montée
  // par-dessus, s'enregistre après et prend donc le dessus dans la pile Escape.
  useEscapeKey(asModal, onClose);
  const screenRef = useRef(null);
  const {
    activeSectionId,
    sectionClass,
    registerSection,
    scrollToSection,
  } = useOptionsSectionNav({ sectionIds: OPTION_SECTION_IDS, screenRef, remountKey: asModal, initialSection });
  useEffect(() => {
    if (!asModal) return undefined;
    const previous = document.activeElement;
    const target = initialFocus ? document.getElementById(initialFocus) : null;
    if (target && screenRef.current?.contains(target)) {
      target.focus({ preventScroll: true });
    } else {
      screenRef.current?.closest('[role="dialog"]')?.querySelector('button')?.focus();
    }
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [asModal, initialFocus]);
  const displayedWorkspaceDir = configuredWorkspaceDir || workspaceDir || '';

  const content = (
    <div className={`opts-screen${asModal ? ' is-modal' : ''}`} ref={screenRef}>
      {onBackToHome && (
        <div className="opts-back-row">
          <Button onClick={onBackToHome}>{t('settings:preferences.home.action')}</Button>
        </div>
      )}
      <div className="opts-layout">
        <OptionsSectionNav activeSectionId={activeSectionId} onNavigate={scrollToSection} />
        <div className="opts-content">
          <SaveSection
            className={sectionClass('save')}
            sectionRef={registerSection('save')}
            autoSaveEnabled={autoSaveEnabled}
            onAutoSaveChange={onAutoSaveChange}
            autoSaveBackupLimit={autoSaveBackupLimit}
            onAutoSaveBackupLimitChange={onAutoSaveBackupLimitChange}
            shortcuts={keyboardShortcuts}
          />
          <InterfaceSection
            className={sectionClass('interface')}
            sectionRef={registerSection('interface')}
            themePreference={themePreference}
            onThemePreferenceChange={onThemePreferenceChange}
            onOpenShortcuts={() => setShortcutsOpen(true)}
          />
          <CatalogueSection
            className={sectionClass('catalogue')}
            sectionRef={registerSection('catalogue')}
            workspaceDir={useWorkspaceForNewProjects ? displayedWorkspaceDir : null}
          />
          <ProjectsMediaSection
            className={sectionClass('projects-media')}
            sectionRef={registerSection('projects-media')}
            useWorkspaceForNewProjects={useWorkspaceForNewProjects}
            onUseWorkspaceForNewProjectsChange={onUseWorkspaceForNewProjectsChange}
            displayedWorkspaceDir={displayedWorkspaceDir}
            onPickWorkspaceDir={onPickWorkspaceDir}
            copyFilesEnabled={copyFilesEnabled}
            onCopyFilesChange={onCopyFilesChange}
            onConsolidateProject={onConsolidateProject}
            project={project}
          />
          <VoiceSection
            className={sectionClass('xtts')}
            sectionRef={registerSection('xtts')}
            xttsSettings={xttsSettings}
            onUpdateXttsSettings={onUpdateXttsSettings}
          />
          <AiImagesSection
            className={sectionClass('comfyui')}
            sectionRef={registerSection('comfyui')}
            sdSettings={sdSettings}
            onUpdateSdSettings={onUpdateSdSettings}
          />
          <AdvancedSection
            className={sectionClass('advanced')}
            sectionRef={registerSection('advanced')}
          />
          <YoutubeSection
            className={sectionClass('youtube')}
            sectionRef={registerSection('youtube')}
          />
          <DiagnosticSection
            className={sectionClass('diagnostic')}
            sectionRef={registerSection('diagnostic')}
            verboseLogging={verboseLogging}
            onVerboseLoggingChange={onVerboseLoggingChange}
            onCopyLogPath={onCopyLogPath}
            onResolveLogPath={onResolveLogPath}
          />
        </div>
      </div>
    </div>
  );

  if (asModal) {
    return (
      <>
        <div className="modal-overlay" onClick={onClose}>
          <div role="dialog" aria-modal="true" aria-label={t('settings:preferences.dialog.title')} className="modal-box opts-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <span>{t('settings:preferences.dialog.title')}</span>
              <Button variant="icon" className="modal-close" onClick={onClose}>×</Button>
            </div>
            {content}
          </div>
        </div>
        {shortcutsOpen && (
          <KeyboardShortcutsModal
            shortcuts={keyboardShortcuts}
            onChange={onUpdateKeyboardShortcuts}
            onClose={() => setShortcutsOpen(false)}
          />
        )}
      </>
    );
  }

  return (
    <div className="screen visible">
      {content}
      {shortcutsOpen && (
        <KeyboardShortcutsModal
          shortcuts={keyboardShortcuts}
          onChange={onUpdateKeyboardShortcuts}
          onClose={() => setShortcutsOpen(false)}
        />
      )}
    </div>
  );
}
