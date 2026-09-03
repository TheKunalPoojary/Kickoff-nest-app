import { Module } from '@nestjs/common';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { RazorpayClient } from './razorpay.client.js';
import { ReconciliationService } from './reconciliation.service.js';

@Module({
  controllers: [PaymentsController],
  providers: [PaymentsService, RazorpayClient, ReconciliationService],
  exports: [PaymentsService, RazorpayClient],
})
export class PaymentsModule {}
