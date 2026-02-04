import { z } from 'zod';

export const addStockSchema = z.object({
  ticker: z.string().min(1, 'Ticker is required').max(10, 'Ticker cannot exceed 10 characters'),
  name: z.string().min(1, 'Company name is required'),
});

export type AddStockInput = z.infer<typeof addStockSchema>;
