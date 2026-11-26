-- CreateEnum
CREATE TYPE "PushStatus" AS ENUM ('QUEUED', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "PushMessage" (
    "id" TEXT NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderRole" TEXT NOT NULL,
    "venueId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "audience" JSONB NOT NULL,
    "status" "PushStatus" NOT NULL DEFAULT 'QUEUED',
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "deviceCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMPTZ,

    CONSTRAINT "PushMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PushMessage_senderId_createdAt_idx" ON "PushMessage"("senderId", "createdAt");

-- CreateIndex
CREATE INDEX "PushMessage_venueId_createdAt_idx" ON "PushMessage"("venueId", "createdAt");

-- CreateIndex
CREATE INDEX "PushMessage_createdAt_idx" ON "PushMessage"("createdAt");
