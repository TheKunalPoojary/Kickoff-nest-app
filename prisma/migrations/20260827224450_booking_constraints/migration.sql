-- Constraints Prisma cannot express. These are load-bearing correctness rules,
-- not defensive extras.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ---------------------------------------------------------------------------
-- THE critical constraint: no two ACTIVE bookings may overlap on a resource.
--
-- Application-level "check availability then insert" is racy: two concurrent
-- transactions both read "free" before either writes. This constraint makes
-- the database itself reject the second write, atomically, no matter how many
-- app instances are running.
--
-- '[)' is half-open ON PURPOSE: a 17:00-18:00 booking must NOT collide with
-- 18:00-19:00. Using '[]' here would reject every back-to-back booking and
-- present as mysterious intermittent 409s.
--
-- The WHERE clause means CANCELLED / EXPIRED / COMPLETED rows stop blocking
-- the slot. Note it cannot reference now(), so an expired-but-unswept hold
-- still blocks — that is why expire-holds runs every 60s AND the booking
-- service retries once after clearing stale overlapping holds inline.
-- ---------------------------------------------------------------------------
ALTER TABLE "Booking"
  ADD CONSTRAINT booking_no_overlap
  EXCLUDE USING gist (
    "resourceId" WITH =,
    tstzrange("startsAt", "endsAt", '[)') WITH &&
  )
  WHERE (status IN ('PENDING_PAYMENT', 'CONFIRMED'));

-- ---------------------------------------------------------------------------
-- Sanity constraints. Cheap, and they turn silent data corruption into a loud
-- write failure.
-- ---------------------------------------------------------------------------
ALTER TABLE "Booking"
  ADD CONSTRAINT booking_time_sane CHECK ("endsAt" > "startsAt");

ALTER TABLE "Booking"
  ADD CONSTRAINT booking_amount_nonneg
  CHECK ("amountPaise" >= 0 AND "platformFeePaise" >= 0 AND "taxPaise" >= 0);

ALTER TABLE "Blackout"
  ADD CONSTRAINT blackout_time_sane CHECK ("endsAt" > "startsAt");

ALTER TABLE "Review"
  ADD CONSTRAINT review_rating_range CHECK (rating BETWEEN 1 AND 5);

-- A refund can never exceed what was actually captured.
ALTER TABLE "Payment"
  ADD CONSTRAINT payment_refund_lte_amount
  CHECK ("refundedPaise" >= 0 AND "refundedPaise" <= "amountPaise");

ALTER TABLE "Payout"
  ADD CONSTRAINT payout_amounts_sane
  CHECK ("grossPaise" >= 0 AND "commissionPaise" >= 0 AND "netPaise" >= 0);

-- Operating hours are minutes from LOCAL midnight; closesAt may exceed 1440
-- for venues closing after midnight (opens 06:00 -> 360, closes 02:00 -> 1560).
ALTER TABLE "OperatingHours"
  ADD CONSTRAINT hours_sane
  CHECK ("weekday" BETWEEN 0 AND 6 AND "opensAt" >= 0 AND "closesAt" > "opensAt" AND "closesAt" <= 2880);

ALTER TABLE "Resource"
  ADD CONSTRAINT resource_slot_sane
  CHECK ("slotDurationMins" > 0 AND "bufferMins" >= 0 AND "basePricePaise" >= 0);

-- Ledger entries are append-only facts; direction is a closed set.
ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT ledger_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT'));

ALTER TABLE "LedgerEntry"
  ADD CONSTRAINT ledger_amount_positive CHECK ("amountPaise" > 0);

-- ---------------------------------------------------------------------------
-- Hot-path index. Availability lookup only ever cares about active bookings,
-- and most rows are historical, so keep the index small and partial.
-- ---------------------------------------------------------------------------
CREATE INDEX booking_active_window
  ON "Booking" ("resourceId", "startsAt")
  WHERE status IN ('PENDING_PAYMENT', 'CONFIRMED');

-- Drives the expire-holds sweeper.
CREATE INDEX booking_pending_holds
  ON "Booking" ("holdsUntil")
  WHERE status = 'PENDING_PAYMENT';

-- ---------------------------------------------------------------------------
-- Soft-delete-aware uniqueness: a deleted venue must not reserve its slug
-- forever, but two live venues cannot share one.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX venue_slug_live
  ON "Venue" (slug)
  WHERE "deletedAt" IS NULL;
