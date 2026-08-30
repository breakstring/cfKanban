export interface InvitationFailureShape {
  code?: string;
  status: number;
}

export function invitationOutcomeRequiresReview(failure: InvitationFailureShape | null): boolean {
  if (failure === null) return true;
  return failure.code === "IDEMPOTENCY_RECOVERY_WINDOW_EXPIRED"
    || failure.status === 0
    || failure.status >= 500;
}

export function canConfirmInvitationReview(readbackReady: boolean, hasMore: boolean): boolean {
  return readbackReady && !hasMore;
}
