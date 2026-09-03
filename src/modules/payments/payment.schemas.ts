import { z } from 'zod';

export const CreateOrderSchema = z.object({
  bookingId: z.string().min(1),
});

export type CreateOrderDto = z.infer<typeof CreateOrderSchema>;
