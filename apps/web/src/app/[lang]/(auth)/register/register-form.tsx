'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Button } from '@/components/ui/button';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordMeter, scorePassword } from '@/components/ui/password-meter';
import { TextField } from '@/components/ui/text-field';
import type { Locale } from '@/i18n/config';
import { interpolate } from '@/i18n/interpolate';
import type { Dictionary } from '@/i18n/get-dictionary';
import { AuthError, registerCompany } from '@/lib/auth';
import { DURATION, EASE, respectMotion, riseItem, stagger } from '@/lib/motion';

type RegisterStrings = Dictionary['register'];
type CommonStrings = Dictionary['common'];

type Step = 0 | 1;

interface Values {
  companyName: string;
  firstName: string;
  lastName: string;
  email: string;
  password: string;
}

type Errors = Partial<Record<keyof Values, string>>;

const EMPTY: Values = {
  companyName: '',
  firstName: '',
  lastName: '',
  email: '',
  password: '',
};

function validateStep(step: Step, values: Values, t: RegisterStrings): Errors {
  const errors: Errors = {};

  if (step === 0) {
    if (!values.companyName.trim()) {
      errors.companyName = t.errors.companyRequired;
    } else if (values.companyName.trim().length < 2) {
      errors.companyName = t.errors.companyShort;
    }
    return errors;
  }

  if (!values.firstName.trim()) errors.firstName = t.errors.required;
  if (!values.lastName.trim()) errors.lastName = t.errors.required;

  if (!values.email.trim()) {
    errors.email = t.errors.emailRequired;
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = t.errors.emailInvalid;
  }

  if (!values.password) {
    errors.password = t.errors.passwordRequired;
  } else if (values.password.length < 12) {
    // Matches the intended server policy; the server remains the authority.
    errors.password = t.errors.passwordShort;
  } else if (scorePassword(values.password) < 2) {
    errors.password = t.errors.passwordWeak;
  }

  return errors;
}

export function RegisterForm({
  lang,
  t,
  common,
}: {
  lang: Locale;
  t: RegisterStrings;
  common: CommonStrings;
}) {
  const reduced = useReducedMotion();
  const router = useRouter();
  const { adopt } = useSession();

  const [step, setStep] = useState<Step>(0);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [values, setValues] = useState<Values>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  function set<K extends keyof Values>(key: K, value: Values[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
    // Clear a field's error as soon as the user starts correcting it; leaving
    // it visible while they type reads as the form arguing with them.
    setErrors((prev) => (prev[key] ? { ...prev, [key]: undefined } : prev));
  }

  function goNext() {
    const found = validateStep(0, values, t);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setDirection(1);
    setStep(1);
    setFormError(undefined);
  }

  function goBack() {
    setDirection(-1);
    setStep(0);
    setFormError(undefined);
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    if (step === 0) {
      goNext();
      return;
    }

    const found = validateStep(1, values, t);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setFormError(undefined);
    setSubmitting(true);

    try {
      adopt(
        await registerCompany({
          companyName: values.companyName.trim(),
          firstName: values.firstName.trim(),
          lastName: values.lastName.trim(),
          email: values.email.trim(),
          password: values.password,
        }),
      );
      // Left submitting on purpose: the navigation is already in flight, and
      // re-enabling the button first invites a second submit.
      router.replace(`/${lang}/dashboard`);
    } catch (error) {
      setFormError(error instanceof AuthError ? error.message : common.genericError);
      if (error instanceof AuthError && error.fields) setErrors(error.fields);
      setSubmitting(false);
    }
  }

  const variants = respectMotion(riseItem, reduced);

  /**
   * Steps slide along the axis of travel so forward and back feel directional.
   *
   * The sign is flipped for RTL: in Arabic "forward" is leftward, so reusing the
   * LTR offsets would animate the next step in from the direction the reader
   * just came from.
   */
  const rtl = lang === 'ar';
  const axis = rtl ? -1 : 1;

  const slide = {
    enter: (dir: 1 | -1) => ({ opacity: 0, x: reduced ? 0 : dir * 24 * axis }),
    center: { opacity: 1, x: 0 },
    exit: (dir: 1 | -1) => ({ opacity: 0, x: reduced ? 0 : dir * -24 * axis }),
  };

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <motion.div variants={variants}>
        <p className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wide text-text-subtle uppercase">
          <span>{interpolate(t.step, { current: step + 1, total: 2 })}</span>
          <span className="flex gap-1" aria-hidden="true">
            {[0, 1].map((index) => (
              <motion.span
                key={index}
                className="h-1 rounded-full bg-accent"
                initial={false}
                animate={{
                  width: index <= step ? 18 : 8,
                  opacity: index <= step ? 1 : 0.25,
                }}
                transition={{ duration: DURATION.base, ease: EASE.outQuint }}
              />
            ))}
          </span>
        </p>

        <h1 className="font-display text-3xl font-semibold tracking-tight">
          {step === 0 ? t.titleCompany : t.titleAccount}
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          {step === 0 ? t.subtitleCompany : t.subtitleAccount}
        </p>
      </motion.div>

      <motion.div variants={variants} className="mt-8">
        <FormAlert message={formError} />
      </motion.div>

      <form onSubmit={onSubmit} noValidate>
        <div className="relative">
          <AnimatePresence mode="wait" custom={direction} initial={false}>
            <motion.div
              key={step}
              custom={direction}
              variants={slide}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{ duration: DURATION.base, ease: EASE.outQuint }}
              className="flex flex-col gap-5"
            >
              {step === 0 ? (
                <TextField
                  label={t.companyName}
                  name="organization"
                  autoComplete="organization"
                  autoFocus
                  placeholder={t.companyPlaceholder}
                  hint={t.companyHint}
                  value={values.companyName}
                  error={errors.companyName}
                  onChange={(e) => set('companyName', e.target.value)}
                />
              ) : (
                <>
                  <div className="flex gap-3">
                    <TextField
                      label={t.firstName}
                      name="given-name"
                      autoComplete="given-name"
                      autoFocus
                      value={values.firstName}
                      error={errors.firstName}
                      onChange={(e) => set('firstName', e.target.value)}
                    />
                    <TextField
                      label={t.lastName}
                      name="family-name"
                      autoComplete="family-name"
                      value={values.lastName}
                      error={errors.lastName}
                      onChange={(e) => set('lastName', e.target.value)}
                    />
                  </div>

                  <TextField
                    label={t.email}
                    type="email"
                    name="email"
                    inputMode="email"
                    autoComplete="email"
                    dir="ltr"
                    placeholder={t.emailPlaceholder}
                    value={values.email}
                    error={errors.email}
                    onChange={(e) => set('email', e.target.value)}
                  />

                  <div>
                    <TextField
                      label={t.password}
                      name="new-password"
                      autoComplete="new-password"
                      // See login-form: no dir="ltr" on password fields, or the
                      // reveal button and its clearance land on opposite sides
                      // in RTL.
                      revealable
                      revealLabels={{ show: common.showPassword, hide: common.hidePassword }}
                      placeholder={t.passwordPlaceholder}
                      value={values.password}
                      error={errors.password}
                      onChange={(e) => set('password', e.target.value)}
                    />
                    <PasswordMeter value={values.password} labels={t.strength} />
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <motion.div variants={variants} className="mt-7 flex gap-3">
          {step === 1 && (
            <Button type="button" variant="secondary" size="lg" onClick={goBack}>
              {t.back}
            </Button>
          )}
          <Button type="submit" size="lg" block loading={submitting}>
            {step === 0 ? t.continue : submitting ? t.submitting : t.submit}
          </Button>
        </motion.div>
      </form>

      <motion.div variants={variants} className="mt-8">
        <div className="rule-fade h-px" aria-hidden="true" />
        <p className="mt-6 text-center text-sm text-text-muted">
          {t.haveAccount}{' '}
          <Link
            href={`/${lang}/login`}
            className="font-medium text-accent underline-offset-4 transition-opacity hover:underline hover:opacity-80"
          >
            {t.signIn}
          </Link>
        </p>
      </motion.div>
    </motion.div>
  );
}
