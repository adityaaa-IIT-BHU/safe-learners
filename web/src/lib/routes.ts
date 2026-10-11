import type { Role } from '@shared/domain';

export function homePath(role: Role | undefined): string {
  return role === 'instructor' ? '/instructor' : role === 'admin' ? '/admin' : '/learner';
}
