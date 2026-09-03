import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Env } from '../../infra/config/env.schema.js';

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  status: string;
  receipt?: string;
}

export interface RazorpayPayment {
  id: string;
  order_id: string;
  amount: number;
  status: string; // created | authorized | captured | refunded | failed
  method?: string;
  error_description?: string;
}

export interface RazorpayRefund {
  id: string;
  payment_id: string;
  amount: number;
  status: string; // pending | processed | failed
}

const API_BASE = 'https://api.razorpay.com/v1';
const TIMEOUT_MS = 10_000;

/**
 * Thin client over Razorpay's REST API rather than the official SDK.
 *
 * We must verify webhook signatures with node:crypto ourselves regardless, and
 * the three calls we need are small — so this avoids a CJS dependency in an ESM
 * project and, more usefully, makes the client trivial to substitute in tests
 * without network access.
 */
@Injectable()
export class RazorpayClient {
  private readonly logger = new Logger(RazorpayClient.name);

  constructor(private readonly config: ConfigService<Env, true>) {}

  private credentials(): { keyId: string; keySecret: string } {
    const keyId = this.config.get('RAZORPAY_KEY_ID', { infer: true });
    const keySecret = this.config.get('RAZORPAY_KEY_SECRET', { infer: true });

    if (!keyId || !keySecret) {
      throw new ServiceUnavailableException({
        code: 'PAYMENTS_NOT_CONFIGURED',
        message: 'Payments are temporarily unavailable.',
      });
    }
    return { keyId, keySecret };
  }

  async createOrder(params: {
    amountPaise: number;
    receipt: string;
    notes?: Record<string, string>;
  }): Promise<RazorpayOrder> {
    return this.request<RazorpayOrder>('POST', '/orders', {
      amount: params.amountPaise,
      currency: 'INR',
      receipt: params.receipt,
      notes: params.notes,
    });
  }

  fetchPayment(paymentId: string): Promise<RazorpayPayment> {
    return this.request<RazorpayPayment>('GET', `/payments/${paymentId}`);
  }

  async refund(paymentId: string, amountPaise: number): Promise<RazorpayRefund> {
    return this.request<RazorpayRefund>('POST', `/payments/${paymentId}/refund`, {
      amount: amountPaise,
      // Razorpay dedupes on this, so a retried refund does not pay out twice.
      speed: 'normal',
    });
  }

  /**
   * Verifies the webhook HMAC over the RAW request body.
   *
   * Must run before the payload is parsed or trusted — an unverified webhook
   * endpoint is an open "mark my booking as paid" API. Re-serialising a parsed
   * body would change the bytes and break the signature, which is why the raw
   * buffer is threaded through from the request.
   */
  verifyWebhookSignature(rawBody: Buffer | string, signature: string | undefined): boolean {
    const secret = this.config.get('RAZORPAY_WEBHOOK_SECRET', { infer: true });
    if (!secret || !signature) return false;

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');

    // Constant-time: a length check first, since timingSafeEqual throws on
    // mismatched lengths.
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { keyId, keySecret } = this.credentials();
    const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          authorization: `Basic ${auth}`,
          'content-type': 'application/json',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      // A gateway outage must not create doomed holds — surface it as
      // "temporarily unavailable" so the client can back off.
      this.logger.error(`Razorpay ${method} ${path} failed: ${String(err)}`);
      throw new ServiceUnavailableException({
        code: 'PAYMENT_GATEWAY_UNAVAILABLE',
        message: 'Payments are temporarily unavailable. Please try again.',
      });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      this.logger.error(`Razorpay ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      throw new ServiceUnavailableException({
        code: 'PAYMENT_GATEWAY_ERROR',
        message: 'Payments are temporarily unavailable. Please try again.',
      });
    }

    return (await res.json()) as T;
  }
}
