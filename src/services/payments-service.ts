import { apiClient } from './api-client';

// Razorpay Standard Checkout client. The secret never appears here:
// the browser only ever sees the public key_id, which the server
// returns together with the order (so no VITE_ build-time variable is
// needed and rotating keys needs no frontend change). Amounts are
// never sent from here either — create-order prices from the stored
// event on the server.

export interface RazorpayOrder {
  order_id: string;
  amount: number;
  currency: string;
  key_id: string;
  // True when this order was already paid but verify never completed
  // (browser closed, network drop). The caller should then verify
  // immediately instead of opening the checkout for a paid order.
  alreadyPaid?: boolean;
}

export interface RazorpayVerifyResult {
  success: boolean;
  ticketCode?: string;
  alreadyConfirmed?: boolean;
}

export interface RazorpayCheckoutResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayCheckoutOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description: string;
  order_id: string;
  prefill?: { name?: string; email?: string; contact?: string };
  theme?: { color?: string };
  handler: (response: RazorpayCheckoutResponse) => void;
  modal?: { ondismiss?: () => void };
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayCheckoutOptions) => {
      open: () => void;
      on: (event: string, handler: (response: unknown) => void) => void;
    };
  }
}

const CHECKOUT_SCRIPT_URL = 'https://checkout.razorpay.com/v1/checkout.js';
let scriptPromise: Promise<void> | null = null;

export function loadRazorpayScript(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Razorpay checkout needs a browser.'));
  }
  if (window.Razorpay) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = CHECKOUT_SCRIPT_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      scriptPromise = null;
      reject(new Error('Failed to load Razorpay checkout. Check your connection and try again.'));
    };
    document.body.appendChild(script);
  });
  return scriptPromise;
}

export const paymentsService = {
  async createOrder(registrationId: string): Promise<RazorpayOrder> {
    return apiClient.post<RazorpayOrder>('/create-order', { registrationId });
  },

  async verifyPayment(input: {
    registrationId: string;
    razorpay_order_id: string;
    razorpay_payment_id?: string;
    razorpay_signature?: string;
  }): Promise<RazorpayVerifyResult> {
    return apiClient.post<RazorpayVerifyResult>('/verify-payment', input);
  },

  // Opens the Razorpay modal. The checkout success handler alone
  // proves nothing — the caller must pass its response to
  // verifyPayment, and only the server's verified result issues a
  // pass. Dismiss (user closes the modal) and payment failure are
  // delivered through callbacks; neither marks anything paid, and the
  // pending registration simply stays pending for a retry.
  async openCheckout(input: {
    order: RazorpayOrder;
    eventTitle: string;
    attendeeName?: string;
    attendeeEmail?: string;
    attendeePhone?: string;
    onSuccess: (response: RazorpayCheckoutResponse) => void;
    onDismiss: () => void;
    onError: (message: string) => void;
  }): Promise<void> {
    await loadRazorpayScript();
    if (!window.Razorpay) {
      throw new Error('Razorpay checkout is unavailable right now. Please try again.');
    }
    const checkout = new window.Razorpay({
      key: input.order.key_id,
      amount: input.order.amount,
      currency: input.order.currency,
      name: 'Locora',
      description: input.eventTitle,
      order_id: input.order.order_id,
      prefill: {
        name: input.attendeeName || undefined,
        email: input.attendeeEmail || undefined,
        contact: input.attendeePhone || undefined,
      },
      theme: { color: '#1E3F35' },
      handler: (response: RazorpayCheckoutResponse) => input.onSuccess(response),
      modal: {
        ondismiss: () => input.onDismiss(),
      },
    });
    checkout.on('payment.failed', (response: unknown) => {
      const message =
        (response as { error?: { description?: string } })?.error?.description ||
        'Payment failed. No pass was issued. Please try again.';
      input.onError(message);
    });
    checkout.open();
  },
};
