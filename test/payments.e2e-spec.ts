import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AllExceptionsFilter } from '../src/common/filters/all-exceptions.filter.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { TokenService } from '../src/modules/auth/token.service.js';
import { RazorpayClient } from '../src/modules/payments/razorpay.client.js';

/**
 * Read from ConfigService rather than hardcoded: @nestjs/config lets the .env
 * file win over process.env, so a hardcoded value here would silently disagree
 * with what the app actually verifies against.
 */
let webhookSecret: string;

/**
 * Only the NETWORK calls are faked. verifyWebhookSignature is inherited from
 * the real client, so the HMAC path — the thing that actually protects this
 * endpoint — is genuinely exercised.
 */
class FakeRazorpay extends RazorpayClient {
  orders: { amountPaise: number; receipt: string }[] = [];
  refunds: { paymentId: string; amountPaise: number }[] = [];
  private seq = 0;

  override async createOrder(params: { amountPaise: number; receipt: string }) {
    this.orders.push(params);
    return {
      id: `order_test_${++this.seq}_${Date.now()}`,
      amount: params.amountPaise,
      currency: 'INR',
      status: 'created',
      receipt: params.receipt,
    };
  }

  override async refund(paymentId: string, amountPaise: number) {
    this.refunds.push({ paymentId, amountPaise });
    return { id: `rfnd_${++this.seq}`, payment_id: paymentId, amount: amountPaise, status: 'processed' };
  }
}

describe('payments (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let tokens: TokenService;
  let razorpay: FakeRazorpay;

  const RUN = `py-${Date.now()}`;
  const ownerId = `${RUN}-owner`;
  const userAId = `${RUN}-user-a`;
  const userBId = `${RUN}-user-b`;
  const venueId = `${RUN}-venue`;
  const resId = `${RUN}-res`;

  let tokenA: string;
  let tokenB: string;

  const SLOT_09 = '2031-06-04T03:30:00.000Z';
  const SLOT_10 = '2031-06-04T04:30:00.000Z';

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(RazorpayClient)
      .useFactory({
        factory: (config: ConfigService) => new FakeRazorpay(config as never),
        inject: [ConfigService],
      })
      .compile();

    app = moduleRef.createNestApplication({ rawBody: true });
    app.setGlobalPrefix('api/v1', { exclude: ['health'] });
    app.useGlobalFilters(new AllExceptionsFilter());
    await app.init();

    prisma = app.get(PrismaService);
    tokens = app.get(TokenService);
    razorpay = app.get(RazorpayClient) as FakeRazorpay;

    webhookSecret = app.get(ConfigService).get('RAZORPAY_WEBHOOK_SECRET') as string;
    if (!webhookSecret) {
      throw new Error('RAZORPAY_WEBHOOK_SECRET must be set in .env for payment tests');
    }

    await prisma.user.createMany({
      data: [
        { id: ownerId, phone: `+9195${RUN.slice(-8)}1`, role: 'VENUE_OWNER', preferredSports: [] },
        { id: userAId, phone: `+9195${RUN.slice(-8)}2`, role: 'USER', preferredSports: [] },
        { id: userBId, phone: `+9195${RUN.slice(-8)}3`, role: 'USER', preferredSports: [] },
      ],
    });
    tokenA = (await tokens.issuePair(userAId, 'USER')).accessToken;
    tokenB = (await tokens.issuePair(userBId, 'USER')).accessToken;

    await prisma.venue.create({
      data: {
        id: venueId,
        ownerId,
        name: 'Payments Test Venue',
        slug: `${RUN}-venue`,
        addressLine: '1 Test Rd',
        city: `PyCity${RUN}`,
        state: 'MH',
        pincode: '411001',
        lat: 18.5,
        lng: 73.85,
        timezone: 'Asia/Kolkata',
        contactPhone: '+919000000031',
        status: 'ACTIVE',
        commissionPct: 10,
        hours: { create: [{ weekday: 3, opensAt: 540, closesAt: 780 }] },
        resources: {
          create: {
            id: resId,
            kind: 'TURF',
            name: 'Pitch 1',
            attributes: { sport: 'football' },
            slotDurationMins: 60,
            basePricePaise: 100_000,
          },
        },
      },
    });
  });

  beforeEach(async () => {
    await prisma.ledgerEntry.deleteMany({ where: { booking: { resourceId: resId } } });
    await prisma.payment.deleteMany({ where: { booking: { resourceId: resId } } });
    await prisma.booking.deleteMany({ where: { resourceId: resId } });
    await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: RUN } } });
    razorpay.refunds.length = 0;
  });

  afterAll(async () => {
    const ids = [ownerId, userAId, userBId];
    await prisma.ledgerEntry.deleteMany({ where: { booking: { resource: { venueId } } } });
    await prisma.payment.deleteMany({ where: { booking: { resource: { venueId } } } });
    await prisma.booking.deleteMany({ where: { resource: { venueId } } });
    await prisma.webhookEvent.deleteMany({ where: { eventId: { startsWith: RUN } } });
    await prisma.refreshSession.deleteMany({ where: { userId: { in: ids } } });
    await prisma.priceRule.deleteMany({ where: { resource: { venue: { ownerId: { in: ids } } } } });
    await prisma.operatingHours.deleteMany({ where: { venue: { ownerId: { in: ids } } } });
    await prisma.resource.deleteMany({ where: { venue: { ownerId: { in: ids } } } });
    await prisma.venue.deleteMany({ where: { ownerId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
    await app.close();
  });

  const http = () => request(app.getHttpServer());

  const makeBooking = async (token = tokenA, startsAt = SLOT_09) => {
    const res = await http()
      .post('/api/v1/bookings')
      .set('authorization', `Bearer ${token}`)
      .send({ resourceId: resId, startsAt })
      .expect(201);
    return res.body as { id: string; amountPaise: number };
  };

  const createOrder = async (bookingId: string, token = tokenA) => {
    const res = await http()
      .post('/api/v1/payments/order')
      .set('authorization', `Bearer ${token}`)
      .send({ bookingId })
      .expect(200);
    return res.body as { orderId: string; amountPaise: number };
  };

  /** Posts a webhook exactly as Razorpay would: signed over the raw bytes. */
  const postWebhook = (
    event: string,
    payload: Record<string, unknown>,
    eventId: string,
    opts: { corruptSignature?: boolean } = {},
  ) => {
    const raw = JSON.stringify({ event, payload });
    const signature = createHmac('sha256', webhookSecret).update(raw).digest('hex');

    return http()
      .post('/api/v1/payments/webhook')
      .set('content-type', 'application/json')
      .set('x-razorpay-event-id', eventId)
      .set('x-razorpay-signature', opts.corruptSignature ? 'deadbeef' : signature)
      .send(raw);
  };

  const capturedPayload = (orderId: string, paymentId: string, amount = 100_000) => ({
    payment: {
      entity: { id: paymentId, order_id: orderId, amount, status: 'captured', method: 'upi' },
    },
  });

  describe('order creation', () => {
    it('creates an order for a held booking', async () => {
      const booking = await makeBooking();
      const order = await createOrder(booking.id);

      expect(order.orderId).toMatch(/^order_test_/);
      expect(order.amountPaise).toBe(100_000);

      const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
      expect(payment?.status).toBe('CREATED');
    });

    it('reuses the existing order instead of creating a second', async () => {
      // Two live orders for one booking means two ways to pay for one slot.
      const booking = await makeBooking();
      const first = await createOrder(booking.id);
      const second = await createOrder(booking.id);

      expect(second.orderId).toBe(first.orderId);
      expect(razorpay.orders.filter((o) => o.amountPaise === 100_000).length).toBeGreaterThan(0);

      const count = await prisma.payment.count({ where: { bookingId: booking.id } });
      expect(count).toBe(1);
    });

    it('refuses when the hold has already expired', async () => {
      const booking = await makeBooking();
      await prisma.booking.update({
        where: { id: booking.id },
        data: { holdsUntil: new Date(Date.now() - 60_000) },
      });

      const res = await http()
        .post('/api/v1/payments/order')
        .set('authorization', `Bearer ${tokenA}`)
        .send({ bookingId: booking.id })
        .expect(409);
      expect(res.body.error.code).toBe('HOLD_EXPIRED');
    });

    it('refuses a booking that is not awaiting payment', async () => {
      const booking = await makeBooking();
      await prisma.booking.update({
        where: { id: booking.id },
        data: { status: 'CANCELLED' },
      });

      const res = await http()
        .post('/api/v1/payments/order')
        .set('authorization', `Bearer ${tokenA}`)
        .send({ bookingId: booking.id })
        .expect(409);
      expect(res.body.error.code).toBe('BOOKING_NOT_PAYABLE');
    });

    it('404s another user’s booking', async () => {
      const booking = await makeBooking(tokenB, SLOT_10);

      await http()
        .post('/api/v1/payments/order')
        .set('authorization', `Bearer ${tokenA}`)
        .send({ bookingId: booking.id })
        .expect(404);
    });
  });

  describe('webhook security', () => {
    it('rejects an unsigned request', async () => {
      const res = await http()
        .post('/api/v1/payments/webhook')
        .set('content-type', 'application/json')
        .set('x-razorpay-event-id', `${RUN}-nosig`)
        .send(JSON.stringify({ event: 'payment.captured', payload: {} }))
        .expect(403);

      expect(res.body.error.code).toBe('INVALID_WEBHOOK_SIGNATURE');
    });

    it('rejects a forged signature', async () => {
      const booking = await makeBooking();
      const order = await createOrder(booking.id);

      await postWebhook(
        'payment.captured',
        capturedPayload(order.orderId, 'pay_forged'),
        `${RUN}-forged`,
        { corruptSignature: true },
      ).expect(403);

      // And crucially, nothing was confirmed.
      const after = await prisma.booking.findUnique({ where: { id: booking.id } });
      expect(after?.status).toBe('PENDING_PAYMENT');
    });

    it('rejects a signature computed over different bytes', async () => {
      // A tampered payload with a signature valid for the ORIGINAL body.
      const original = JSON.stringify({ event: 'payment.captured', payload: {} });
      const signature = createHmac('sha256', webhookSecret).update(original).digest('hex');

      await http()
        .post('/api/v1/payments/webhook')
        .set('content-type', 'application/json')
        .set('x-razorpay-event-id', `${RUN}-tampered`)
        .set('x-razorpay-signature', signature)
        .send(JSON.stringify({ event: 'payment.captured', payload: { tampered: true } }))
        .expect(403);
    });
  });

  describe('payment captured', () => {
    it('confirms the booking and writes a balanced ledger', async () => {
      const booking = await makeBooking();
      const order = await createOrder(booking.id);

      await postWebhook(
        'payment.captured',
        capturedPayload(order.orderId, 'pay_ok_1'),
        `${RUN}-cap-1`,
      ).expect(200);

      const after = await prisma.booking.findUnique({ where: { id: booking.id } });
      expect(after?.status).toBe('CONFIRMED');
      // The hold is released — the slot is now held by a confirmed booking.
      expect(after?.holdsUntil).toBeNull();

      const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
      expect(payment?.status).toBe('PAID');
      expect(payment?.providerPaymentId).toBe('pay_ok_1');
      expect(payment?.method).toBe('upi');

      const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
      const debits = entries.filter((e) => e.direction === 'DEBIT').reduce((s, e) => s + e.amountPaise, 0);
      const credits = entries.filter((e) => e.direction === 'CREDIT').reduce((s, e) => s + e.amountPaise, 0);

      expect(debits).toBe(credits);
      expect(debits).toBe(100_000);
      expect(entries.find((e) => e.account === 'COMMISSION')?.amountPaise).toBe(10_000);
      expect(entries.find((e) => e.account === `OWNER_PAYABLE:${venueId}`)?.amountPaise).toBe(90_000);
    });

    it('is idempotent — a replayed delivery does not double the ledger', async () => {
      // Razorpay retries until it gets a 2xx, so this WILL happen in production.
      const booking = await makeBooking();
      const order = await createOrder(booking.id);
      const payload = capturedPayload(order.orderId, 'pay_ok_2');

      await postWebhook('payment.captured', payload, `${RUN}-cap-2`).expect(200);
      const second = await postWebhook('payment.captured', payload, `${RUN}-cap-2`).expect(200);

      expect(second.body.reason).toBe('duplicate');

      const entries = await prisma.ledgerEntry.count({ where: { bookingId: booking.id } });
      expect(entries).toBe(3);
    });

    it('ignores a capture for an order it has never seen', async () => {
      // Loud in the logs, but must not throw — Razorpay would retry forever.
      await postWebhook(
        'payment.captured',
        capturedPayload('order_unknown_xyz', 'pay_orphan'),
        `${RUN}-orphan`,
      ).expect(200);
    });

    it('acks event types it does not act on', async () => {
      const res = await postWebhook('order.paid', {}, `${RUN}-other`).expect(200);
      expect(res.body.handled).toBe(false);
    });
  });

  describe('payment failed', () => {
    it('marks the payment failed but leaves the hold intact for a retry', async () => {
      const booking = await makeBooking();
      const order = await createOrder(booking.id);

      await postWebhook(
        'payment.failed',
        {
          payment: {
            entity: {
              id: 'pay_fail_1',
              order_id: order.orderId,
              amount: 100_000,
              status: 'failed',
              error_description: 'Insufficient funds',
            },
          },
        },
        `${RUN}-fail-1`,
      ).expect(200);

      const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
      expect(payment?.status).toBe('FAILED');
      expect(payment?.failureReason).toBe('Insufficient funds');

      // The user may retry within the hold window; the sweeper frees it if not.
      const after = await prisma.booking.findUnique({ where: { id: booking.id } });
      expect(after?.status).toBe('PENDING_PAYMENT');
    });
  });

  describe('status polling', () => {
    it('reports unsettled before capture and settled after', async () => {
      const booking = await makeBooking();
      const order = await createOrder(booking.id);

      const before = await http()
        .get(`/api/v1/payments/${booking.id}/status`)
        .set('authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(before.body).toMatchObject({ bookingStatus: 'PENDING_PAYMENT', settled: false });

      await postWebhook(
        'payment.captured',
        capturedPayload(order.orderId, 'pay_ok_3'),
        `${RUN}-cap-3`,
      ).expect(200);

      const after = await http()
        .get(`/api/v1/payments/${booking.id}/status`)
        .set('authorization', `Bearer ${tokenA}`)
        .expect(200);
      expect(after.body).toMatchObject({ bookingStatus: 'CONFIRMED', settled: true });
    });
  });

  describe('refunds', () => {
    const confirmBooking = async () => {
      const booking = await makeBooking();
      const order = await createOrder(booking.id);
      await postWebhook(
        'payment.captured',
        capturedPayload(order.orderId, `pay_${RUN}_${Math.random().toString(36).slice(2, 8)}`),
        `${RUN}-cap-${Math.random().toString(36).slice(2, 8)}`,
      ).expect(200);
      return booking;
    };

    it('refunds a cancellation and reverses the ledger proportionally', async () => {
      const booking = await confirmBooking();

      // Cancelling a PAID booking must issue the refund by itself — not wait
      // for someone to notice and trigger it.
      const cancelled = await http()
        .post(`/api/v1/bookings/${booking.id}/cancel`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({ reason: 'plans changed' })
        .expect(200);

      expect(cancelled.body.refundIssued).toBe(true);
      expect(razorpay.refunds).toHaveLength(1);
      expect(razorpay.refunds[0].amountPaise).toBe(100_000);

      expect(razorpay.refunds[0].amountPaise).toBe(100_000);

      const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
      // Refunds are asynchronous and take days to land, so this is PENDING
      // until refund.processed arrives — not REFUNDED.
      expect(payment?.status).toBe('REFUND_PENDING');

      const entries = await prisma.ledgerEntry.findMany({ where: { bookingId: booking.id } });
      const net = new Map<string, number>();
      for (const e of entries) {
        const delta = e.direction === 'DEBIT' ? e.amountPaise : -e.amountPaise;
        net.set(e.account, (net.get(e.account) ?? 0) + delta);
      }

      // Capture then full refund must leave every account exactly where it started.
      for (const [, value] of net) expect(value).toBe(0);
    });

    it('does not call the gateway when nothing was captured', async () => {
      // An unpaid hold simply expires — there is no money to give back.
      const booking = await makeBooking();

      const cancelled = await http()
        .post(`/api/v1/bookings/${booking.id}/cancel`)
        .set('authorization', `Bearer ${tokenA}`)
        .send({})
        .expect(200);

      expect(cancelled.body.refundIssued).toBe(false);
      expect(razorpay.refunds).toHaveLength(0);
    });

    it('still cancels the booking when the refund call fails', async () => {
      // The user has been told it is cancelled and the slot is released. A
      // stuck refund is recoverable; a silently un-cancelled booking is not.
      const booking = await confirmBooking();
      const original = razorpay.refund.bind(razorpay);
      razorpay.refund = async () => {
        throw new Error('gateway down');
      };

      try {
        const res = await http()
          .post(`/api/v1/bookings/${booking.id}/cancel`)
          .set('authorization', `Bearer ${tokenA}`)
          .send({})
          .expect(200);

        expect(res.body.booking.status).toBe('CANCELLED');
        expect(res.body.refundIssued).toBe(false);

        const row = await prisma.booking.findUnique({ where: { id: booking.id } });
        expect(row?.status).toBe('CANCELLED');
      } finally {
        razorpay.refund = original;
      }
    });

    it('closes the refund out when refund.processed arrives', async () => {
      const booking = await confirmBooking();
      const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });

      await postWebhook(
        'refund.processed',
        {
          refund: {
            entity: {
              id: 'rfnd_1',
              payment_id: payment!.providerPaymentId,
              amount: 100_000,
              status: 'processed',
            },
          },
        },
        `${RUN}-refund-1`,
      ).expect(200);

      const after = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
      expect(after?.status).toBe('REFUNDED');
      expect(after?.refundedPaise).toBe(100_000);
    });

    it('marks a partial refund as PARTIALLY_REFUNDED', async () => {
      const booking = await confirmBooking();
      const payment = await prisma.payment.findUnique({ where: { bookingId: booking.id } });

      await postWebhook(
        'refund.processed',
        {
          refund: {
            entity: {
              id: 'rfnd_2',
              payment_id: payment!.providerPaymentId,
              amount: 50_000,
              status: 'processed',
            },
          },
        },
        `${RUN}-refund-2`,
      ).expect(200);

      const after = await prisma.payment.findUnique({ where: { bookingId: booking.id } });
      expect(after?.status).toBe('PARTIALLY_REFUNDED');
      expect(after?.refundedPaise).toBe(50_000);
    });
  });
});
