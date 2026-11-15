import { useEffect, useRef, useState } from 'react';
import { activeOptionsSection } from './activeOptionsSection.js';

const SCROLL_INPUT_EVENTS = ['wheel', 'touchstart', 'pointerdown'];

// Scroll-spy des sections de préférences : suit la section visible dans le
// conteneur scrollable, et pilote le clic de nav (scroll doux + flash de la
// carte cible, maintenue active jusqu'au prochain geste de défilement).
export function useOptionsSectionNav({ sectionIds, screenRef, remountKey, initialSection }) {
  const [activeSectionId, setActiveSectionId] = useState(sectionIds[0]);
  const [highlightedSectionId, setHighlightedSectionId] = useState(null);
  const sectionRefs = useRef({});
  const navigationTargetRef = useRef(null);
  const highlightTimerRef = useRef(null);
  const highlightFrameRef = useRef(null);

  useEffect(() => {
    const root = screenRef.current;
    const sections = sectionIds
      .map((id) => sectionRefs.current[id])
      .filter(Boolean);
    if (!root || sections.length === 0) return undefined;

    let frame = null;
    const update = () => {
      frame = null;
      const origin = root.getBoundingClientRect().top + root.clientTop;
      const positions = sections.map(section => ({
        id: section.id,
        top: section.getBoundingClientRect().top - origin + root.scrollTop,
      }));
      const nextId = activeOptionsSection(positions, root.scrollTop, root.clientHeight,
        root.scrollHeight, navigationTargetRef.current);
      if (nextId) setActiveSectionId(nextId);
    };
    const onScroll = () => {
      if (frame === null) frame = window.requestAnimationFrame(update);
    };
    // No duration assumption for native smooth scrolling. A new wheel, touch,
    // scrollbar drag or scrolling key hands control back to the scroll-spy.
    const resumeTracking = () => { navigationTargetRef.current = null; };
    const onKeyDown = (event) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) resumeTracking();
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    for (const name of SCROLL_INPUT_EVENTS) root.addEventListener(name, resumeTracking, { passive: true });
    root.addEventListener('keydown', onKeyDown);
    update();
    return () => {
      root.removeEventListener('scroll', onScroll);
      for (const name of SCROLL_INPUT_EVENTS) root.removeEventListener(name, resumeTracking);
      root.removeEventListener('keydown', onKeyDown);
      if (frame !== null) window.cancelAnimationFrame(frame);
    };
  }, [remountKey, screenRef, sectionIds]);

  useEffect(() => {
    if (!sectionIds.includes(initialSection)) return undefined;
    const frame = requestAnimationFrame(() => {
      navigationTargetRef.current = initialSection;
      sectionRefs.current[initialSection]?.scrollIntoView({ block: 'start' });
      setActiveSectionId(initialSection);
    });
    return () => cancelAnimationFrame(frame);
  }, [initialSection, remountKey, sectionIds]);

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
    navigationTargetRef.current = sectionId;
    sectionRefs.current[sectionId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setActiveSectionId(sectionId);
    highlightSection(sectionId);
  }

  function registerSection(sectionId) {
    return (node) => { sectionRefs.current[sectionId] = node; };
  }

  return { activeSectionId, sectionClass, registerSection, scrollToSection };
}
