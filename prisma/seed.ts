import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { hashPassword } from '../src/modules/auth/password.util.js';
import { DEFAULT_APP_SETTINGS } from '../src/modules/app-config/app-config.schemas.js';

/**
 * Development seed. Idempotent — every write is an upsert against a fixed id,
 * so running it repeatedly converges rather than piling up duplicates.
 *
 * Money is integer paise throughout. Operating hours are minutes from LOCAL
 * midnight, and may exceed 1440 for venues that close after midnight.
 */
const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

const hours = (opensAt: number, closesAt: number) =>
  [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, opensAt, closesAt }));

const HOUR = 60;

async function main() {
  // ---------------------------------------------------------------- owners
  // Dev-only portal logins. Passwords come from env so nothing real is ever
  // committed; the fallbacks exist purely for a local checkout.
  const ownerPasswordHash = await hashPassword(
    process.env.SEED_OWNER_PASSWORD ?? 'owner-dev-1234',
  );
  const adminPasswordHash = await hashPassword(
    process.env.SEED_ADMIN_PASSWORD ?? 'admin-dev-1234',
  );

  const owner = await prisma.user.upsert({
    where: { id: 'seed-owner-1' },
    create: {
      id: 'seed-owner-1',
      phone: '+919000000001',
      email: 'owner@kickoff.local',
      passwordHash: ownerPasswordHash,
      name: 'Ravi Deshpande',
      role: 'VENUE_OWNER',
      city: 'Pune',
      preferredSports: ['football'],
    },
    update: { role: 'VENUE_OWNER', email: 'owner@kickoff.local', passwordHash: ownerPasswordHash },
  });

  const admin = await prisma.user.upsert({
    where: { id: 'seed-admin-1' },
    create: {
      id: 'seed-admin-1',
      email: 'admin@kickoff.local',
      passwordHash: adminPasswordHash,
      name: 'Kickoff Admin',
      role: 'ADMIN',
      preferredSports: [],
    },
    update: { role: 'ADMIN', passwordHash: adminPasswordHash },
  });

  // Only create missing keys — re-seeding must not clobber settings an admin
  // has since changed from the portal.
  for (const [key, value] of Object.entries(DEFAULT_APP_SETTINGS)) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: {} });
  }

  const player = await prisma.user.upsert({
    where: { id: 'seed-player-1' },
    create: {
      id: 'seed-player-1',
      phone: '+919000000002',
      name: 'Test Player',
      role: 'USER',
      city: 'Pune',
      preferredSports: ['football', 'cricket'],
    },
    update: {},
  });

  // ---------------------------------------------------------------- venues
  const venues = [
    {
      id: 'seed-venue-kondhwa',
      name: 'Greenfield Turf Kondhwa',
      slug: 'greenfield-turf-kondhwa',
      description: 'Two floodlit 5-a-side pitches with FIFA-approved artificial grass.',
      addressLine: 'Lane 5, NIBM Road, Kondhwa',
      city: 'Pune',
      state: 'MH',
      pincode: '411048',
      lat: 18.4649,
      lng: 73.8907,
      amenities: ['parking', 'floodlights', 'washroom', 'drinking-water'],
      // Opens 06:00, closes 01:00 the next day — hence 1500, not 60.
      hours: hours(6 * HOUR, 25 * HOUR),
      resources: [
        {
          id: 'seed-res-kondhwa-a',
          kind: 'TURF' as const,
          name: 'Pitch A',
          attributes: { sport: 'football', surface: 'artificial-grass', format: '5-a-side' },
          slotDurationMins: 60,
          bufferMins: 0,
          basePricePaise: 90_000,
          maxPlayers: 10,
          priceRules: [
            {
              id: 'seed-pr-kondhwa-a-evening',
              name: 'Weekday evening peak',
              weekdayMask: 0b0111110, // Mon-Fri
              startMin: 18 * HOUR,
              endMin: 23 * HOUR,
              pricePaise: 130_000,
              priority: 10,
            },
            {
              id: 'seed-pr-kondhwa-a-weekend',
              name: 'Weekend all-day',
              weekdayMask: 0b1000001, // Sun + Sat
              startMin: 6 * HOUR,
              endMin: 25 * HOUR,
              pricePaise: 150_000,
              priority: 20,
            },
          ],
        },
        {
          id: 'seed-res-kondhwa-b',
          kind: 'TURF' as const,
          name: 'Pitch B',
          attributes: { sport: 'football', surface: 'artificial-grass', format: '7-a-side' },
          slotDurationMins: 60,
          bufferMins: 10,
          basePricePaise: 120_000,
          maxPlayers: 14,
          priceRules: [],
        },
      ],
    },
    {
      id: 'seed-venue-baner',
      name: 'Playzone Baner',
      slug: 'playzone-baner',
      description: 'Rooftop cricket nets and a box-cricket turf, open late.',
      addressLine: 'Baner-Pashan Link Road',
      city: 'Pune',
      state: 'MH',
      pincode: '411045',
      lat: 18.5590,
      lng: 73.7868,
      amenities: ['parking', 'floodlights', 'cafe', 'equipment-rental'],
      hours: hours(7 * HOUR, 24 * HOUR),
      resources: [
        {
          id: 'seed-res-baner-box',
          kind: 'TURF' as const,
          name: 'Box Cricket Turf',
          attributes: { sport: 'cricket', surface: 'matting', format: 'box' },
          slotDurationMins: 60,
          bufferMins: 0,
          basePricePaise: 110_000,
          maxPlayers: 12,
          priceRules: [
            {
              id: 'seed-pr-baner-box-night',
              name: 'Late night discount',
              weekdayMask: 0b1111111,
              startMin: 22 * HOUR,
              endMin: 24 * HOUR,
              pricePaise: 70_000,
              priority: 5,
            },
          ],
        },
        {
          id: 'seed-res-baner-net-1',
          kind: 'TURF' as const,
          name: 'Practice Net 1',
          attributes: { sport: 'cricket', surface: 'matting', format: 'net' },
          slotDurationMins: 30,
          bufferMins: 0,
          basePricePaise: 40_000,
          maxPlayers: 4,
          priceRules: [],
        },
      ],
    },
    {
      id: 'seed-venue-viman',
      name: 'Pixel Arcade Viman Nagar',
      slug: 'pixel-arcade-viman-nagar',
      description: 'VR booths, bowling lanes and a pool room.',
      addressLine: 'Phoenix Marketcity, Viman Nagar',
      city: 'Pune',
      state: 'MH',
      pincode: '411014',
      lat: 18.5620,
      lng: 73.9160,
      amenities: ['parking', 'air-conditioned', 'cafe', 'washroom'],
      hours: hours(11 * HOUR, 23 * HOUR),
      resources: [
        {
          id: 'seed-res-viman-vr-1',
          kind: 'ARCADE' as const,
          name: 'VR Booth 1',
          attributes: { game: 'vr-multiplayer', capacity: 4 },
          slotDurationMins: 30,
          bufferMins: 5,
          basePricePaise: 60_000,
          maxPlayers: 4,
          priceRules: [],
        },
        {
          id: 'seed-res-viman-lane-1',
          kind: 'ARCADE' as const,
          name: 'Bowling Lane 1',
          attributes: { game: 'bowling', capacity: 6 },
          slotDurationMins: 60,
          bufferMins: 10,
          basePricePaise: 80_000,
          maxPlayers: 6,
          priceRules: [
            {
              id: 'seed-pr-viman-lane-weekend',
              name: 'Weekend peak',
              weekdayMask: 0b1000001,
              startMin: 17 * HOUR,
              endMin: 23 * HOUR,
              pricePaise: 110_000,
              priority: 10,
            },
          ],
        },
        {
          id: 'seed-res-viman-pool-1',
          kind: 'ARCADE' as const,
          name: 'Pool Table 1',
          attributes: { game: 'pool', capacity: 4 },
          slotDurationMins: 30,
          bufferMins: 0,
          basePricePaise: 30_000,
          maxPlayers: 4,
          priceRules: [],
        },
      ],
    },
  ];

  for (const v of venues) {
    const { hours: venueHours, resources, ...venueData } = v;

    await prisma.venue.upsert({
      where: { id: v.id },
      create: {
        ...venueData,
        ownerId: owner.id,
        contactPhone: '+919000000001',
        photos: [],
        status: 'ACTIVE',
        timezone: 'Asia/Kolkata',
      },
      update: { ...venueData, status: 'ACTIVE' },
    });

    for (const h of venueHours) {
      await prisma.operatingHours.upsert({
        where: { venueId_weekday: { venueId: v.id, weekday: h.weekday } },
        create: { venueId: v.id, ...h },
        update: h,
      });
    }

    for (const r of resources) {
      const { priceRules, ...resourceData } = r;

      await prisma.resource.upsert({
        where: { id: r.id },
        create: { ...resourceData, venueId: v.id },
        update: resourceData,
      });

      for (const pr of priceRules) {
        await prisma.priceRule.upsert({
          where: { id: pr.id },
          create: { ...pr, resourceId: r.id },
          update: pr,
        });
      }
    }
  }

  const [venueCount, resourceCount, ruleCount] = await Promise.all([
    prisma.venue.count(),
    prisma.resource.count(),
    prisma.priceRule.count(),
  ]);

  console.log(
    `Seeded: ${venueCount} venues, ${resourceCount} resources, ${ruleCount} price rules ` +
      `(owner ${owner.email}, admin ${admin.email}, player ${player.phone})`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
