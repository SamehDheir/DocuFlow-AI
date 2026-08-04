'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormAlert } from '@/components/ui/form-alert';
import { TextField } from '@/components/ui/text-field';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { AuthError, requestPasswordReset } from '@/lib/auth';
import { DURATION, EASE, respectMotion, riseItem, stagger } from '@/lib/motion';

type ForgotStrings = Dictionary['forgot'];
type CommonStrings = Dictionary['common'];

/** Seconds before "Send again" becomes available. */
const RESEND_COOLDOWN = 30;

export function ForgotPasswordForm({
  lang,
  t,
  common,
}: {
  lang: Locale;
  t: ForgotStrings;
  common: CommonStrings;
}) {
  const reduced = useReducedMotion();

  const [email, setEmail] = useState('');
  const [error, setError] = useState<string>();
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;

    const id = setTimeout(() => setCooldown((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  function validate(value: string): string | undefined {
    if (!value.trim()) return t.errors.emailRequired;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return t.errors.emailInvalid;
    return undefined;
  }

  async function submit() {
    setFormError(undefined);
    setSubmitting(true);

    try {
      await requestPasswordReset({ email: email.trim() });
      setSent(true);
      setCooldown(RESEND_COOLDOWN);
    } catch (err) {
      setFormError(err instanceof AuthError ? err.message : common.genericError);
    } finally {
      setSubmitting(false);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const found = validate(email);
    setError(found);
    if (found) {
      document.getElementById('email')?.focus();
      return;
    }

    await submit();
  }

  const variants = respectMotion(riseItem, reduced);

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <AnimatePresence mode="wait" initial={false}>
        {sent ? (
          /* ------------------------------------------------------------------
           * Confirmation
           * ------------------------------------------------------------------ */
          <motion.div
            key="sent"
            initial={{ opacity: 0, y: reduced ? 0 : 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DURATION.slow, ease: EASE.outExpo }}
          >
            <span
              className="mb-5 inline-flex size-11 items-center justify-center rounded-xl bg-success-subtle text-success"
              aria-hidden="true"
            >
              <svg viewBox="0 0 24 24" className="size-5.5" fill="none">
                <motion.path
                  d="M3.5 7.2 12 12.8l8.5-5.6M4.4 5h15.2A1.4 1.4 0 0 1 21 6.4v11.2a1.4 1.4 0 0 1-1.4 1.4H4.4A1.4 1.4 0 0 1 3 17.6V6.4A1.4 1.4 0 0 1 4.4 5Z"
                  stroke="currentColor"
                  strokeWidth="1.7"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={reduced ? undefined : { pathLength: 1 }}
                  transition={{ duration: 0.7, ease: EASE.outExpo }}
                />
              </svg>
            </span>

            <h1 className="font-display text-3xl font-semibold tracking-tight">{t.sentTitle}</h1>

            {/* The email is user input rendered back — kept in an isolated LTR
                span so an RTL layout does not reorder the address. */}
            <p className="mt-3 text-sm leading-relaxed text-text-muted">
              {interpolate(t.sentBody, { email: '⁨' + email.trim() + '⁩' })}
            </p>

            <p className="mt-4 rounded-lg border border-border bg-surface-inset px-3.5 py-3 text-xs leading-relaxed text-text-subtle">
              {t.sentNote}
            </p>

            <div className="mt-7 flex flex-col gap-3">
              <Button
                type="button"
                variant="secondary"
                size="lg"
                block
                disabled={cooldown > 0}
                loading={submitting}
                onClick={() => void submit()}
              >
                {cooldown > 0 ? interpolate(t.resendIn, { seconds: cooldown }) : t.resend}
              </Button>

              <Link
                href={`/${lang}/login`}
                className="text-center text-sm font-medium text-accent underline-offset-4 transition-opacity hover:underline hover:opacity-80"
              >
                {common.backToSignIn}
              </Link>
            </div>
          </motion.div>
        ) : (
          /* ------------------------------------------------------------------
           * Request form
           * ------------------------------------------------------------------ */
          <motion.div key="form" exit={{ opacity: 0 }}>
            <motion.div variants={variants}>
              <h1 className="font-display text-3xl font-semibold tracking-tight">{t.title}</h1>
              <p className="mt-2 text-sm text-text-muted">{t.subtitle}</p>
            </motion.div>

            <motion.div variants={variants} className="mt-8">
              <FormAlert message={formError} />
            </motion.div>

            <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
              <motion.div variants={variants}>
                <TextField
                  id="email"
                  label={t.email}
                  type="email"
                  name="email"
                  inputMode="email"
                  autoComplete="email"
                  autoFocus
                  dir="ltr"
                  placeholder={t.emailPlaceholder}
                  value={email}
                  error={error}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    if (error) setError(validate(e.target.value));
                  }}
                />
              </motion.div>

              <motion.div variants={variants} className="mt-1">
                <Button type="submit" size="lg" block loading={submitting}>
                  {submitting ? t.submitting : t.submit}
                </Button>
              </motion.div>
            </form>

            <motion.div variants={variants} className="mt-8">
              <div className="rule-fade h-px" aria-hidden="true" />
              <p className="mt-6 text-center text-sm text-text-muted">
                {t.remembered}{' '}
                <Link
                  href={`/${lang}/login`}
                  className="font-medium text-accent underline-offset-4 transition-opacity hover:underline hover:opacity-80"
                >
                  {common.backToSignIn}
                </Link>
              </p>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}
