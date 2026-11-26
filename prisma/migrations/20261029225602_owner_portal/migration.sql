-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('APP', 'WALK_IN');

-- AlterTable
ALTER TABLE "Booking" ADD COLUMN     "advancePaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "balanceCollectedAt" TIMESTAMPTZ,
ADD COLUMN     "balanceCollectedPaise" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "customerName" TEXT,
ADD COLUMN     "customerPhone" TEXT,
ADD COLUMN     "source" "BookingSource" NOT NULL DEFAULT 'APP';

-- AlterTable
ALTER TABLE "Venue" ADD COLUMN     "advancePct" INTEGER NOT NULL DEFAULT 100;

-- CreateTable
CREATE TABLE "AppSetting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedBy" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AppSetting_pkey" PRIMARY KEY ("key")
);

-- ---------------------------------------------------------------------------
-- Hand-written (Prisma cannot express these). Re-add by hand if migrations
-- are ever reset.
-- ---------------------------------------------------------------------------

-- Bookings made before the advance model were paid in full online.
UPDATE "Booking" SET "advancePaise" = "amountPaise" WHERE "source" = 'APP';

-- The advance is part of the price, never more than it.
ALTER TABLE "Booking"
  ADD CONSTRAINT booking_advance_sane
  CHECK ("advancePaise" >= 0 AND "advancePaise" <= "amountPaise");

ALTER TABLE "Booking"
  ADD CONSTRAINT booking_balance_collected_nonneg
  CHECK ("balanceCollectedPaise" >= 0);

-- 0% would let a player hold a slot for free; > 100% overcharges.
ALTER TABLE "Venue"
  ADD CONSTRAINT venue_advance_pct_range CHECK ("advancePct" BETWEEN 1 AND 100);
