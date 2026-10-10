import { randomUUID } from 'node:crypto';

export type Approval = {
  id: string;
  kind: 'hire' | 'tool';
  agentId: string;
  title: string;
  detail: string;
  // For hires: the proposed agent, so the UI can preview the character.
  data?: Record<string, unknown>;
  toolName?: string;
  createdAt: number;
};

export type Decision = { approved: boolean; always?: boolean; note?: string };

type Pending = { approval: Approval; resolve: (d: Decision) => void };

const pending = new Map<string, Pending>();
let onChange: (event: { type: 'approval'; approval: Approval } | { type: 'approval_resolved'; id: string }) => void =
  () => {};

export function onApprovalChange(fn: typeof onChange) {
  onChange = fn;
}

export const pendingApprovals = () => [...pending.values()].map((p) => p.approval);

export function requestApproval(a: Omit<Approval, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<Decision> {
  const approval: Approval = { ...a, id: randomUUID(), createdAt: Date.now() };
  return new Promise((resolve) => {
    const finish = (d: Decision) => {
      if (!pending.delete(approval.id)) return;
      onChange({ type: 'approval_resolved', id: approval.id });
      resolve(d);
    };
    pending.set(approval.id, { approval, resolve: finish });
    signal?.addEventListener('abort', () => finish({ approved: false, note: 'Cancelled.' }), { once: true });
    onChange({ type: 'approval', approval });
  });
}

export function decide(id: string, d: Decision) {
  pending.get(id)?.resolve(d);
}
