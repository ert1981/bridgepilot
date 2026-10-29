import { z } from 'zod';
import { isAddress, getAddress } from 'viem';

const address = z
  .string()
  .max(64)
  .refine((v) => isAddress(v, { strict: false }), 'must be a valid EVM address')
  .transform((v) => getAddress(v));

const uintString = z
  .string()
  .max(78)
  .regex(/^[1-9][0-9]*$/, 'must be a positive integer in the token smallest unit (no decimals, no leading zeros)')
  // zod runs refinements even when the regex failed, so guard before BigInt().
  .refine((v) => !/^[0-9]+$/.test(v) || BigInt(v) < 1n << 256n, 'exceeds uint256');

const usdString = z.string().max(32).regex(/^(0|[1-9][0-9]*)(\.[0-9]{1,6})?$/, 'must be a USD decimal string');

const chainRef = z.union([z.string().min(1).max(32), z.number().int().positive()]);

export const SELECTION_POLICIES = ['highest_net_output', 'fastest'] as const;

export const ConstraintsSchema = z
  .object({
    max_slippage_bps: z.number().int().min(1).max(10_000).optional(),
    min_output: uintString.optional(),
    max_time_seconds: z.number().int().min(1).max(7 * 24 * 3600).optional(),
    max_total_cost_usd: usdString.optional(),
    max_value_loss_bps: z.number().int().min(1).max(10_000).optional(),
    require_executable: z.boolean().optional(),
    include_review: z.boolean().optional(),
  })
  .strict();

export const QuoteRequestSchema = z
  .object({
    source_chain: chainRef,
    destination_chain: chainRef,
    source_token: z.string().min(1).max(64),
    destination_token: z.string().min(1).max(64),
    amount: uintString,
    sender: address.optional(),
    recipient: address.optional(),
    constraints: ConstraintsSchema.optional(),
    selection_policy: z.enum(SELECTION_POLICIES).optional(),
    providers: z.array(z.string().min(1).max(32)).min(1).max(10).optional(),
    max_alternatives: z.number().int().min(0).max(5).optional(),
  })
  .strict();

export type QuoteRequestInput = z.infer<typeof QuoteRequestSchema>;
export type Constraints = z.infer<typeof ConstraintsSchema>;

export const PrepareRequestSchema = QuoteRequestSchema.extend({
  sender: address,
  recipient: address,
  provider: z.string().min(1).max(32),
  /** Output the user accepted from /quote, in destination token base units. */
  accepted_output: uintString,
  /** How much worse the fresh quote may be than accepted_output. */
  max_output_drop_bps: z.number().int().min(0).max(500).optional(),
}).strict();

export type PrepareRequestInput = z.infer<typeof PrepareRequestSchema>;

export const StatusQuerySchema = z
  .object({
    tx_hash: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 32-byte tx hash').optional(),
  })
  .strict();

export function formatZodError(err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: i.path.join('.') || '(root)', message: i.message }));
}
