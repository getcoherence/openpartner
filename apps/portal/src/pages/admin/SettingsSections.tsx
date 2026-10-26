import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useIsMobile } from '../../lib/useMediaQuery.js';
import { theme } from '../../theme.js';

export interface SettingsSection {
  /** The URL hash (`#network`) that links straight to the section. */
  id: string;
  /** Sidebar heading. Consecutive sections with the same group share one. */
  group: string;
  label: string;
  content: ReactNode;
}

const domId = (id: string) => `settings-${id}`;

/** How far below the top of the viewport a section lands when jumped to.
 *  Mobile clears the 56px top bar plus the sticky section row. */
const DESKTOP_OFFSET = 24;
const MOBILE_OFFSET = 112;

/**
 * Settings sections with a section menu: a sticky sidebar on desktop, a
 * sticky row of chips on mobile. The menu follows the scroll position, and
 * `#<id>` in the URL (e.g. /admin/settings#network) opens at that section.
 */
export function SettingsSections({ sections }: { sections: SettingsSection[] }) {
  const isMobile = useIsMobile();
  const location = useLocation();
  const navigate = useNavigate();
  const [active, setActive] = useState(sections[0]?.id ?? '');
  const contentRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLElement>(null);
  // Set while a jump scrolls, so the menu doesn't flick through every
  // section in between.
  const jumping = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The hash whose jump is finished, so a re-render doesn't jump again.
  const doneHash = useRef<string | null>(null);
  const sectionsRef = useRef(sections);
  sectionsRef.current = sections;
  const ids = sections.map((s) => s.id).join(',');
  const offset = isMobile ? MOBILE_OFFSET : DESKTOP_OFFSET;

  const jump = (id: string, behavior: ScrollBehavior) => {
    const el = document.getElementById(domId(id));
    if (!el) return;
    setActive(id);
    if (jumping.current) clearTimeout(jumping.current);
    jumping.current = setTimeout(() => { jumping.current = null; }, behavior === 'smooth' ? 800 : 50);
    el.scrollIntoView({ behavior, block: 'start' });
  };

  // Follow the scroll: the active section is the last one whose top has
  // passed the offset, or the last section once the page can't scroll on.
  useEffect(() => {
    const update = () => {
      if (jumping.current) return;
      const list = sectionsRef.current;
      let current = list[0]?.id;
      for (const s of list) {
        const el = document.getElementById(domId(s.id));
        if (el && el.getBoundingClientRect().top - offset - 8 <= 0) current = s.id;
      }
      const content = contentRef.current;
      if (content && window.scrollY > 0 && content.getBoundingClientRect().bottom <= window.innerHeight + 2) {
        current = list[list.length - 1]?.id;
      }
      if (current) setActive(current);
    };
    // Any user scroll ends a jump early, so the menu catches up at once.
    const endJump = () => {
      if (jumping.current) clearTimeout(jumping.current);
      jumping.current = null;
    };
    update();
    window.addEventListener('scroll', update, { capture: true, passive: true });
    window.addEventListener('resize', update);
    window.addEventListener('wheel', endJump, { passive: true });
    window.addEventListener('touchstart', endJump, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(update);
    if (ro && contentRef.current) ro.observe(contentRef.current);
    return () => {
      window.removeEventListener('scroll', update, { capture: true });
      window.removeEventListener('resize', update);
      window.removeEventListener('wheel', endJump);
      window.removeEventListener('touchstart', endJump);
      ro?.disconnect();
    };
  }, [ids, offset]);

  // Open at #<id>. The sections above it load on their own and grow, so
  // keep the target in place until the user scrolls or clicks, or 10s
  // pass. Only that marks the hash done: a cleanup (StrictMode's re-run,
  // a section list that changed) just stops this pass.
  useEffect(() => {
    const hash = location.hash;
    const id = hash.replace(/^#/, '');
    if (!id || doneHash.current === hash) return;
    if (!sectionsRef.current.some((s) => s.id === id)) return;
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => jump(id, 'auto'));
    const inputs = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;
    const stop = () => {
      ro?.disconnect();
      clearTimeout(timer);
      for (const type of inputs) window.removeEventListener(type, finish);
    };
    const finish = () => {
      doneHash.current = hash;
      stop();
    };
    const timer = setTimeout(finish, 10_000);
    for (const type of inputs) window.addEventListener(type, finish, { passive: true });
    if (ro && contentRef.current) ro.observe(contentRef.current);
    jump(id, 'auto');
    return stop;
  }, [location.hash, ids]);

  // Keep the active chip in view in the mobile row. Instantly: Chromium
  // runs one smooth scroll at a time, so a smooth one here would cancel a
  // jump's smooth page scroll.
  useEffect(() => {
    const row = rowRef.current;
    const chip = row?.querySelector<HTMLElement>(`[data-section="${active}"]`);
    if (!row || !chip) return;
    const left = chip.offsetLeft - row.offsetLeft;
    if (left < row.scrollLeft || left + chip.offsetWidth > row.scrollLeft + row.clientWidth) {
      row.scrollLeft = left - 16;
    }
  }, [active, isMobile]);

  const onSelect = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    e.preventDefault();
    doneHash.current = `#${id}`;
    navigate({ search: location.search, hash: id }, { replace: true });
    jump(id, 'smooth');
  };

  const content = (
    <div ref={contentRef} style={{ display: 'flex', flexDirection: 'column', gap: 18, minWidth: 0 }}>
      {sections.map((s) => (
        <section key={s.id} id={domId(s.id)} aria-label={s.label} style={{ scrollMarginTop: offset }}>
          {s.content}
        </section>
      ))}
    </div>
  );

  if (isMobile) {
    return (
      <div>
        <nav
          ref={rowRef}
          aria-label="Settings sections"
          style={{
            position: 'sticky',
            top: 56,
            zIndex: 20,
            display: 'flex',
            gap: 6,
            overflowX: 'auto',
            scrollbarWidth: 'none',
            margin: '-4px -16px 16px',
            padding: '10px 16px',
            background: theme.bg,
            borderBottom: `1px solid ${theme.borderSubtle}`,
          }}
        >
          {sections.map((s) => {
            const on = s.id === active;
            return (
              <a
                key={s.id}
                href={`#${s.id}`}
                data-section={s.id}
                aria-current={on ? 'location' : undefined}
                onClick={(e) => onSelect(e, s.id)}
                style={{
                  flex: '0 0 auto',
                  padding: '6px 12px',
                  borderRadius: 999,
                  fontSize: 13,
                  whiteSpace: 'nowrap',
                  border: `1px solid ${on ? theme.accentA55 : theme.border}`,
                  background: on ? theme.surface : 'transparent',
                  color: on ? theme.text : theme.textMuted,
                  fontWeight: on ? 500 : 400,
                }}
              >
                {s.label}
              </a>
            );
          })}
        </nav>
        {content}
      </div>
    );
  }

  const groups: Array<{ name: string; sections: SettingsSection[] }> = [];
  for (const s of sections) {
    const last = groups[groups.length - 1];
    if (last && last.name === s.group) last.sections.push(s);
    else groups.push({ name: s.group, sections: [s] });
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '184px minmax(0, 1fr)', gap: 32, alignItems: 'start' }}>
      <nav
        aria-label="Settings sections"
        style={{
          position: 'sticky',
          top: DESKTOP_OFFSET,
          maxHeight: `calc(100vh - ${DESKTOP_OFFSET * 2}px)`,
          overflowY: 'auto',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {groups.map((g) => (
          <div key={g.name}>
            <div style={groupHeaderStyle}>{g.name}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
              {g.sections.map((s) => (
                <SectionLink key={s.id} section={s} active={s.id === active} onSelect={onSelect} />
              ))}
            </div>
          </div>
        ))}
      </nav>
      {content}
    </div>
  );
}

/** Same look as the main sidebar's section headings. */
const groupHeaderStyle: CSSProperties = {
  fontSize: 11,
  color: theme.textDim,
  textTransform: 'uppercase',
  letterSpacing: '0.08em',
  fontWeight: 600,
  padding: '0 10px 6px',
};

function SectionLink({
  section,
  active,
  onSelect,
}: {
  section: SettingsSection;
  active: boolean;
  onSelect: (e: MouseEvent<HTMLAnchorElement>, id: string) => void;
}) {
  return (
    <a
      href={`#${section.id}`}
      aria-current={active ? 'location' : undefined}
      onClick={(e) => onSelect(e, section.id)}
      style={{
        display: 'block',
        padding: '6px 10px',
        borderRadius: 6,
        background: active ? theme.surface : 'transparent',
        color: active ? theme.text : theme.textMuted,
        fontSize: 13.5,
        fontWeight: active ? 500 : 400,
        transition: 'all 120ms',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.color = theme.text;
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.color = theme.textMuted;
      }}
    >
      {section.label}
    </a>
  );
}
