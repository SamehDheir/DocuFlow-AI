import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { App } from 'supertest/types';
import type { SessionUser } from '../src/auth/auth.types';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp } from './create-test-app';

/**
 * Comments, end to end.
 *
 * Needs the local stack running — Postgres AND MinIO:
 *
 *   npm run infra:up
 *
 * The cases worth having here rather than in the unit spec are the ones the
 * fakes cannot reach: the real PermissionsGuard deciding what a Member may do,
 * the real tenant guard refusing a bare comment id from another company, and the
 * interaction with archive — which is the one document state that deliberately
 * stays open to comment.
 */

interface Session {
  accessToken: string;
  user: SessionUser;
}

interface CommentBody {
  id: string;
  documentId: string;
  body: string;
  editedAt: string | null;
  author: { id: string; firstName: string; lastName: string };
}

interface ThreadBody {
  items: CommentBody[];
  nextCursor: string | null;
  total: number;
}

interface DocumentBody {
  id: string;
  name: string;
  status: string;
}

type Auth = (req: request.Test) => request.Test;

function accountFor(label: string) {
  const suffix = randomUUID().slice(0, 8);

  return {
    companyName: `Comments ${label} ${suffix}`,
    firstName: 'Test',
    lastName: label,
    email: `${label}.${suffix}@example.test`,
    password: 'correct-horse-battery-staple',
  };
}

describe('Comments (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let server: App;

  const createdCompanies: string[] = [];

  async function tenant(label: string) {
    const response = await request(server)
      .post('/api/auth/register')
      .send(accountFor(label))
      .expect(201);

    const session = response.body as Session;
    createdCompanies.push(session.user.companyId);

    const auth: Auth = (req) => req.set('Authorization', `Bearer ${session.accessToken}`);

    return { session, auth };
  }

  /**
   * A second account in the same company, holding the Member role.
   *
   * Registration always creates a NEW company and makes the registrant Owner,
   * so an invitation is the only way to produce a colleague who is not one —
   * and a Member is exactly who `comments.moderate` is withheld from.
   */
  async function memberOf(owner: Auth) {
    const roles = (await owner(request(server).get('/api/roles')).expect(200)).body as {
      items: { id: string; name: string }[];
    };
    const member = roles.items.find((role) => role.name === 'Member');

    const invited = (
      await owner(request(server).post('/api/invitations'))
        .send({ email: `member.${randomUUID().slice(0, 8)}@example.test`, roleId: member?.id })
        .expect(201)
    ).body as { link: string };

    const token = new URL(invited.link).searchParams.get('token');

    const session = (
      await request(server)
        .post('/api/auth/accept-invitation')
        .send({
          token,
          firstName: 'Mem',
          lastName: 'Ber',
          password: 'correct-horse-battery-staple',
        })
        .expect(201)
    ).body as Session;

    const auth: Auth = (req) => req.set('Authorization', `Bearer ${session.accessToken}`);

    return { session, auth };
  }

  async function uploadReady(auth: Auth): Promise<DocumentBody> {
    const uploaded = (
      await auth(request(server).post('/api/documents'))
        .attach('file', Buffer.from('contents'), {
          filename: 'doc.txt',
          contentType: 'text/plain',
        })
        .expect(201)
    ).body as DocumentBody;

    // The e2e suite runs producer-only, so nothing would otherwise move this
    // past PROCESSING.
    await prisma.document.update({ where: { id: uploaded.id }, data: { status: 'READY' } });

    return uploaded;
  }

  beforeAll(async () => {
    app = await createTestApp();
    server = app.getHttpServer();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    const scope = { companyId: { in: createdCompanies } };

    // Comments cascade from their document, so nothing extra is needed here —
    // but documents must go before folders, and both before the company, since
    // owner/creator edges to User are Restrict.
    await prisma.document.deleteMany({ where: scope });
    await prisma.folder.deleteMany({ where: scope });
    await prisma.company.deleteMany({ where: { id: { in: createdCompanies } } });

    await app.close();
  });

  describe('a thread', () => {
    it('posts, reads oldest-first, edits, and deletes', async () => {
      const { auth } = await tenant('thread');
      const document = await uploadReady(auth);

      const first = (
        await auth(request(server).post(`/api/documents/${document.id}/comments`))
          .send({ body: 'Clause 4 needs legal to look at it.' })
          .expect(201)
      ).body as CommentBody;

      await auth(request(server).post(`/api/documents/${document.id}/comments`))
        .send({ body: 'Agreed — raising it with them today.' })
        .expect(201);

      const thread = (
        await auth(request(server).get(`/api/documents/${document.id}/comments`)).expect(200)
      ).body as ThreadBody;

      expect(thread.total).toBe(2);
      expect(thread.items[0].id).toBe(first.id);
      expect(thread.items[0].author.id).toBeDefined();
      expect(thread.items[0].editedAt).toBeNull();

      const edited = (
        await auth(request(server).patch(`/api/comments/${first.id}`))
          .send({ body: 'Clause 4 needs legal to sign it off.' })
          .expect(200)
      ).body as CommentBody;

      expect(edited.editedAt).not.toBeNull();

      await auth(request(server).delete(`/api/comments/${first.id}`)).expect(200);

      const after = (
        await auth(request(server).get(`/api/documents/${document.id}/comments`)).expect(200)
      ).body as ThreadBody;

      expect(after.total).toBe(1);
      expect(after.items.map((item) => item.id)).not.toContain(first.id);

      /**
       * Soft, not hard. "Who deleted what" is a problem this product exists to
       * answer, and that includes what was said — so the row and its text
       * survive out of the thread's sight.
       */
      const row = await prisma.comment.findUnique({ where: { id: first.id } });
      expect(row?.deletedAt).not.toBeNull();
      expect(row?.body).toBe('Clause 4 needs legal to sign it off.');

      // A tombstone is not editable, and not re-deletable.
      await auth(request(server).patch(`/api/comments/${first.id}`))
        .send({ body: 'back from the dead' })
        .expect(404);
      await auth(request(server).delete(`/api/comments/${first.id}`)).expect(404);
    });

    it('rejects an empty or whitespace-only body', async () => {
      const { auth } = await tenant('empty');
      const document = await uploadReady(auth);

      await auth(request(server).post(`/api/documents/${document.id}/comments`))
        .send({ body: '   ' })
        .expect(400);
    });

    it('404s a document in the trash, and one that never existed', async () => {
      const { auth } = await tenant('gone');
      const document = await uploadReady(auth);

      await auth(request(server).delete(`/api/documents/${document.id}`)).expect(200);

      await auth(request(server).get(`/api/documents/${document.id}/comments`)).expect(404);
      await auth(request(server).post(`/api/documents/${document.id}/comments`))
        .send({ body: 'anyone there?' })
        .expect(404);
      await auth(request(server).get(`/api/documents/${randomUUID()}/comments`)).expect(404);
    });

    /**
     * The archive case, which is the point of the distinction DocumentsService
     * draws: `assertWritable` refuses renames, moves and new versions on an
     * archived document but deliberately not comments. Freezing a record is not
     * the same as sealing it away.
     */
    it('still accepts comments on an archived document', async () => {
      const { auth } = await tenant('archived');
      const document = await uploadReady(auth);

      await auth(request(server).post(`/api/documents/${document.id}/archive`)).expect(201);

      // Renaming is refused...
      await auth(request(server).patch(`/api/documents/${document.id}`))
        .send({ name: 'renamed.txt' })
        .expect(409);

      // ...but the conversation is not.
      await auth(request(server).post(`/api/documents/${document.id}/comments`))
        .send({ body: 'Archived, but this is why.' })
        .expect(201);
    });
  });

  describe('who may touch what', () => {
    it('lets a Member comment, but only edit their own', async () => {
      const { auth: owner } = await tenant('edit');
      const { auth: member } = await memberOf(owner);
      const document = await uploadReady(owner);

      const theirs = (
        await member(request(server).post(`/api/documents/${document.id}/comments`))
          .send({ body: 'From the member.' })
          .expect(201)
      ).body as CommentBody;

      const ours = (
        await owner(request(server).post(`/api/documents/${document.id}/comments`))
          .send({ body: 'From the owner.' })
          .expect(201)
      ).body as CommentBody;

      await member(request(server).patch(`/api/comments/${theirs.id}`))
        .send({ body: 'From the member, revised.' })
        .expect(200);

      // Not their comment — and no permission grants this, which is why it has
      // a code of its own rather than PERMISSION_DENIED.
      const refused = await member(request(server).patch(`/api/comments/${ours.id}`))
        .send({ body: 'hijacked' })
        .expect(403);
      expect((refused.body as { code: string }).code).toBe('COMMENT_NOT_AUTHOR');

      /**
       * An Owner holds `comments.moderate` and still cannot edit. That
       * permission is "delete anyone's comment"; putting different words in
       * someone's mouth is not moderation.
       */
      await owner(request(server).patch(`/api/comments/${theirs.id}`))
        .send({ body: 'rewritten by the boss' })
        .expect(403);
    });

    it('lets an Owner moderate a Member and not the other way round', async () => {
      const { auth: owner } = await tenant('moderate');
      const { auth: member } = await memberOf(owner);
      const document = await uploadReady(owner);

      const theirs = (
        await member(request(server).post(`/api/documents/${document.id}/comments`))
          .send({ body: 'Out of line.' })
          .expect(201)
      ).body as CommentBody;

      const ours = (
        await owner(request(server).post(`/api/documents/${document.id}/comments`))
          .send({ body: 'Perfectly in line.' })
          .expect(201)
      ).body as CommentBody;

      // No comments.moderate: a Member may delete their own and nothing else.
      const refused = await member(request(server).delete(`/api/comments/${ours.id}`)).expect(403);
      expect((refused.body as { code: string }).code).toBe('PERMISSION_DENIED');

      await owner(request(server).delete(`/api/comments/${theirs.id}`)).expect(200);

      // The audit trail distinguishes the two, which is the whole reason the
      // flag is recorded rather than inferred from the action name.
      const entries = (
        await owner(request(server).get('/api/audit?action=comment.delete')).expect(200)
      ).body as { items: { action: string; metadata: { moderated?: boolean } }[] };

      expect(entries.items[0].metadata.moderated).toBe(true);
    });

    it('notifies the document owner, and never the person who commented', async () => {
      const { auth: owner, session } = await tenant('notify');
      const { auth: member } = await memberOf(owner);
      const document = await uploadReady(owner);

      await member(request(server).post(`/api/documents/${document.id}/comments`))
        .send({ body: 'A word about this.' })
        .expect(201);

      const inbox = (await owner(request(server).get('/api/notifications')).expect(200)).body as {
        items: { type: string; entityId: string; payload: { name: string } }[];
      };

      const notification = inbox.items.find((item) => item.type === 'DOCUMENT_COMMENTED');
      expect(notification?.entityId).toBe(document.id);

      // The commenter hears nothing about their own remark.
      const theirs = (await member(request(server).get('/api/notifications')).expect(200)).body as {
        items: { type: string }[];
      };
      expect(theirs.items.filter((item) => item.type === 'DOCUMENT_COMMENTED')).toEqual([]);

      // And the owner is not told about their own, either.
      await owner(request(server).post(`/api/documents/${document.id}/comments`))
        .send({ body: 'Noted, thanks.' })
        .expect(201);

      const again = (await owner(request(server).get('/api/notifications')).expect(200)).body as {
        items: { type: string; actor: { id: string } | null }[];
      };
      expect(
        again.items.filter(
          (item) => item.type === 'DOCUMENT_COMMENTED' && item.actor?.id === session.user.id,
        ),
      ).toEqual([]);
    });
  });

  describe('tenant isolation', () => {
    /**
     * The reason Comment carries its own companyId instead of reaching the
     * tenant through its document: PATCH and DELETE route on a bare comment id,
     * so the guard has to filter before execution rather than after.
     */
    it('refuses another company a comment id and a thread', async () => {
      const alice = await tenant('alice');
      const bob = await tenant('bob');

      const document = await uploadReady(alice.auth);
      const comment = (
        await alice
          .auth(request(server).post(`/api/documents/${document.id}/comments`))
          .send({ body: 'Internal to Alice Ltd.' })
          .expect(201)
      ).body as CommentBody;

      await bob.auth(request(server).get(`/api/documents/${document.id}/comments`)).expect(404);
      await bob
        .auth(request(server).post(`/api/documents/${document.id}/comments`))
        .send({ body: 'hello' })
        .expect(404);
      await bob
        .auth(request(server).patch(`/api/comments/${comment.id}`))
        .send({ body: 'rewritten' })
        .expect(404);
      await bob.auth(request(server).delete(`/api/comments/${comment.id}`)).expect(404);

      // Untouched.
      const row = await prisma.comment.findUnique({ where: { id: comment.id } });
      expect(row?.body).toBe('Internal to Alice Ltd.');
      expect(row?.deletedAt).toBeNull();
    });
  });
});
