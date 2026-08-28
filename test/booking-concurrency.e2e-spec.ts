import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { isExclusionViolation } from '../src/common/errors/domain.errors.js';

/**
 * The single most important test in this codebase.
 *
 * Double-booking is the failure that costs real money and real trust, and it
 * only appears under concurrency — a sequential test will always pass. If this
 * ever goes red, the exclusion constraint has been dropped or weakened.
 */
describe('booking concurrency', () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });

  const RUN = `ct-${Date.now()}`;
  const userId = `${RUN}-user`;
  const venueId = `${RUN}-venue`;
  const resourceId = `${RUN}-resource`;

  const SLOT_START = new Date('2030-01-15T11:30:00Z'); // 17:00 IST
  const SLOT_END = new Date('2030-01-15T12:30:00Z'); // 18:00 IST

  beforeAll(async () => {
    await prisma.user.create({
      data: { id: userId, role: 'USER', preferredSports: [] },
    });
    await prisma.venue.create({
      data: {
        id: venueId,
        ownerId: userId,
        name: 'Concurrency Test Venue',
        slug: `${RUN}-slug`,
        addressLine: '1 Test St',
        city: 'Pune',
        state: 'MH',
        pincode: '411001',
        lat: 18.5,
        lng: 73.8,
        contactPhone: '+910000000000',
        status: 'ACTIVE',
      },
    });
    await prisma.resource.create({
      data: {
        id: resourceId,
        venueId,
        kind: 'TURF',
        name: 'Pitch A',
        basePricePaise: 100_000,
      },
    });
  });

  afterAll(async () => {
    await prisma.booking.deleteMany({ where: { resourceId } });
    await prisma.resource.deleteMany({ where: { id: resourceId } });
    await prisma.venue.deleteMany({ where: { id: venueId } });
    await prisma.user.deleteMany({ where: { id: userId } });
    await prisma.$disconnect();
  });

  const book = (suffix: string, startsAt: Date, endsAt: Date) =>
    prisma.booking.create({
      data: {
        id: `${RUN}-b-${suffix}`,
        bookingCode: `KO-${RUN}-${suffix}`,
        userId,
        resourceId,
        startsAt,
        endsAt,
        status: 'PENDING_PAYMENT',
        amountPaise: 100_000,
      },
    });

  it('lets exactly one of 50 simultaneous attempts win the same slot', async () => {
    const attempts = Array.from({ length: 50 }, (_, i) =>
      book(`race-${i}`, SLOT_START, SLOT_END),
    );

    const results = await Promise.allSettled(attempts);

    const won = results.filter((r) => r.status === 'fulfilled');
    const lost = results.filter((r) => r.status === 'rejected');

    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(49);

    // Every loser must fail for the RIGHT reason. If they were failing on some
    // other error the count assertion above would still pass while the slot
    // was left unprotected.
    for (const r of lost) {
      expect(isExclusionViolation((r as PromiseRejectedResult).reason)).toBe(true);
    }

    const persisted = await prisma.booking.count({
      where: { resourceId, status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] } },
    });
    expect(persisted).toBe(1);
  });

  it('allows a back-to-back slot, so ranges must stay half-open', async () => {
    // 18:00-19:00 immediately after the 17:00-18:00 winner above. A closed
    // range would reject this and break every consecutive booking.
    await expect(
      book('back-to-back', SLOT_END, new Date('2030-01-15T13:30:00Z')),
    ).resolves.toBeDefined();
  });

  it('does not let a hold on one resource block another resource', async () => {
    const otherId = `${RUN}-resource-2`;
    await prisma.resource.create({
      data: {
        id: otherId,
        venueId,
        kind: 'ARCADE',
        name: 'Lane 1',
        slotDurationMins: 30,
        basePricePaise: 50_000,
      },
    });

    await expect(
      prisma.booking.create({
        data: {
          id: `${RUN}-b-other`,
          bookingCode: `KO-${RUN}-other`,
          userId,
          resourceId: otherId,
          startsAt: SLOT_START,
          endsAt: SLOT_END,
          status: 'CONFIRMED',
          amountPaise: 50_000,
        },
      }),
    ).resolves.toBeDefined();

    await prisma.booking.deleteMany({ where: { resourceId: otherId } });
    await prisma.resource.delete({ where: { id: otherId } });
  });

  it('frees the slot once the winning booking is cancelled', async () => {
    const winner = await prisma.booking.findFirst({
      where: { resourceId, startsAt: SLOT_START, status: 'PENDING_PAYMENT' },
    });
    expect(winner).not.toBeNull();

    await prisma.booking.update({
      where: { id: winner!.id },
      data: { status: 'CANCELLED', cancelledAt: new Date() },
    });

    await expect(book('after-cancel', SLOT_START, SLOT_END)).resolves.toBeDefined();
  });
});
