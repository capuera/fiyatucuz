import { z } from 'zod';

export const UuidParamSchema = z.string().uuid();

const feedFormats = ['GOOGLE_MERCHANT_XML', 'CUSTOM_XML', 'CSV'] as const;
const feedStatuses = ['ACTIVE', 'PAUSED', 'ERROR', 'DISABLED'] as const;

export const CreateFeedBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    url: z.string().trim().min(3).max(2048),
    format: z.enum(feedFormats),
    fetchSchedule: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const UpdateFeedBodySchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    url: z.string().trim().min(3).max(2048).optional(),
    format: z.enum(feedFormats).optional(),
    status: z.enum(feedStatuses).optional(),
    fetchSchedule: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

export type CreateFeedInput = z.infer<typeof CreateFeedBodySchema>;
export type UpdateFeedInput = z.infer<typeof UpdateFeedBodySchema>;
