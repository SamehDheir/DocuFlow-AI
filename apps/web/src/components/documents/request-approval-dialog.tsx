'use client';

import { useEffect, useState } from 'react';
import { useSession } from '@/components/auth/session-provider';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/components/ui/toast';
import type { Dictionary } from '@/i18n/get-dictionary';
import { interpolate } from '@/i18n/interpolate';
import { requestApproval } from '@/lib/approvals';
import type { DocumentSummary } from '@/lib/documents';
import { errorMessage } from '@/lib/error-message';
import { listUsers, type Member } from '@/lib/users';

/**
 * Routes a document for sign-off.
 *
 * The assignee list is optional by design: leaving it unset sends the request
 * to everyone holding `documents.approve`, so a two-person company never has to
 * decide on a routing policy to use the feature.
 */
export function RequestApprovalDialog({
  item,
  onClose,
  t,
  errors,
  common,
}: {
  item: DocumentSummary | null;
  onClose: () => void;
  t: Dictionary['approvals'];
  errors: Dictionary['errors'];
  common: Dictionary['common'];
}) {
  const { withToken, user } = useSession();
  const toast = useToast();

  const [members, setMembers] = useState<Member[]>([]);
  const [assigneeId, setAssigneeId] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  /**
   * No field resets here. The parent gives this component a `key` per document,
   * so opening a different one mounts a fresh instance with empty fields —
   * the same approach DocumentPreview uses, and it keeps this effect free of
   * the synchronous setState that triggers cascading renders.
   */
  useEffect(() => {
    if (!item) {
      return;
    }

    void (async () => {
      try {
        const list = await withToken(listUsers);
        setMembers(list.items);
      } catch {
        // A failed member list is not fatal: the request can still be sent
        // unassigned, which is the default anyway.
      }
    })();
  }, [item, withToken]);

  const submit = async () => {
    if (!item) {
      return;
    }

    setBusy(true);

    try {
      await withToken((token) =>
        requestApproval(token, item.id, {
          assigneeId: assigneeId || undefined,
          note: note || undefined,
        }),
      );

      toast.success(interpolate(t.requested, { name: item.name }));
      onClose();
    } catch (error) {
      toast.error(errorMessage(error, errors, common.genericError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={item !== null}
      onClose={onClose}
      title={item ? interpolate(t.requestTitle, { name: item.name }) : ''}
      description={t.requestDescription}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t.cancel}
          </Button>
          <Button loading={busy} onClick={() => void submit()}>
            {t.submit}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Select
          label={t.assigneeLabel}
          value={assigneeId}
          onChange={(event) => setAssigneeId(event.target.value)}
        >
          <option value="">{t.anyApprover}</option>
          {members
            // Assigning to yourself is pointless: the API refuses a
            // self-decision, so the request would be unresolvable by its own
            // assignee.
            .filter((member) => member.id !== user?.id)
            .map((member) => (
              <option key={member.id} value={member.id}>
                {member.firstName} {member.lastName}
              </option>
            ))}
        </Select>

        <Textarea
          label={t.noteLabel}
          placeholder={t.notePlaceholder}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </div>
    </Dialog>
  );
}
