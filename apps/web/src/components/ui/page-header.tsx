'use client';

import { motion, type HTMLMotionProps } from 'motion/react';
import { cn } from '@/lib/cn';

/**
 * The masthead every in-app screen opens with.
 *
 * Six views had grown their own copy of eyebrow / display heading / subtitle,
 * and they had already drifted — two carried `tracking-tight text-balance` and
 * two did not, one used `mt-2` where another used `mt-1`. Type hierarchy is the
 * loudest signal of whether a product was designed, so it is decided once here.
 *
 * The eyebrow is not decoration: it names the section in small caps above a
 * display-serif title, which is what stops a page of sans-serif UI from reading
 * as flat. It repeats the title on most screens today and is a separate slot so
 * a breadcrumb can take its place — the documents view already passes a folder
 * path through it.
 *
 * Extends motion props, so a caller can hand it the `variants` from the page's
 * stagger without a wrapper element: `<PageHeader variants={riseItem} … />`.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
  ...props
}: Omit<HTMLMotionProps<'header'>, 'title'> & {
  /** Small-caps line above the title. A section name, or a breadcrumb. */
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** End-aligned controls, bottom-aligned with the title block. */
  actions?: React.ReactNode;
}) {
  return (
    <motion.header
      className={cn('flex flex-wrap items-end justify-between gap-x-4 gap-y-3', className)}
      {...props}
    >
      <div className="min-w-0">
        {eyebrow ? (
          <div className="text-text-subtle text-xs font-medium tracking-wide uppercase">
            {eyebrow}
          </div>
        ) : null}

        <h1 className="font-display mt-1 text-3xl tracking-tight text-balance sm:text-4xl">
          {title}
        </h1>

        {description ? (
          <p className="text-text-muted mt-2 max-w-2xl text-sm">{description}</p>
        ) : null}
      </div>

      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </motion.header>
  );
}
