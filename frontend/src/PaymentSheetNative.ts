/**
 * PaymentSheetNative — native (iOS/Android) Stripe PaymentSheet entry
 * point. Uses the official `@stripe/stripe-react-native` SDK so the
 * card field is a Stripe-controlled native component (we never see
 * the raw PAN — PCI-DSS compliant).
 *
 * On web the matching `.web.ts` stub returns `{ unsupported: true }`
 * so the BuyAppModal can fall back to the hosted Checkout flow.
 */
import {
  initStripe,
  initPaymentSheet,
  presentPaymentSheet,
} from '@stripe/stripe-react-native';

let stripeInited = false;

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
  params: PaymentSheetParams,
): Promise<PaymentSheetResult> {
  try {
    if (!stripeInited) {
      await initStripe({
        publishableKey: params.publishableKey,
        merchantIdentifier: 'merchant.com.xpconfidence.app', // iOS Apple Pay prefix
      });
      stripeInited = true;
    }
    const { error: initError } = await initPaymentSheet({
      merchantDisplayName: params.merchantDisplayName || 'XP in Real Life',
      customerId: params.customerId,
      customerEphemeralKeySecret: params.customerEphemeralKeySecret,
      paymentIntentClientSecret: params.paymentIntentClientSecret,
      // Reasonable defaults — Apple/Google Pay supported, dark theme
      // matches the app's neon-green/cyan brand.
      defaultBillingDetails: { address: { country: 'US' } },
      allowsDelayedPaymentMethods: false,
      appearance: {
        colors: {
          primary: '#33ff95',
          background: '#11121a',
          componentBackground: '#0a0a0f',
          componentBorder: '#33ff9555',
          componentDivider: '#222',
          primaryText: '#eaeaea',
          secondaryText: '#aaa',
          componentText: '#eaeaea',
          placeholderText: '#666',
          icon: '#33ff95',
          error: '#ff7777',
        },
        shapes: { borderRadius: 14, borderWidth: 1 },
        primaryButton: {
          colors: { background: '#33ff95', text: '#0a0a0f', border: '#33ff95' },
          shapes: { borderRadius: 999, borderWidth: 0 },
        },
      },
    });
    if (initError) {
      return { ok: false, error: initError.message };
    }
    const { error: payError } = await presentPaymentSheet();
    if (payError) {
      // Stripe returns code: "Canceled" when the user closes the sheet.
      const canceled = (payError as any).code === 'Canceled';
      return { ok: false, canceled, error: canceled ? 'Cancelled' : payError.message };
    }
    return { ok: true };
  } catch (e: any) {
    return { ok: false, error: String(e?.message || e) };
  }
}
