// Payment gateway adapter. SafeLearners has no gateway yet: refunds are paid by manual bank transfer and
// confirmed by an admin. A future provider implements PaymentGateway and plugs into the same refund
// states and finance ledger; invoices, wallet credit, allocations and reconciliation don't change.

export interface GatewayRefundResult {
  /** 'completed' only when the provider confirms the money has gone. */
  status: 'awaiting_transfer' | 'processing' | 'completed' | 'failed';
  gatewayReference?: string;
  error?: string;
}

export interface PaymentGateway {
  id: string;
  /** Shown in refund history. */
  label: string;
  /** Refund status straight after an admin approves. */
  afterApproval(): 'awaiting_transfer' | 'processing';
  // Later, for a real provider (deliberately not implemented in this phase):
  // createCheckout(customerId, amount, idempotencyKey): Promise<{ url: string }>;
  // confirmPayment(event): Promise<{ paymentId: string; amount: number; status: 'succeeded' | 'failed' | 'pending' }>;
  // refund(paymentId, amount, idempotencyKey): Promise<GatewayRefundResult>;
  // handleWebhook(rawBody, signature): Promise<void>;
  // payouts(since): Promise<{ id: string; amount: number; fees: number; arrivalDate: string }[]>;
}

/** No provider: an admin pays the refund by bank transfer, then records the transfer reference. */
export const manualTransfer: PaymentGateway = {
  id: 'manual_transfer',
  label: 'Refund by manual bank transfer, then confirmed by an admin',
  afterApproval: () => 'awaiting_transfer',
};

export function refundGateway(): PaymentGateway {
  return manualTransfer;
}
