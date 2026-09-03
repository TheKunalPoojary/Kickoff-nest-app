import { Injectable, NotFoundException } from '@nestjs/common';
import { fromZonedTime, formatInTimeZone } from 'date-fns-tz';
import { PrismaService } from '../../infra/prisma/prisma.service.js';

export type SlotState = 'AVAILABLE' | 'BOOKED' | 'HELD' | 'BLACKED_OUT' | 'PAST';

export interface Slot {
  startsAt: string;
  endsAt: string;
  localStart: string;
  localEnd: string;
  state: SlotState;
  pricePaise: number;
}

export interface AvailabilityResult {
  resourceId: string;
  venueId: string;
  timezone: string;
  date: string;
  slotDurationMins: number;
  bufferMins: number;
  slots: Slot[];
}

const MINUTES_IN_DAY = 1440;

@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Availability is COMPUTED, never stored.
   *
   * A row per bookable slot would mean a nightly cron, millions of dead rows,
   * and — worst — schedule edits that silently do not take effect until the
   * next generation run. Deriving from OperatingHours means a change to hours
   * or pricing applies to the very next request.
   *
   *   candidates(OperatingHours, slotDurationMins)
   *     − blackouts
   *     − live bookings (CONFIRMED and unexpired PENDING_PAYMENT holds)
   *     − slots already in the past
   */
  async getAvailability(resourceId: string, date: string): Promise<AvailabilityResult> {
    const resource = await this.prisma.resource.findFirst({
      where: { id: resourceId, isActive: true, deletedAt: null },
      select: {
        id: true,
        venueId: true,
        slotDurationMins: true,
        bufferMins: true,
        basePricePaise: true,
        venue: {
          select: {
            timezone: true,
            status: true,
            deletedAt: true,
            hours: { select: { weekday: true, opensAt: true, closesAt: true } },
          },
        },
        priceRules: {
          select: {
            weekdayMask: true,
            startMin: true,
            endMin: true,
            pricePaise: true,
            priority: true,
            validFrom: true,
            validUntil: true,
          },
          orderBy: { priority: 'desc' },
        },
      },
    });

    if (!resource || resource.venue.deletedAt || resource.venue.status !== 'ACTIVE') {
      throw new NotFoundException({
        code: 'RESOURCE_NOT_FOUND',
        message: 'Resource not found.',
      });
    }

    const tz = resource.venue.timezone;
    const { slotDurationMins, bufferMins } = resource;

    // Weekday of the venue-local calendar date. Built in UTC purely as
    // calendar arithmetic — no instant is implied here.
    const [y, m, d] = date.split('-').map(Number);
    const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();

    const hours = resource.venue.hours.find((h) => h.weekday === weekday);

    const base: AvailabilityResult = {
      resourceId: resource.id,
      venueId: resource.venueId,
      timezone: tz,
      date,
      slotDurationMins,
      bufferMins,
      slots: [],
    };

    // Closed that day. An empty slot list is the correct answer, not an error.
    if (!hours) return base;

    const dayStart = this.localMinutesToUtc(date, hours.opensAt, tz);
    const dayEnd = this.localMinutesToUtc(date, hours.closesAt, tz);

    const [bookings, blackouts] = await Promise.all([
      this.prisma.booking.findMany({
        where: {
          resourceId,
          status: { in: ['PENDING_PAYMENT', 'CONFIRMED'] },
          startsAt: { lt: dayEnd },
          endsAt: { gt: dayStart },
        },
        select: { startsAt: true, endsAt: true, status: true, holdsUntil: true },
      }),
      this.prisma.blackout.findMany({
        where: { resourceId, startsAt: { lt: dayEnd }, endsAt: { gt: dayStart } },
        select: { startsAt: true, endsAt: true },
      }),
    ]);

    const now = new Date();

    // An expired-but-unswept hold must not keep a slot hidden — the sweeper
    // runs every 60s, and users should not stare at a phantom booking in the
    // meantime.
    const liveBookings = bookings.filter(
      (b) => b.status === 'CONFIRMED' || !b.holdsUntil || b.holdsUntil > now,
    );

    const slots: Slot[] = [];

    for (
      let startMin = hours.opensAt;
      startMin + slotDurationMins <= hours.closesAt;
      startMin += slotDurationMins
    ) {
      const endMin = startMin + slotDurationMins;
      const startsAt = this.localMinutesToUtc(date, startMin, tz);
      const endsAt = this.localMinutesToUtc(date, endMin, tz);

      // The cleanup gap is part of what a booking occupies, so a candidate is
      // tested with its buffer included. Phase 4 stores the same widened range,
      // which is what lets the exclusion constraint enforce the gap.
      const occupiedEnd = new Date(endsAt.getTime() + bufferMins * 60_000);

      const conflict = liveBookings.find((b) =>
        this.overlaps(startsAt, occupiedEnd, b.startsAt, b.endsAt),
      );
      const blacked = blackouts.some((b) =>
        this.overlaps(startsAt, occupiedEnd, b.startsAt, b.endsAt),
      );

      let state: SlotState = 'AVAILABLE';
      if (startsAt <= now) state = 'PAST';
      else if (blacked) state = 'BLACKED_OUT';
      else if (conflict) state = conflict.status === 'CONFIRMED' ? 'BOOKED' : 'HELD';

      slots.push({
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        localStart: formatInTimeZone(startsAt, tz, 'HH:mm'),
        localEnd: formatInTimeZone(endsAt, tz, 'HH:mm'),
        state,
        pricePaise: this.resolvePrice(resource, startMin, weekday, startsAt),
      });
    }

    return { ...base, slots };
  }

  /**
   * Converts minutes-from-local-midnight into a UTC instant.
   *
   * `minutes` may exceed 1440 for venues closing after midnight (opens 06:00,
   * closes 02:00 → 360 and 1560), so the day rolls forward first and the
   * remainder becomes the wall-clock time. Going through the IANA zone rather
   * than a fixed offset is what keeps this correct across DST boundaries.
   */
  private localMinutesToUtc(date: string, minutes: number, timeZone: string): Date {
    const dayOffset = Math.floor(minutes / MINUTES_IN_DAY);
    const minuteOfDay = minutes % MINUTES_IN_DAY;

    const [y, m, d] = date.split('-').map(Number);
    const shifted = new Date(Date.UTC(y, m - 1, d + dayOffset));

    const yyyy = shifted.getUTCFullYear();
    const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(shifted.getUTCDate()).padStart(2, '0');
    const hh = String(Math.floor(minuteOfDay / 60)).padStart(2, '0');
    const mi = String(minuteOfDay % 60).padStart(2, '0');

    return fromZonedTime(`${yyyy}-${mm}-${dd}T${hh}:${mi}:00`, timeZone);
  }

  /** Half-open on both sides, matching the booking exclusion constraint. */
  private overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
    return aStart < bEnd && bStart < aEnd;
  }

  /**
   * Highest-priority matching rule wins; otherwise the resource's base price.
   * Returned per slot so the client never has to reimplement this and drift.
   */
  private resolvePrice(
    resource: {
      basePricePaise: number;
      priceRules: {
        weekdayMask: number;
        startMin: number;
        endMin: number;
        pricePaise: number;
        priority: number;
        validFrom: Date | null;
        validUntil: Date | null;
      }[];
    },
    slotStartMin: number,
    weekday: number,
    instant: Date,
  ): number {
    let best: { pricePaise: number; priority: number } | null = null;

    for (const rule of resource.priceRules) {
      if ((rule.weekdayMask & (1 << weekday)) === 0) continue;
      if (slotStartMin < rule.startMin || slotStartMin >= rule.endMin) continue;
      if (rule.validFrom && instant < rule.validFrom) continue;
      if (rule.validUntil && instant > rule.validUntil) continue;

      if (!best || rule.priority > best.priority) {
        best = { pricePaise: rule.pricePaise, priority: rule.priority };
      }
    }

    return best?.pricePaise ?? resource.basePricePaise;
  }
}
