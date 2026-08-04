'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { DURATION, EASE } from '@/lib/motion';

/**
 * Page-wide drag-and-drop target.
 *
 * Listens on the window rather than wrapping a box, because "drop a file
 * anywhere on the page" is what people actually try. A counter tracks
 * enter/leave: dragging over a child element fires `dragleave` on the parent,
 * so a boolean flag flickers the overlay on every nested element crossed.
 */
export function DropZone({
  onFiles,
  folderName,
  t,
  children,
}: {
  onFiles: (files: File[]) => void;
  folderName: string;
  t: Dictionary['upload'];
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const reduced = useReducedMotion();

  const carriesFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

  const onDragEnter = useCallback((event: DragEvent) => {
    if (!carriesFiles(event)) return;

    event.preventDefault();
    depth.current += 1;
    setDragging(true);
  }, []);

  const onDragOver = useCallback((event: DragEvent) => {
    // Without this the browser navigates to the file instead of letting the
    // page handle the drop.
    if (carriesFiles(event)) event.preventDefault();
  }, []);

  const onDragLeave = useCallback((event: DragEvent) => {
    if (!carriesFiles(event)) return;

    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setDragging(false);
    }
  }, []);

  const onDrop = useCallback(
    (event: DragEvent) => {
      if (!carriesFiles(event)) return;

      event.preventDefault();
      depth.current = 0;
      setDragging(false);

      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length > 0) onFiles(files);
    },
    [onFiles],
  );

  useEffect(() => {
    window.addEventListener('dragenter', onDragEnter);
    window.addEventListener('dragover', onDragOver);
    window.addEventListener('dragleave', onDragLeave);
    window.addEventListener('drop', onDrop);

    return () => {
      window.removeEventListener('dragenter', onDragEnter);
      window.removeEventListener('dragover', onDragOver);
      window.removeEventListener('dragleave', onDragLeave);
      window.removeEventListener('drop', onDrop);
    };
  }, [onDragEnter, onDragOver, onDragLeave, onDrop]);

  return (
    <>
      {children}

      <AnimatePresence>
        {dragging ? (
          <motion.div
            className="border-accent bg-canvas/80 pointer-events-none fixed inset-4 z-50 flex flex-col items-center justify-center rounded-2xl border-2 border-dashed backdrop-blur-sm"
            initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.99 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
            /*
             * Announced, because a drag is entirely visual otherwise — but the
             * overlay itself is pointer-events-none so it can never swallow the
             * drop it is describing.
             */
            role="status"
            aria-live="polite"
          >
            <svg
              width="44"
              height="44"
              viewBox="0 0 44 44"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              className="text-accent mb-4"
              aria-hidden="true"
            >
              <path d="M22 29V9m0 0-7 7m7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
              <path d="M7 27v5a3 3 0 0 0 3 3h24a3 3 0 0 0 3-3v-5" strokeLinecap="round" />
            </svg>

            <p className="font-display text-2xl">{t.dropTitle}</p>
            <p className="text-text-muted mt-1 text-sm">
              {interpolate(t.dropBody, { folder: folderName })}
            </p>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
