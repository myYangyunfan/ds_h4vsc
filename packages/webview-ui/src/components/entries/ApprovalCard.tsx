import { memo } from 'react';
import type { ApprovalRequest } from '@dsh-vscode/core';
import type { FromWebview } from '@dsh-vscode/core';
import { useT } from '../../strings.js';

const KIND_ORDER: Record<string, number> = {
  allow_once: 0,
  allow_always: 1,
  reject_once: 2,
  reject_always: 3,
};

interface ApprovalCardProps {
  approval: ApprovalRequest;
  send: (message: FromWebview) => void;
}

export const ApprovalCard = memo(function ApprovalCard({ approval, send }: ApprovalCardProps) {
  const t = useT();
  if (approval.state === 'resolved') {
    const chosen = approval.options.find((option) => option.optionId === approval.chosenOptionId);
    return (
      <div className="entry approval-card resolved">
        <i className="codicon codicon-shield" />
        <span>
          {approval.title} - <strong>{chosen?.label ?? t('cancelled')}</strong>
        </span>
      </div>
    );
  }

  const options = [...approval.options].sort(
    (a, b) => (KIND_ORDER[a.kind] ?? 9) - (KIND_ORDER[b.kind] ?? 9),
  );

  return (
    <div className="entry approval-card pending">
      <div className="approval-title">
        <i className="codicon codicon-shield" />
        <span>{approval.title}</span>
      </div>
      <div className="approval-actions">
        {options.map((option) => (
          <button
            key={option.optionId}
            className={`approval-button kind-${option.kind}`}
            onClick={() => send({ type: 'approve', approvalId: approval.approvalId, optionId: option.optionId })}
          >
            {option.label}
          </button>
        ))}
        <button
          className="link-button"
          onClick={() => send({ type: 'approve', approvalId: approval.approvalId, optionId: '' })}
        >
          {t('cancel')}
        </button>
      </div>
    </div>
  );
});
