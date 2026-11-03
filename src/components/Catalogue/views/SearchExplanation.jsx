import { useCatalogueTranslation } from '../../../i18n/useCatalogueTranslation.js';

export function SearchExplanation({ item }) {
  const { line } = useCatalogueTranslation();
  return item.explanations?.map((explanation, index) => <span className="catalogue-search-explanation" key={index} data-exemplar-id={explanation.exemplarId ?? undefined}>{line(explanation)}</span>);
}
