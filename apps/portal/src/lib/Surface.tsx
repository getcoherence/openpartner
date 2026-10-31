/**
 * One surface made of sections. A page stacks its parts as separate cards;
 * a side panel (Discover creators' selected creator) is a single surface,
 * so inside <FlatCards> the same parts render as flat sections divided by
 * a rule. Views shared by both use SectionCard and SectionGap.
 */

import { createContext, useContext, type CSSProperties, type ReactNode } from 'react';
import { theme } from '../theme.js';
import { Card } from '../ui.js';

const Flat = createContext(false);

export function FlatCards({ children }: { children: ReactNode }) {
  return <Flat.Provider value>{children}</Flat.Provider>;
}

export const useFlatCards = () => useContext(Flat);

/** A Card, or inside FlatCards a section of the surface, ruled off above.
 *  Both pad 20px, so a full-bleed banner's -20px margins fit either. */
export function SectionCard({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  const flat = useFlatCards();
  if (!flat) return <Card style={style}>{children}</Card>;
  return <section style={{ ...style, padding: 20, borderTop: `1px solid ${theme.borderSubtle}` }}>{children}</section>;
}

/** The space between two cards; none between flat sections. */
export function SectionGap() {
  return useFlatCards() ? null : <div style={{ height: 14 }} />;
}
