import { useEffect, useRef, useState } from 'react';

export interface LightboxItem {
  large: string;
  alt: string;
  title: string;
  caption: string;
  tags: string[];
}

interface GalleryLightboxProps {
  items: LightboxItem[];
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

export default function GalleryLightbox({ items }: GalleryLightboxProps) {
  const [selected, setSelected] = useState<number | null>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const pointerStart = useRef<number | null>(null);

  const isOpen = selected !== null;

  useEffect(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>('[data-lightbox-index]'),
    );
    const cleanups = links.map((link) => {
      const open = (event: MouseEvent) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey
        )
          return;
        event.preventDefault();
        const index = Number(link.dataset.lightboxIndex);
        if (!Number.isNaN(index) && items[index]) {
          previousFocus.current = document.activeElement as HTMLElement | null;
          setSelected(index);
        }
      };
      link.addEventListener('click', open);
      return () => link.removeEventListener('click', open);
    });

    return () => cleanups.forEach((cleanup) => cleanup());
  }, [items]);

  useEffect(() => {
    if (!isOpen || !shellRef.current) return;

    const shell = shellRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const focusTimer = window.setTimeout(() => closeRef.current?.focus(), 0);

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setSelected(null);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        setSelected((current) =>
          current === null ? 0 : (current - 1 + items.length) % items.length,
        );
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        setSelected((current) =>
          current === null ? 0 : (current + 1) % items.length,
        );
        return;
      }
      if (event.key !== 'Tab') return;

      const focusable = focusableElements(shell);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    shell.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      shell.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previousFocus.current?.focus();
    };
  }, [isOpen]);

  if (items.length === 0) return null;

  const current = selected === null ? null : items[selected];
  const close = () => setSelected(null);

  return (
    <div
      ref={shellRef}
      className="lightbox-shell"
      hidden={selected === null}
      role="dialog"
      aria-modal="true"
      aria-label={current ? current.title || current.alt : 'Photo viewer'}
      onPointerDown={(event) => {
        pointerStart.current = event.clientX;
      }}
      onPointerUp={(event) => {
        if (pointerStart.current === null || selected === null) return;
        const delta = event.clientX - pointerStart.current;
        pointerStart.current = null;
        if (Math.abs(delta) < 48) return;
        setSelected((index) =>
          index === null
            ? null
            : delta > 0
              ? (index - 1 + items.length) % items.length
              : (index + 1) % items.length,
        );
      }}
    >
      <div className="lightbox-backdrop" aria-hidden="true" onClick={close} />
      <div className="lightbox-panel">
        <div className="lightbox-toolbar">
          <span className="lightbox-count" aria-live="polite">
            {selected === null ? '' : `${selected + 1} / ${items.length}`}
          </span>
          <button
            ref={closeRef}
            className="lightbox-close"
            type="button"
            onClick={close}
          >
            <span aria-hidden="true">×</span>
            <span className="sr-only">Close image viewer</span>
          </button>
        </div>

        {current && (
          <figure className="lightbox-figure">
            <img src={current.large} alt={current.alt} draggable="false" />
            {(current.title || current.caption || current.tags.length > 0) && (
              <figcaption>
                {current.title && <strong>{current.title}</strong>}
                {current.caption && <span>{current.caption}</span>}
                {current.tags.length > 0 && (
                  <span className="lightbox-tags">
                    {current.tags.join(' · ')}
                  </span>
                )}
              </figcaption>
            )}
          </figure>
        )}

        <button
          className="lightbox-arrow lightbox-arrow--previous"
          type="button"
          aria-label="Previous image"
          onClick={() =>
            setSelected((index) =>
              index === null ? null : (index - 1 + items.length) % items.length,
            )
          }
        >
          <span aria-hidden="true">←</span>
        </button>
        <button
          className="lightbox-arrow lightbox-arrow--next"
          type="button"
          aria-label="Next image"
          onClick={() =>
            setSelected((index) =>
              index === null ? null : (index + 1) % items.length,
            )
          }
        >
          <span aria-hidden="true">→</span>
        </button>
      </div>
    </div>
  );
}
