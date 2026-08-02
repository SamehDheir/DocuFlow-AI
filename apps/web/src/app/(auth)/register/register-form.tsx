'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordMeter, scorePassword } from '@/components/ui/password-meter';
import { TextField } from '@/components/ui/text-field';
import { AuthError, registerCompany } from '@/lib/auth';
import { DURATION, EASE, respectMotion, riseItem, stagger } from '@/lib/motion';

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

function validateStep(step: Step, values: Values): Errors {
  const errors: Errors = {};

  if (step === 0) {
    if (!values.companyName.trim()) {
      errors.companyName = 'Enter your company name.';
    } else if (values.companyName.trim().length < 2) {
      errors.companyName = 'That looks too short to be a company name.';
    }
    return errors;
  }

  if (!values.firstName.trim()) errors.firstName = 'Required.';
  if (!values.lastName.trim()) errors.lastName = 'Required.';

  if (!values.email.trim()) {
    errors.email = 'Enter your work email.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(values.email)) {
    errors.email = "That doesn't look like a valid email address.";
  }

  if (!values.password) {
    errors.password = 'Choose a password.';
  } else if (values.password.length < 12) {
    // Matches the intended server policy; the server remains the authority.
    errors.password = 'Use at least 12 characters.';
  } else if (scorePassword(values.password) < 2) {
    errors.password = 'Add numbers, symbols, or mixed case.';
  }

  return errors;
}

export function RegisterForm() {
  const reduced = useReducedMotion();

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
    const found = validateStep(0, values);
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

    const found = validateStep(1, values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;

    setFormError(undefined);
    setSubmitting(true);

    try {
      await registerCompany({
        companyName: values.companyName.trim(),
        firstName: values.firstName.trim(),
        lastName: values.lastName.trim(),
        email: values.email.trim(),
        password: values.password,
      });
      // Redirect to the dashboard lands with the backend endpoint.
    } catch (error) {
      if (error instanceof AuthError) {
        setFormError(error.message);
        if (error.fields) setErrors(error.fields);
      } else {
        setFormError('Something went wrong. Please try again.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  const variants = respectMotion(riseItem, reduced);

  // Steps slide along the axis of travel so forward and back feel directional
  // rather than like two unrelated screens.
  const slide = {
    enter: (dir: 1 | -1) => ({ opacity: 0, x: reduced ? 0 : dir * 24 }),
    center: { opacity: 1, x: 0 },
    exit: (dir: 1 | -1) => ({ opacity: 0, x: reduced ? 0 : dir * -24 }),
  };

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <motion.div variants={variants}>
        <p className="mb-3 flex items-center gap-2 text-xs font-medium tracking-wide text-text-subtle uppercase">
          <span>Step {step + 1} of 2</span>
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
          {step === 0 ? 'Create your workspace' : 'Your admin account'}
        </h1>
        <p className="mt-2 text-sm text-text-muted">
          {step === 0
            ? 'Every company gets an isolated workspace. Nothing is shared between them.'
            : 'You will be the first administrator, able to invite the rest of your team.'}
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
                  label="Company name"
                  name="organization"
                  autoComplete="organization"
                  autoFocus
                  placeholder="Acme Corporation"
                  hint="This becomes your workspace name. You can change it later."
                  value={values.companyName}
                  error={errors.companyName}
                  onChange={(e) => set('companyName', e.target.value)}
                />
              ) : (
                <>
                  <div className="flex gap-3">
                    <TextField
                      label="First name"
                      name="given-name"
                      autoComplete="given-name"
                      autoFocus
                      placeholder="Sameh"
                      value={values.firstName}
                      error={errors.firstName}
                      onChange={(e) => set('firstName', e.target.value)}
                    />
                    <TextField
                      label="Last name"
                      name="family-name"
                      autoComplete="family-name"
                      placeholder="Dheir"
                      value={values.lastName}
                      error={errors.lastName}
                      onChange={(e) => set('lastName', e.target.value)}
                    />
                  </div>

                  <TextField
                    label="Work email"
                    type="email"
                    name="email"
                    inputMode="email"
                    autoComplete="email"
                    placeholder="you@company.com"
                    value={values.email}
                    error={errors.email}
                    onChange={(e) => set('email', e.target.value)}
                  />

                  <div>
                    <TextField
                      label="Password"
                      name="new-password"
                      autoComplete="new-password"
                      revealable
                      placeholder="At least 12 characters"
                      value={values.password}
                      error={errors.password}
                      onChange={(e) => set('password', e.target.value)}
                    />
                    <PasswordMeter value={values.password} />
                  </div>
                </>
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        <motion.div variants={variants} className="mt-7 flex gap-3">
          {step === 1 && (
            <Button type="button" variant="secondary" size="lg" onClick={goBack}>
              Back
            </Button>
          )}
          <Button type="submit" size="lg" block loading={submitting}>
            {step === 0 ? 'Continue' : submitting ? 'Creating workspace' : 'Create workspace'}
          </Button>
        </motion.div>
      </form>

      <motion.div variants={variants} className="mt-8">
        <div className="rule-fade h-px" aria-hidden="true" />
        <p className="mt-6 text-center text-sm text-text-muted">
          Already have a workspace?{' '}
          <Link
            href="/login"
            className="font-medium text-accent underline-offset-4 transition-opacity hover:underline hover:opacity-80"
          >
            Sign in
          </Link>
        </p>
      </motion.div>
    </motion.div>
  );
}
