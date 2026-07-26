'use client';

import { useActionState } from 'react';
import { setStaffActive } from '@/lib/auth/actions';
import { cn } from '@/lib/utils';
import type { ActionResult } from '@/lib/auth/validation';
import type { StaffMember } from './types';

const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  pharmacist: 'Pharmacist',
  cashier: 'Cashier',
};

export function StaffRow({
  member,
  slug,
  canManage,
  isSelf,
}: {
  member: StaffMember;
  slug: string;
  canManage: boolean;
  isSelf: boolean;
}) {
  const [state, formAction] = useActionState<ActionResult, FormData>(
    setStaffActive,
    {},
  );

  return (
    <tr className="border-border border-t">
      <td className="px-4 py-2">
        {member.email}
        {isSelf && <span className="text-muted-foreground"> (you)</span>}
      </td>
      <td className="px-4 py-2">{ROLE_LABEL[member.role] ?? member.role}</td>
      <td className="px-4 py-2">
        <span
          className={cn(
            'rounded-full px-2 py-0.5 text-xs',
            member.isActive
              ? 'bg-primary/10 text-primary'
              : 'bg-muted text-muted-foreground',
          )}
        >
          {member.isActive ? 'Active' : 'Deactivated'}
        </span>
        {state.error && (
          <span className="text-danger ml-2 text-xs">{state.error}</span>
        )}
      </td>
      {canManage && (
        <td className="px-4 py-2 text-right">
          {/* An owner cannot lock themselves out; the server enforces this too. */}
          {!isSelf && (
            <form action={formAction}>
              <input type="hidden" name="slug" value={slug} />
              <input type="hidden" name="userId" value={member.userId} />
              <input
                type="hidden"
                name="isActive"
                value={member.isActive ? 'false' : 'true'}
              />
              <button
                type="submit"
                className={cn(
                  'text-xs underline',
                  member.isActive ? 'text-danger' : 'text-primary',
                )}
              >
                {member.isActive ? 'Deactivate' : 'Reactivate'}
              </button>
            </form>
          )}
        </td>
      )}
    </tr>
  );
}
