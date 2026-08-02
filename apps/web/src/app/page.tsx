import { redirect } from 'next/navigation';

/**
 * No marketing page exists yet, so the root sends people to the only entry
 * point that works. Replace this with the landing page when it is built —
 * shipping the create-next-app default would violate the design standard in
 * CLAUDE.md and is worse than a redirect.
 */
export default function Home() {
  redirect('/login');
}
