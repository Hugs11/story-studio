import { useEffect, useRef, useState } from 'react';

// Scroll-spy des sections de préférences : suit la section visible dans le
// conteneur scrollable, et pilote le clic de nav (scroll doux + flash de la
// carte cible, avec suppression temporaire de l'observer pendant le scroll).
export function useOptionsSectionNav({ sectionIds, screenRef, remountKey }) {
  const [activeSectionId, setActiveSectionId] = useState(sectionIds[0]);
  const [highlightedSectionId, setHighlightedSectionId] = useState(null);
  const sectionRefs = useRef({});
  const observerSuppressedUntilRef = useRef(0);
  const highlightTimerRef = useRef(null);
  const highlightFrameRef = useRef(null);

  useEffect(() => {
    const root = screenRef.current;
    const sections = sectionIds
      .map((id) => sectionRefs.current[id])
      .filter(Boolean);
    if (!root || sections.length === 0 || typeof IntersectionObserver === 'undefined') return undefined;

    const observer = new IntersectionObserver((entries) => {
      if (Date.now() < observerSuppressedUntilRef.current) return;
      const visibleEntries = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => Math.abs(a.boundingClientRect.top) - Math.abs(b.boundingClientRect.top));
      const nextId = visibleEntries[0]?.target?.id;
      if (nextId) setActiveSectionId(nextId);
    }, {
      root,
      rootMargin: '-12% 0px -70% 0px',
      threshold: [0, 0.1, 0.35, 0.6],
    });

    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, [remountKey, screenRef, sectionIds]);

  useEffect(() => () => {
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    if (highlightFrameRef.current) window.cancelAnimationFrame(highlightFrameRef.current);
  }, []);

  function sectionClass(sectionId) {
    return `opts-card${highlightedSectionId === sectionId ? ' is-highlighted' : ''}`;
  }

  function highlightSection(sectionId) {
    if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    if (highlightFrameRef.current) window.cancelAnimationFrame(highlightFrameRef.current);
    setHighlightedSectionId(null);
    highlightFrameRef.current = window.requestAnimationFrame(() => {
      setHighlightedSectionId(sectionId);
      highlightTimerRef.current = window.setTimeout(() => setHighlightedSectionId(null), 900);
    });
  }

  function scrollToSection(sectionId) {
    observerSuppressedUntilRef.current = Date.now() + 650;
    sectionRefs.current[sectionId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSectionId(sectionId);
    highlightSection(sectionId);
  }

  function registerSection(sectionId) {
    return (node) => { sectionRefs.current[sectionId] = node; };
  }

  return { activeSectionId, sectionClass, registerSection, scrollToSection };
}
