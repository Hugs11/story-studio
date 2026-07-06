import { createContext, useContext } from 'react';

// Actions projet partagées par les surfaces d'édition (arbre, réglages, diagramme) :
// édition d'entrées (update/delete/add), imports, message de fin / mode nuit,
// et capacités associées (canRecord…). Fournies par App.jsx ; évite de re-câbler
// ~35 props identiques sur chaque surface. Les données (project, projectIndex…)
// et les props spécifiques à une surface restent passées en props.
export const ProjectActionsContext = createContext(null);

export const useProjectActions = () => useContext(ProjectActionsContext);
