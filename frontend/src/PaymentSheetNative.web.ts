/**
 * PaymentSheetNative.web — web stub. Returns `unsupported:true` so the
 * BuyAppModal falls back to the existing hosted Stripe Checkout flow
 * (browser tab) on web preview. The actual native PaymentSheet only
 * runs in a real iOS/Android build (after `expo prebuild` + EAS).
 */
export type PaymentSheetParams = {
  publishableKey: string;
  paymentIntentClientSecret: string;
  customerId: string;
  customerEphemeralKeySecret: string;
  merchantDisplayName?: string;
};

export type PaymentSheetResult =
  | { ok: true; unsupported?: false }
  | { ok: false; canceled?: boolean; error?: string; unsupported?: false }
  | { unsupported: true };

export async function presentNativePaymentSheet(
  _params: PaymentSheetParams,
): Promise<PaymentSheetResult> {
  return { unsupported: true };
}
