'use client';

import { motion, useReducedMotion } from 'motion/react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Button } from '@/components/ui/button';
import { FormAlert } from '@/components/ui/form-alert';
import { PasswordMeter } from '@/components/ui/password-meter';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import { TextField } from '@/components/ui/text-field';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { acceptInvitation } from '@/lib/auth';
import { errorMessage } from '@/lib/error-message';
import { previewInvitation, type InvitationPreview } from '@/lib/invitations';
import { respectMotion, riseItem, stagger } from '@/lib/motion';

type Load = 'checking' | 'ready' | 'invalid';

interface FieldErrors {
  firstName?: string;
  lastName?: string;
  password?: string;
}

/**
 * Accepting an invitation: the only way into a company you did not create.
 *
 * The token in the query string is the credential. It names the company and the
 * role, so neither appears as an input — a form that let you type a company
 * name would be a form that let you pick which tenant to join.
 *
 * The invitation is checked before the form is shown rather than on submit. An
 * expired link should say so immediately, not after someone has chosen a
 * password and filled in their name.
 */
export function AcceptInviteForm({
  lang,
  t,
  register,
  common,
  errors,
}: {
  lang: Locale;
  t: Dictionary['invite'];
  /** Field labels and validation copy are shared with the register form. */
  register: Dictionary['register'];
  common: Dictionary['common'];
  errors: Dictionary['errors'];
}) {
  const router = useRouter();
  const { adopt } = useSession();
  const reduced = useReducedMotion();
  const variants = respectMotion(riseItem, reduced);

  const [token, setToken] = useState('');
  const [load, setLoad] = useState<Load>('checking');
  const [invitation, setInvitation] = useState<InvitationPreview | null>(null);

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [password, setPassword] = useState('');
  const [fields, setFields] = useState<FieldErrors>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * The token is read from the URL in an effect rather than during render:
   * `window` does not exist while this is prerendered, and reading
   * `useSearchParams` here would opt the whole route into client rendering for
   * a value only the browser can supply anyway.
   */
  useEffect(() => {
    let current = true;

    const presented = new URLSearchParams(window.location.search).get('token') ?? '';

    void (async () => {
      if (!presented) {
        if (current) setLoad('invalid');
        return;
      }

      try {
        const preview = await previewInvitation(presented);
        if (!current) return;

        setToken(presented);
        setInvitation(preview);
        setLoad('ready');
      } catch {
        // Expired, revoked, already used, or simply wrong — all one message.
        // Distinguishing them would tell a stranger holding a stale link
        // something about a company they have no relationship with.
        if (current) setLoad('invalid');
      }
    })();

    return () => {
      current = false;
    };
  }, []);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const next: FieldErrors = {};

    if (!firstName.trim()) next.firstName = register.errors.required;
    if (!lastName.trim()) next.lastName = register.errors.required;
    if (!password) next.password = register.errors.passwordRequired;
    else if (password.length < 12) next.password = register.errors.passwordShort;

    setFields(next);
    if (Object.keys(next).length > 0) return;

    setBusy(true);
    setMessage('');

    try {
      const session = await acceptInvitation({
        token,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        password,
      });

      adopt(session);
      router.replace(`/${lang}/dashboard`);
    } catch (error) {
      setMessage(errorMessage(error, errors, common.genericError));
      setBusy(false);
    }
  };

  if (load === 'checking') {
    return (
      <SkeletonRegion label={t.checking}>
        <Skeleton className="h-9 w-56 max-w-full rounded-lg" />
        <Skeleton className="mt-3 h-4 w-72 max-w-full rounded" />

        <div className="mt-8 flex flex-col gap-5">
          {[0, 1, 2].map((index) => (
            <div key={index}>
              <Skeleton className="mb-1.5 h-3 w-24 rounded" />
              <Skeleton className="h-11 w-full rounded-lg" />
            </div>
          ))}
          <Skeleton className="h-11 w-full rounded-lg" />
        </div>
      </SkeletonRegion>
    );
  }

  if (load === 'invalid' || !invitation) {
    return (
      <motion.div variants={stagger} initial="hidden" animate="visible">
        <motion.h1
          variants={variants}
          className="font-display text-2xl tracking-tight text-balance"
        >
          {t.invalid.title}
        </motion.h1>
        <motion.p variants={variants} className="text-text-muted mt-3 text-sm leading-relaxed">
          {t.invalid.body}
        </motion.p>
        <motion.div variants={variants} className="mt-8">
          <Link
            href={`/${lang}/login`}
            className="text-accent rounded-md text-sm hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {t.invalid.action}
          </Link>
        </motion.div>
      </motion.div>
    );
  }

  return (
    <motion.div variants={stagger} initial="hidden" animate="visible">
      <motion.h1 variants={variants} className="font-display text-2xl tracking-tight text-balance">
        {interpolate(t.title, { company: invitation.companyName })}
      </motion.h1>
      <motion.p variants={variants} className="text-text-muted mt-2.5 text-sm leading-relaxed">
        {interpolate(t.subtitle, {
          company: invitation.companyName,
          role: invitation.roleName,
        })}
      </motion.p>

      <motion.form
        variants={variants}
        onSubmit={(event) => void submit(event)}
        noValidate
        className="mt-8 flex flex-col gap-5"
      >
        <FormAlert message={message} />

        {/*
          Shown but not editable. The address is what the invitation was issued
          for, and letting it be changed here would turn a grant for one person
          into a grant for anyone holding the link.
        */}
        <TextField
          type="email"
          label={t.emailLabel}
          hint={t.emailHint}
          value={invitation.email}
          readOnly
          disabled
          onChange={() => undefined}
        />

        <div className="grid gap-5 sm:grid-cols-2">
          <TextField
            label={t.firstNameLabel}
            value={firstName}
            error={fields.firstName}
            autoComplete="given-name"
            autoFocus
            onChange={(event) => {
              setFirstName(event.target.value);
              setFields((current) => ({ ...current, firstName: undefined }));
            }}
          />

          <TextField
            label={t.lastNameLabel}
            value={lastName}
            error={fields.lastName}
            autoComplete="family-name"
            onChange={(event) => {
              setLastName(event.target.value);
              setFields((current) => ({ ...current, lastName: undefined }));
            }}
          />
        </div>

        <div>
          <TextField
            type="password"
            label={t.passwordLabel}
            placeholder={register.passwordPlaceholder}
            value={password}
            error={fields.password}
            autoComplete="new-password"
            revealLabels={{ show: common.showPassword, hide: common.hidePassword }}
            onChange={(event) => {
              setPassword(event.target.value);
              setFields((current) => ({ ...current, password: undefined }));
            }}
          />

          <PasswordMeter value={password} className="mt-3" labels={register.strength} />
        </div>

        <Button type="submit" loading={busy} className="w-full">
          {t.submit}
        </Button>
      </motion.form>
    </motion.div>
  );
}
