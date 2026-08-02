'use client';

import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { FormAlert } from '@/components/ui/form-alert';
import { TextField } from '@/components/ui/text-field';
import { AuthError, signIn } from '@/lib/auth';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

interface FieldErrors {
  email?: string;
  password?: string;
}

function validate(email: string, password: string): FieldErrors {
  const errors: FieldErrors = {};

  if (!email.trim()) {
    errors.email = 'Enter your work email.';
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    errors.email = "That doesn't look like a valid email address.";
  }

  if (!password) {
    errors.password = 'Enter your password.';
  }

  return errors;
}

export function LoginForm() {
  const reduced = useReducedMotion();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);

  /**
   * Validation runs on submit, then live only for fields already found invalid.
   * Validating on every keystroke from the start shows an "invalid email" error
   * to someone who has typed one character and is not finished yet.
   */
  const [validateLive, setValidateLive] = useState(false);

  function update(field: 'email' | 'password', value: string) {
    if (field === 'email') setEmail(value);
    else setPassword(value);

    if (validateLive) {
      const next = validate(
        field === 'email' ? value : email,
        field === 'password' ? value : password,
      );
      setErrors(next);
    }
  }

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const found = validate(email, password);
    setErrors(found);
    setValidateLive(true);

    if (Object.keys(found).length > 0) {
      // Move focus to the first problem so keyboard and screen-reader users are
      // not left at the submit button wondering what happened.
      document.getElementById(found.email ? 'email' : 'password')?.focus();
      return;
    }

    setFormError(undefined);
    setSubmitting(true);

    try {
      await signIn({ email, password });
      // Session handling and the redirect to /dashboard land with the backend
      // endpoint; there is nothing to route to yet.
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

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <motion.div variants={variants}>
        <h1 className="font-display text-3xl font-semibold tracking-tight">Sign in</h1>
        <p className="mt-2 text-sm text-text-muted">
          Access your workspace and pick up where you left off.
        </p>
      </motion.div>

      <motion.div variants={variants} className="mt-8">
        <FormAlert message={formError} />
      </motion.div>

      <form onSubmit={onSubmit} noValidate className="flex flex-col gap-5">
        <motion.div variants={variants}>
          <TextField
            id="email"
            label="Work email"
            type="email"
            name="email"
            inputMode="email"
            autoComplete="email"
            autoFocus
            placeholder="you@company.com"
            value={email}
            error={errors.email}
            onChange={(e) => update('email', e.target.value)}
          />
        </motion.div>

        <motion.div variants={variants}>
          <TextField
            id="password"
            label="Password"
            name="password"
            autoComplete="current-password"
            placeholder="••••••••••••"
            revealable
            value={password}
            error={errors.password}
            onChange={(e) => update('password', e.target.value)}
            action={
              <Link
                href="/forgot-password"
                className="text-xs font-medium text-accent transition-opacity hover:opacity-75"
              >
                Forgot password?
              </Link>
            }
          />
        </motion.div>

        <motion.div variants={variants} className="mt-1">
          <Button type="submit" size="lg" block loading={submitting}>
            {submitting ? 'Signing in' : 'Sign in'}
          </Button>
        </motion.div>
      </form>

      <motion.div variants={variants} className="mt-8">
        <div className="rule-fade h-px" aria-hidden="true" />
        <p className="mt-6 text-center text-sm text-text-muted">
          Don&apos;t have a workspace?{' '}
          <Link
            href="/register"
            className="font-medium text-accent underline-offset-4 transition-opacity hover:underline hover:opacity-80"
          >
            Create one
          </Link>
        </p>
      </motion.div>
    </motion.div>
  );
}
