'use client';

import { motion, useReducedMotion, type HTMLMotionProps } from 'motion/react';
import { cn } from '@/lib/cn';
import { DURATION, EASE } from '@/lib/motion';

type Variant = 'primary' | 'secondary' | 'ghost';
type Size = 'sm' | 'md' | 'lg';

const VARIANT: Record<Variant, string> = {
  primary: cn(
    'bg-accent text-accent-fg shadow-sm',
    'hover:bg-accent-hover hover:shadow-md',
    'active:bg-accent-active',
  ),
  secondary: cn(
    'bg-surface text-text border border-border-strong shadow-xs',
    'hover:bg-surface-inset hover:border-text-subtle',
  ),
  ghost: 'text-text-muted hover:text-text hover:bg-surface-inset',
};

const SIZE: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5 rounded-md',
  md: 'h-10 px-4 text-sm gap-2 rounded-lg',
  lg: 'h-11 px-5 text-base gap-2 rounded-lg',
};

interface ButtonProps extends Omit<HTMLMotionProps<'button'>, 'children'> {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
  /** Renders the button at full container width. */
  block?: boolean;
  children?: React.ReactNode;
}

export function Button({
  variant = 'primary',
  size = 'md',
  loading = false,
  block = false,
  disabled,
  className,
  children,
  ...props
}: ButtonProps) {
  const reduced = useReducedMotion();
  const inert = disabled || loading;

  return (
    <motion.button
      // A disabled button gives no feedback about WHY it is disabled. Keeping it
      // focusable with aria-disabled lets screen-reader users reach it and read
      // the state, while the submit handler ignores the press.
      aria-disabled={inert}
      aria-busy={loading}
      disabled={disabled}
      whileHover={inert || reduced ? undefined : { y: -1 }}
      whileTap={inert || reduced ? undefined : { y: 0, scale: 0.985 }}
      transition={{ duration: DURATION.fast, ease: EASE.outQuint }}
      className={cn(
        'relative inline-flex items-center justify-center overflow-hidden',
        'font-medium whitespace-nowrap select-none',
        'transition-colors duration-fast ease-out-quint',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        VARIANT[variant],
        SIZE[size],
        block && 'w-full',
        inert && 'pointer-events-none opacity-60',
        className,
      )}
      {...props}
    >
      {/* Indeterminate sweep. Communicates "working" without the layout shift a
       * swapped-in spinner causes, and without hiding the label. */}
      {loading && (
        <span className="pointer-events-none absolute inset-0 overflow-hidden">
          <span className="animate-sweep absolute inset-y-0 -inset-x-full bg-linear-to-r from-transparent via-white/25 to-transparent" />
        </span>
      )}
      <span className={cn('inline-flex items-center gap-2', loading && 'opacity-90')}>
        {loading && (
          <svg viewBox="0 0 16 16" className="size-3.5 shrink-0 animate-spin" aria-hidden="true">
            <circle
              cx="8"
              cy="8"
              r="6.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              opacity="0.25"
            />
            <path
              d="M14.5 8A6.5 6.5 0 0 0 8 1.5"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
            />
          </svg>
        )}
        {children}
      </span>
    </motion.button>
  );
}
