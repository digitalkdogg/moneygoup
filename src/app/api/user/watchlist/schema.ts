import { z } from 'zod';
import { tickerSchema, companyNameSchema } from '@/utils/validationSchemas';

export const addStockSchema = z.object({
  ticker: tickerSchema,
  name: companyNameSchema,
});

export type AddStockInput = z.infer<typeof addStockSchema>;
