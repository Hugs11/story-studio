import { getIntlLocale } from '../../../i18n/language.js';
import { translateCatalogue as t } from '../../../i18n/cataloguePresentation.js';

/** Choice dialog model: the saved project receives initial focus (D70). */
export function editWarningDialog(warning) {
  return {
    get title() { return t('catalogue:open.warning.title'); },
    get message() { return t('catalogue:open.warning.message', { project: warning.project.path, date: warning.message.params.date ? new Date(warning.message.params.date).toLocaleString(getIntlLocale()) : '—' }); },
    cancelValue: null,
    actions: [
      { value: 'project', get label() { return t('catalogue:open.warning.project'); }, kind: 'primary', autoFocus: true },
      { value: 'pack', get label() { return t('catalogue:open.warning.pack'); }, kind: 'secondary' },
      { value: null, get label() { return t('common:dialog.cancel.label'); }, kind: 'ghost' },
    ],
  };
}
