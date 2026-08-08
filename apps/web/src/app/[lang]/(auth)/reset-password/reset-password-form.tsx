'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordMeter } from '@/components/ui/password-meter';
import { TextField } from '@/components/ui/text-field';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { resetPassword } from '@/lib/auth';
import { errorMessage } from '@/lib/error-message';
import { DURATION, EASE, respectMotion, riseItem, stagger } from '@/lib/motion';

interface FieldErrors {
  password?: string;
  confirm?: string;
}

/**
 * The other half of forgot-password, and until now the half that did not exist —
 * every reset link landed on a 404.
 *
 * There is no preview endpoint for a reset token, unlike an invitation: the API
 * deliberately exposes no way to ask "is this token good?" without spending it,
 * since that would be an oracle for guessing them. So an absent token is caught
 * here, and a stale one is only discovered on submit — which is why the failure
 * state is a whole screen with a way forward rather than an inline message.
 */
export function ResetPasswordForm({
  lang,
  t,
  register,
  common,
  errors,
}: {
  lang: Locale;
  t: Dictionary['reset'];
  /** The password field's copy is shared with the register form. */
  register: Dictionary['register'];
  common: Dictionary['common'];
  errors: Dictionary['errors'];
}) {
  const reduced = useReducedMotion();
  const variants = respectMotion(riseItem, reduced);

  /**
   * Read during render, not in an effect.
   *
   * An effect would set state on mount, which cascades a second render and is
   * what `react-hooks/set-state-in-effect` objects to; a `window.location` read
   * during render would disagree between the prerender and hydration. The route
   * is wrapped in a Suspense boundary in page.tsx, which is what lets this hook
   * bail out of the static prerender cleanly.
   */
  const token = useSearchParams().get('token');

  const [done, setDone] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy || !token) return;

    const next: FieldErrors = {};

    if (!password) next.password = t.errors.required;
    else if (password.length < 12) next.password = t.errors.short;
    if (confirm !== password) next.confirm = t.errors.mismatch;

    setFields(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    setMessage('');

    try {
      await resetPassword({ token, password });
      setDone(true);
    } catch (error) {
      setMessage(errorMessage(error, errors, common.genericError));
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <motion.div variants={stagger} initial="hidden" animate="visible">
        <motion.h1
          variants={variants}
          className="font-display text-2xl tracking-tight text-balance"
        >
          {t.invalidTitle}
        </motion.h1>
        <motion.p variants={variants} className="mt-3 text-sm leading-relaxed text-text-muted">
          {t.invalidBody}
        </motion.p>
        <motion.div variants={variants} className="mt-8 flex flex-col gap-3">
          <Link href={`/${lang}/forgot-password`} className="block">
            <Button type="button" size="lg" block>
              {t.invalidAction}
            </Button>
          </Link>
          <Link
            href={`/${lang}/login`}
            className="rounded-md text-center text-sm font-medium text-accent underline-offset-4 transition-opacity hover:underline hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {common.backToSignIn}
          </Link>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <AnimatePresence mode="wait" initial={false}>
        {done ? (
          <motion.div
            key="done"
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
                  d="m5 12.5 4.5 4.5L19 7.5"
                  stroke="currentColor"
                  strokeWidth="1.9"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  initial={reduced ? false : { pathLength: 0 }}
                  animate={reduced ? undefined : { pathLength: 1 }}
                  transition={{ duration: 0.55, ease: EASE.outExpo }}
                />
              </svg>
            </span>

            <h1 className="font-display text-2xl tracking-tight text-balance">{t.doneTitle}</h1>
            <p className="mt-3 text-sm leading-relaxed text-text-muted">{t.doneBody}</p>

            <div className="mt-7">
              <Link href={`/${lang}/login`} className="block">
                <Button type="button" size="lg" block>
                  {t.doneAction}
                </Button>
              </Link>
            </div>
          </motion.div>
        ) : (
          <motion.div key="form" exit={{ opacity: 0 }}>
            <motion.div variants={variants}>
              <h1 className="font-display text-2xl tracking-tight text-balance">{t.title}</h1>
              <p className="mt-2.5 text-sm leading-relaxed text-text-muted">{t.subtitle}</p>
            </motion.div>

            <motion.form
              variants={variants}
              onSubmit={(event) => void submit(event)}
              noValidate
              className="mt-8 flex flex-col gap-5"
            >
              <FormAlert message={message} />

              <div>
                <TextField
                  id="password"
                  type="password"
                  label={t.passwordLabel}
                  placeholder={t.passwordPlaceholder}
                  value={password}
                  error={fields.password}
                  autoComplete="new-password"
                  autoFocus
                  revealLabels={{ show: common.showPassword, hide: common.hidePassword }}
                  onChange={(event) => {
                    setPassword(event.target.value);
                    setFields((current) => ({ ...current, password: undefined }));
                  }}
                />

                <PasswordMeter value={password} className="mt-3" labels={register.strength} />
              </div>

              <TextField
                id="confirm"
                type="password"
                label={t.confirmLabel}
                value={confirm}
                error={fields.confirm}
                autoComplete="new-password"
                revealLabels={{ show: common.showPassword, hide: common.hidePassword }}
                onChange={(event) => {
                  setConfirm(event.target.value);
                  setFields((current) => ({ ...current, confirm: undefined }));
                }}
              />

              <Button type="submit" size="lg" block loading={busy}>
                {busy ? t.submitting : t.submit}
              </Button>
            </motion.form>

            <motion.div variants={variants} className="mt-8">
              <div className="rule-fade h-px" aria-hidden="true" />
              <p className="mt-6 text-center text-sm text-text-muted">
                <Link
                  href={`/${lang}/login`}
                  className="rounded-md font-medium text-accent underline-offset-4 transition-opacity hover:underline hover:opacity-80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
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
