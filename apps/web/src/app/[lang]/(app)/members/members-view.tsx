'use client';

import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useId, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Badge, type BadgeTone } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { EmptyState, FolderGlyph } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/select';
import { Skeleton, SkeletonRegion } from '@/components/ui/skeleton';
import { TabPanel, Tabs } from '@/components/ui/tabs';
import { TextField } from '@/components/ui/text-field';
import { useToast } from '@/components/ui/toast';
import type { Locale } from '@/i18n/config';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { relativeTime } from '@/lib/activity';
import { fetchProfile } from '@/lib/auth';
import { errorMessage } from '@/lib/error-message';
import {
  createInvitation,
  listInvitations,
  revokeInvitation,
  type Invitation,
  type InvitationStatus,
} from '@/lib/invitations';
import { respectMotion, riseItem, stagger } from '@/lib/motion';
import { listRoles, type Role } from '@/lib/roles';
import { listUsers, setUserRoles, type Member } from '@/lib/users';

type Load = 'loading' | 'ready' | 'error';
type Tab = 'members' | 'invitations';

const STATUS_TONES: Record<InvitationStatus, BadgeTone> = {
  PENDING: 'warning',
  ACCEPTED: 'success',
  REVOKED: 'neutral',
  EXPIRED: 'neutral',
};

/**
 * Who can reach this workspace, and what each of them may do.
 *
 * Two permissions govern this screen and they are deliberately not the same
 * one. `users.invite` lets an Admin bring people in; `roles.manage` — Owner
 * only — lets someone change what a colleague may do. A role that can rewrite
 * the permission model can grant itself anything, so Admin holds the first and
 * not the second, and the role picker is read-only for them rather than absent:
 * seeing who is an Owner is not the same as being able to appoint one.
 */
export function MembersView({
  lang,
  t,
  errors,
  common,
  confirm,
}: {
  lang: Locale;
  t: Dictionary['members'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  confirm: Dictionary['confirm'];
}) {
  const { status, withToken, user } = useSession();
  const toast = useToast();
  const reduced = useReducedMotion();
  const variants = respectMotion(riseItem, reduced);
  const tabsId = useId();

  /**
   * Read from the profile, not the session.
   *
   * The access token carries `{ sub, company_id, roles[], exp }` and no
   * permission list — permissions are resolved per request precisely so that
   * revoking a role bites sooner than the 15-minute token lifetime. `/auth/me`
   * is where the effective set lives, so it is fetched like any other data.
   */
  const [permissions, setPermissions] = useState<string[]>([]);
  const canInvite = permissions.includes('users.invite');
  const canManageRoles = permissions.includes('roles.manage');

  const [tab, setTab] = useState<Tab>('members');
  const [load, setLoad] = useState<Load>('loading');
  const [message, setMessage] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  /** The member whose role select is mid-flight, so only that row is disabled. */
  const [saving, setSaving] = useState<string | null>(null);

  const [inviting, setInviting] = useState(false);
  const [revoking, setRevoking] = useState<Invitation | null>(null);

  const [reloadKey, setReloadKey] = useState(0);
  const refresh = useCallback(() => setReloadKey((key) => key + 1), []);

  /**
   * Inline in the effect rather than a `useCallback` it calls, so every
   * setState provably follows an await — the pattern the rest of the app uses
   * and the one React's compiler lint requires.
   *
   * Roles and invitations settle independently of the member list: both sit
   * behind permissions a plain Member does not hold, and one 403 must not blank
   * the colleagues beside it.
   */
  useEffect(() => {
    if (status !== 'authenticated') return;

    let current = true;

    void (async () => {
      try {
        /**
         * The profile decides what this screen may offer, so it is awaited
         * first and its failure is the page's failure. The member list is what
         * the page is *for*, so it is awaited alongside.
         */
        const [profile, people] = await Promise.all([
          withToken(fetchProfile),
          withToken(listUsers),
        ]);

        if (!current) return;

        setPermissions(profile.permissions);
        setMembers(people.items);
        setLoad('ready');

        /**
         * Roles and invitations settle separately. Both sit behind permissions
         * a plain Member does not hold, and one 403 must not blank the
         * colleagues beside it — the same reasoning the dashboard uses.
         */
        const [roleList, inviteList] = await Promise.allSettled([
          profile.permissions.includes('roles.read') ? withToken(listRoles) : Promise.resolve(null),
          profile.permissions.includes('users.invite')
            ? withToken(listInvitations)
            : Promise.resolve(null),
        ]);

        if (!current) return;

        if (roleList.status === 'fulfilled' && roleList.value) setRoles(roleList.value.items);
        if (inviteList.status === 'fulfilled' && inviteList.value) {
          setInvitations(inviteList.value.items);
        }
      } catch (error) {
        if (!current) return;
        setMessage(errorMessage(error, errors, common.genericError));
        setLoad('error');
      }
    })();

    return () => {
      current = false;
    };
  }, [status, withToken, reloadKey, errors, common.genericError]);

  const changeRole = async (member: Member, roleId: string) => {
    setSaving(member.id);

    try {
      const updated = await withToken((token) => setUserRoles(token, member.id, [roleId]));
      setMembers((current) => current.map((row) => (row.id === updated.id ? updated : row)));

      toast.success(
        interpolate(t.roleChanged, {
          name: `${updated.firstName} ${updated.lastName}`,
          role: updated.roles.join(' · '),
        }),
      );
    } catch (error) {
      // The last-Owner refusal arrives here, already phrased by the API.
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setSaving(null);
    }
  };

  const confirmRevoke = async () => {
    if (!revoking) return;

    const target = revoking;
    setRevoking(null);

    try {
      const updated = await withToken((token) => revokeInvitation(token, target.id));
      setInvitations((current) => current.map((row) => (row.id === updated.id ? updated : row)));
      toast.success(t.invitations.revoked);
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    }
  };

  return (
    <motion.div
      variants={stagger}
      initial="hidden"
      animate="visible"
      className="flex flex-col gap-8"
    >
      <motion.header variants={variants} className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-text-subtle text-xs font-medium tracking-wide uppercase">{t.title}</p>
          <h1 className="font-display mt-1 text-3xl tracking-tight text-balance sm:text-4xl">
            {t.title}
          </h1>
          <p className="text-text-muted mt-2 max-w-2xl text-sm">{t.subtitle}</p>
        </div>

        {canInvite ? <Button onClick={() => setInviting(true)}>{t.invite.action}</Button> : null}
      </motion.header>

      {/* One tab when there is nothing to put behind the second. */}
      {canInvite ? (
        <motion.div variants={variants}>
          <Tabs
            idBase={tabsId}
            label={t.title}
            value={tab}
            onChange={setTab}
            items={[
              { value: 'members', label: t.tabs.members },
              { value: 'invitations', label: t.tabs.invitations },
            ]}
          />
        </motion.div>
      ) : null}

      <motion.section variants={variants}>
        {load === 'loading' ? (
          <SkeletonRegion label={t.loading} className="flex flex-col gap-3">
            {[0, 1, 2].map((index) => (
              <div
                key={index}
                className="border-border flex items-center gap-3 rounded-xl border p-4"
              >
                <Skeleton className="size-9 shrink-0 rounded-full" />
                <div className="flex-1">
                  <Skeleton className="h-3.5 w-40 max-w-full rounded" />
                  <Skeleton className="mt-2 h-3 w-56 max-w-full rounded" />
                </div>
                <Skeleton className="h-8 w-28 shrink-0 rounded-lg" />
              </div>
            ))}
          </SkeletonRegion>
        ) : load === 'error' ? (
          <div className="border-danger-border bg-danger-subtle rounded-xl border px-6 py-10 text-center">
            <h2 className="font-display text-lg">{t.error.title}</h2>
            <p className="text-text-muted mt-2 text-sm">{message}</p>
            <Button variant="secondary" className="mt-5" onClick={refresh}>
              {t.error.retry}
            </Button>
          </div>
        ) : tab === 'members' || !canInvite ? (
          <TabPanel idBase={tabsId} value="members" selected={canInvite ? tab : 'members'}>
            <ul className="flex flex-col gap-3">
              <AnimatePresence initial={false}>
                {members.map((member) => (
                  <MemberCard
                    key={member.id}
                    member={member}
                    roles={roles}
                    lang={lang}
                    t={t}
                    isSelf={member.id === user?.id}
                    canManageRoles={canManageRoles}
                    saving={saving === member.id}
                    onChangeRole={(roleId) => void changeRole(member, roleId)}
                  />
                ))}
              </AnimatePresence>
            </ul>

            <p className="text-text-subtle mt-4 text-xs">
              {members.length === 1
                ? t.countOne
                : interpolate(t.countMany, { count: String(members.length) })}
            </p>
          </TabPanel>
        ) : (
          <TabPanel idBase={tabsId} value="invitations" selected={tab}>
            {invitations.length === 0 ? (
              <EmptyState
                icon={<FolderGlyph />}
                title={t.invitations.empty.title}
                body={t.invitations.empty.body}
                action={<Button onClick={() => setInviting(true)}>{t.invite.action}</Button>}
              />
            ) : (
              <>
                <ul className="flex flex-col gap-3">
                  <AnimatePresence initial={false}>
                    {invitations.map((invitation) => (
                      <InvitationCard
                        key={invitation.id}
                        invitation={invitation}
                        lang={lang}
                        t={t}
                        onRevoke={() => setRevoking(invitation)}
                      />
                    ))}
                  </AnimatePresence>
                </ul>

                <p className="text-text-subtle mt-4 text-xs">
                  {invitations.length === 1
                    ? t.invitations.countOne
                    : interpolate(t.invitations.countMany, { count: String(invitations.length) })}
                </p>
              </>
            )}
          </TabPanel>
        )}
      </motion.section>

      <InviteDialog
        open={inviting}
        onClose={() => setInviting(false)}
        roles={roles}
        t={t}
        errors={errors}
        common={common}
        onCreated={(invitation) => setInvitations((current) => [invitation, ...current])}
      />

      <Dialog
        open={revoking !== null}
        onClose={() => setRevoking(null)}
        title={t.invitations.revokeTitle}
        description={
          revoking ? interpolate(t.invitations.revokeBody, { email: revoking.email }) : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRevoking(null)}>
              {confirm.cancel}
            </Button>
            <Button onClick={() => void confirmRevoke()}>{t.invitations.revokeSubmit}</Button>
          </>
        }
      />
    </motion.div>
  );
}

function MemberCard({
  member,
  roles,
  lang,
  t,
  isSelf,
  canManageRoles,
  saving,
  onChangeRole,
}: {
  member: Member;
  roles: Role[];
  lang: Locale;
  t: Dictionary['members'];
  isSelf: boolean;
  canManageRoles: boolean;
  saving: boolean;
  onChangeRole: (roleId: string) => void;
}) {
  const reduced = useReducedMotion();

  /**
   * The select is driven by the role's id, but a member carries role *names* —
   * matching by name is what ties the two together, and an unrecognised name
   * (a role renamed since) leaves the select unset rather than silently
   * showing the wrong one.
   */
  const current = roles.find((role) => member.roles.includes(role.name));

  const initials =
    `${member.firstName.trim().charAt(0)}${member.lastName.trim().charAt(0)}`.toUpperCase() || '?';

  return (
    <motion.li
      layout
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="border-border bg-surface flex flex-wrap items-center gap-x-3 gap-y-4 rounded-xl border p-4"
    >
      <span
        aria-hidden="true"
        className="bg-accent-subtle text-accent border-accent-border text-3xs flex size-9 shrink-0 items-center justify-center rounded-full border font-semibold"
      >
        {initials}
      </span>

      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">
            {member.firstName} {member.lastName}
          </span>

          {isSelf ? <Badge tone="neutral">{t.you}</Badge> : null}
          {!member.isActive ? <Badge tone="danger">{t.deactivated}</Badge> : null}
        </p>

        {/* Addresses are LTR even on an RTL page. */}
        <p dir="ltr" className="text-text-subtle mt-0.5 truncate text-xs rtl:text-end">
          {member.email}
        </p>
      </div>

      <time
        dateTime={member.createdAt}
        className="text-text-subtle shrink-0 text-xs"
        title={new Date(member.createdAt).toLocaleString(lang)}
      >
        {relativeTime(member.createdAt, lang)}
      </time>

      <div className="w-full sm:w-44">
        {canManageRoles && roles.length > 0 ? (
          <Select
            label={interpolate(t.changeRole, { name: `${member.firstName} ${member.lastName}` })}
            /* The label names the person, so it must not also be painted above
               every row — the visible column heading is the card itself. */
            className="h-9"
            value={current?.id ?? ''}
            disabled={saving}
            aria-busy={saving}
            onChange={(event) => onChangeRole(event.target.value)}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>
        ) : (
          <p className="text-text-muted text-sm sm:text-end">{member.roles.join(' · ')}</p>
        )}
      </div>
    </motion.li>
  );
}

function InvitationCard({
  invitation,
  lang,
  t,
  onRevoke,
}: {
  invitation: Invitation;
  lang: Locale;
  t: Dictionary['members'];
  onRevoke: () => void;
}) {
  const reduced = useReducedMotion();

  return (
    <motion.li
      layout
      initial={reduced ? { opacity: 0 } : { opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className="border-border bg-surface rounded-xl border p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span dir="ltr" className="truncate text-sm font-medium rtl:text-end">
          {invitation.email}
        </span>

        <Badge tone={STATUS_TONES[invitation.status]} dot>
          {t.invitations.status[invitation.status]}
        </Badge>

        <span className="text-text-muted ms-auto text-xs">{invitation.role.name}</span>
      </div>

      <p className="text-text-subtle mt-2 text-xs">
        {invitation.invitedBy
          ? `${t.invitations.columns.invitedBy}: ${invitation.invitedBy}`
          : null}
        {invitation.status === 'PENDING' ? (
          <>
            {invitation.invitedBy ? ' · ' : null}
            {interpolate(t.invitations.expires, {
              when: relativeTime(invitation.expiresAt, lang),
            })}
          </>
        ) : null}
      </p>

      {invitation.status === 'PENDING' ? (
        <div className="mt-4">
          <Button size="sm" variant="ghost" onClick={onRevoke}>
            {t.invitations.revoke}
          </Button>
        </div>
      ) : null}
    </motion.li>
  );
}

/**
 * Creating an invitation and handing over the link are one flow, not two.
 *
 * The dialog stays open after a successful create and swaps to showing the
 * link, because there is no mailer — closing on success would discard the only
 * copy of a credential the inviter now has to deliver themselves.
 */
function InviteDialog({
  open,
  onClose,
  roles,
  t,
  errors,
  common,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  roles: Role[];
  t: Dictionary['members'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
  onCreated: (invitation: Invitation) => void;
}) {
  const { withToken } = useSession();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [roleId, setRoleId] = useState('');
  const [fieldError, setFieldError] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  /**
   * Defaults to the least-privileged role rather than the first in the list.
   * The list is ordered most-privileged first, so a blank default would put
   * Owner under the cursor of anyone who submits without looking.
   */
  const fallbackRole = roles.length > 0 ? roles[roles.length - 1].id : '';

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();

    const address = email.trim();

    if (!address) {
      setFieldError(t.invite.emailLabel);
      return;
    }

    setBusy(true);

    try {
      const result = await withToken((token) =>
        createInvitation(token, { email: address, roleId: roleId || fallbackRole }),
      );

      onCreated(result.invitation);
      setLink(result.link);
      toast.success(interpolate(t.invite.created, { email: address }));
    } catch (error) {
      setFieldError(errorMessage(error, errors, common.genericError));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setEmail('');
    setRoleId('');
    setFieldError(undefined);
    setLink(null);
    setCopied(false);
    onClose();
  };

  const copy = async () => {
    if (!link) return;

    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
    } catch {
      // Clipboard access can be refused outright (insecure origin, denied
      // permission). The link is on screen and selectable either way, so this
      // is a missing convenience rather than a failure worth a toast.
    }
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title={link ? t.invite.linkTitle : t.invite.title}
      description={
        link ? interpolate(t.invite.linkBody, { email: email.trim() }) : t.invite.description
      }
      footer={
        link ? (
          <>
            <Button variant="secondary" onClick={() => void copy()}>
              {copied ? t.invite.copied : t.invite.copy}
            </Button>
            <Button onClick={close}>{t.invite.done}</Button>
          </>
        ) : undefined
      }
    >
      {link ? (
        /* Selectable and wrapped rather than truncated: if the clipboard is
           unavailable, reading it off the screen has to remain possible. */
        <p
          dir="ltr"
          className="border-border bg-surface-inset text-text font-mono text-xs wrap-anywhere rounded-lg border p-3"
        >
          {link}
        </p>
      ) : (
        <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-4">
          <TextField
            type="email"
            label={t.invite.emailLabel}
            placeholder={t.invite.emailPlaceholder}
            value={email}
            error={fieldError}
            autoFocus
            onChange={(event) => {
              setEmail(event.target.value);
              setFieldError(undefined);
            }}
          />

          <Select
            label={t.invite.roleLabel}
            value={roleId || fallbackRole}
            onChange={(event) => setRoleId(event.target.value)}
          >
            {roles.map((role) => (
              <option key={role.id} value={role.id}>
                {role.name}
              </option>
            ))}
          </Select>

          <div className="mt-2 flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={close}>
              {t.invite.cancel}
            </Button>
            <Button type="submit" loading={busy}>
              {t.invite.submit}
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
