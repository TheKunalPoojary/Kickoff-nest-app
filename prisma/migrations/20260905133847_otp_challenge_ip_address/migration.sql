-- AlterTable
ALTER TABLE "OtpChallenge" ADD COLUMN     "ipAddress" TEXT;

-- CreateIndex
CREATE INDEX "OtpChallenge_ipAddress_createdAt_idx" ON "OtpChallenge"("ipAddress", "createdAt");
