-- Feature 6002 -- Stripe payment and receivables.
--
-- Payment.method: how she paid, in Stripe's own word (card, payto, ...).
-- Payment.stripePaymentIntentId unique: each payment is kept once, however
-- often Stripe repeats itself. No Payment row exists yet, so nothing clashes.

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "method" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Payment_stripePaymentIntentId_key" ON "Payment"("stripePaymentIntentId");
