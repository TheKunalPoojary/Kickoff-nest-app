-- OTP challenges and login attempts now cover phone OR email, so the column
-- that held a phone/email becomes a neutral `identifier`. Pure renames: no
-- data is rewritten and existing rows stay valid.

ALTER TABLE "OtpChallenge" RENAME COLUMN "phone" TO "identifier";
ALTER INDEX "OtpChallenge_phone_createdAt_idx" RENAME TO "OtpChallenge_identifier_createdAt_idx";

ALTER TABLE "LoginAttempt" RENAME COLUMN "email" TO "identifier";
ALTER INDEX "LoginAttempt_email_createdAt_idx" RENAME TO "LoginAttempt_identifier_createdAt_idx";
